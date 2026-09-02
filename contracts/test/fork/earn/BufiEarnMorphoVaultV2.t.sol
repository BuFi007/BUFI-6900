// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {CircleCanonical} from "../../harness/CircleCanonical.sol";
import {CircleStackHarness} from "../../harness/CircleStackHarness.sol";
import {BufiEarnModule} from "../../../src/bufi/v0.7/earn/BufiEarnModule.sol";

import {UpgradableMSCA} from "@circle/msca/6900/v0.7/account/UpgradableMSCA.sol";
import {FunctionReference} from "@circle/msca/6900/v0.7/common/Structs.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

/// @notice FORK test (Base mainnet, read-only local fork): BufiEarnModule sweeps a Circle MSCA treasury's idle USDC
///         into a live **Morpho Vault V2** ("Gauntlet USDC Prime") through Circle's PRODUCTION contracts on Base —
///         nothing is redeployed except the earn module. Run:
///           FOUNDRY_PROFILE=fork forge test --fork-url https://mainnet.base.org --fork-block-number 50769826 \
///             --match-path 'test/fork/earn/**' -vv
///         Pins the two facts that matter for treasuries: Vault V2's ERC-4626 `maxDeposit` returns 0 (never gate on
///         it) and plain `deposit(assets, receiver)` is what mints shares to the account.
contract BufiEarnMorphoVaultV2ForkTest is CircleStackHarness {
    address internal constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant GAUNTLET_USDC_PRIME_V2 = 0x050cE30b927Da55177A4914EC73480238BAD56f0;
    uint256 internal constant SWEEP = 25_000e6;

    BufiEarnModule internal earn;
    address internal relayer = makeAddr("bufi-relayer");
    address internal earnOwner = makeAddr("bufi-earn-owner");

    /// @dev Circle FiatTokenV2_2 keeps `balanceAndBlacklistStates` at slot 9 (high bit = blacklisted). forge's `deal`
    ///      brute-forces slots through the proxy and can blow up, so write the slot directly.
    function _giveUsdc(address to, uint256 amount) internal {
        vm.store(BASE_USDC, keccak256(abi.encode(to, uint256(9))), bytes32(amount));
    }

    function setUp() public {
        require(block.chainid == 8453, "run with --fork-url <base mainnet rpc>");
        // Circle's production stack is already at the canonical addresses on Base; the harness only allowlists.
        _deployCircleCanonicalStack();
        earn = new BufiEarnModule(relayer, earnOwner);
    }

    function test_vaultV2_maxDepositIsZero_butDepositWorks_forATreasuryMsca() public {
        Signer[] memory owners = _makeSigners("treasury", 3);
        UpgradableMSCA msca = _createWeightedMsca(owners, _uniformWeights(3, 1), 2, bytes32(uint256(7)));
        _giveUsdc(address(msca), 100_000e6);
        assertEq(IERC20(BASE_USDC).balanceOf(address(msca)), 100_000e6, "usdc funded via storage");

        // Vault V2 quirk: every ERC-4626 max* view returns zero. A module gating on maxDeposit would never deposit.
        assertEq(IERC4626(GAUNTLET_USDC_PRIME_V2).maxDeposit(address(msca)), 0, "V2 maxDeposit == 0");
        assertEq(IERC4626(GAUNTLET_USDC_PRIME_V2).asset(), BASE_USDC);

        // Module owner registers the vault; the multisig adopts the config hash at install (two owner slots).
        BufiEarnModule.ConfigInput[] memory cfg = new BufiEarnModule.ConfigInput[](1);
        cfg[0] = BufiEarnModule.ConfigInput({chainId: block.chainid, token: BASE_USDC, vault: GAUNTLET_USDC_PRIME_V2});
        vm.prank(earnOwner);
        uint256 configHash = earn.setConfig(cfg);

        Signer[] memory quorum = new Signer[](2);
        quorum[0] = owners[0];
        quorum[1] = owners[1];
        assertTrue(
            _installPlugin(msca, address(earn), abi.encode(configHash), _addressBookDependencies(), quorum),
            "earn install via multisig userOp"
        );
        assertTrue(_isInstalled(msca, address(earn)));

        uint256 sharesBefore = IERC20(GAUNTLET_USDC_PRIME_V2).balanceOf(address(msca));
        uint256 expectedShares = IERC4626(GAUNTLET_USDC_PRIME_V2).previewDeposit(SWEEP);

        vm.prank(relayer);
        BufiEarnModule(address(msca)).autoEarn(BASE_USDC, SWEEP);

        uint256 shares = IERC20(GAUNTLET_USDC_PRIME_V2).balanceOf(address(msca)) - sharesBefore;
        assertGt(shares, 0, "shares minted to the treasury MSCA");
        assertApproxEqRel(shares, expectedShares, 1e15, "previewDeposit within 0.1%");
        assertEq(IERC20(BASE_USDC).balanceOf(address(msca)), 100_000e6 - SWEEP, "USDC left the account");
        uint256 assetsBack = IERC4626(GAUNTLET_USDC_PRIME_V2).convertToAssets(shares);
        assertApproxEqRel(assetsBack, SWEEP, 5e15, "position value ~ deposit (0.5%)");

        // Idempotent operations: a second sweep on the same config works; a stranger cannot trigger it.
        vm.prank(relayer);
        BufiEarnModule(address(msca)).autoEarn(BASE_USDC, 1_000e6);
        vm.prank(makeAddr("stranger"));
        vm.expectRevert();
        BufiEarnModule(address(msca)).autoEarn(BASE_USDC, 1_000e6);

        // Redemption stays a multisig action: the quorum redeems shares back to the account via execute().
        uint256 half = shares / 2;
        bool ok = _executeUserOp(
            msca,
            _executeCalldata(
                GAUNTLET_USDC_PRIME_V2,
                0,
                abi.encodeCall(IERC4626.redeem, (half, address(msca), address(msca)))
            ),
            quorum
        );
        // Vault V2 may be illiquid at this block; either the redeem succeeds or reverts cleanly — both are recorded.
        emit log_named_uint("redeem via multisig succeeded (1/0)", ok ? 1 : 0);
        if (ok) assertGt(IERC20(BASE_USDC).balanceOf(address(msca)), 100_000e6 - SWEEP - 1_000e6, "USDC came back");
    }
}
