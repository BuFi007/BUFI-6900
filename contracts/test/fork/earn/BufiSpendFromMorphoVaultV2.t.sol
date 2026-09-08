// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {SessionKeyHarness} from "../../harness/SessionKeyHarness.sol";

import {BufiEarnModule} from "../../../src/bufi/v0.7/earn/BufiEarnModule.sol";
import {
    BufiSessionRecipientHookPlugin
} from "../../../src/bufi/v0.7/recipient-hook/BufiSessionRecipientHookPlugin.sol";

import {UpgradableMSCA} from "@circle/msca/6900/v0.7/account/UpgradableMSCA.sol";
import {FunctionReference} from "@circle/msca/6900/v0.7/common/Structs.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice FORK test (Base mainnet): the full round trip on live infrastructure — a Circle MSCA sweeps its idle
///         USDC into a live **Morpho Vault V2** ("Gauntlet USDC Prime") with `BufiEarnModule`, ends with ZERO
///         liquid USDC, and an agent session key then pays a third party straight out of that position in ONE
///         user operation. Circle's production contracts on Base are used unchanged; only the BUFI plugins are
///         deployed. Run:
///           FOUNDRY_PROFILE=fork forge test --fork-url https://mainnet.base.org --fork-block-number 50769826 \
///             --match-path 'test/fork/earn/**' -vv
///
///         This is the FluidKey shape proved end to end. `fluidkey/fluidkey-earn-module` @ `122cde1` has no
///         `withdraw` or `redeem` anywhere in `src/FluidkeyEarnModule.sol` — its whole value surface is wrap,
///         approve and `IERC4626.deposit` — so spending straight from yield happens in the transaction the app
///         builds, not in the module. `BufiEarnModule` inherits that shape; `executeWithSessionKey(Call[], key)`
///         is where BUFI bundles the sourcing leg, with no new on-chain plugin and no change to the agent's
///         policy surface.
///
///         The local proof is `test/bufi/v0.7/session/SpendFromVault.t.sol`; the SDK that builds the call array
///         is `buildSpendFromYieldCalls`, and the grant is `spendFromYieldGrant`.
contract BufiSpendFromMorphoVaultV2ForkTest is SessionKeyHarness {
    address internal constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant GAUNTLET_USDC_PRIME_V2 = 0x050cE30b927Da55177A4914EC73480238BAD56f0;

    uint256 internal constant FUNDED = 100_000e6;
    uint256 internal constant SPEND = 25_000e6;
    uint256 internal constant AGENT_BUDGET = 50_000e6;

    BufiEarnModule internal earn;
    BufiSessionRecipientHookPlugin internal hook;

    UpgradableMSCA internal account;
    Signer[] internal quorum;
    Signer internal agent;

    address internal relayer = makeAddr("bufi-relayer");
    address internal earnOwner = makeAddr("bufi-earn-owner");
    address internal payee = makeAddr("payee");

    /// @dev Circle FiatTokenV2_2 keeps `balanceAndBlacklistStates` at slot 9 (high bit = blacklisted). forge's
    ///      `deal` brute-forces slots through the proxy and can blow up, so write the slot directly.
    function _giveUsdc(address to, uint256 amount) internal {
        vm.store(BASE_USDC, keccak256(abi.encode(to, uint256(9))), bytes32(amount));
    }

    function setUp() public {
        require(block.chainid == 8453, "run with --fork-url <base mainnet rpc>");
        _deployCircleCanonicalStack();
        _deploySessionKeyPlugin();
        earn = new BufiEarnModule(relayer, earnOwner);
        hook = new BufiSessionRecipientHookPlugin();
        agent = _signerFrom("agent");

        Signer[] memory owners = _makeSigners("treasury", 3);
        account = _createWeightedMsca(owners, _uniformWeights(3, 1), 2, bytes32(uint256(71)));
        quorum.push(owners[0]);
        quorum.push(owners[1]);

        // The AddressBook carries BOTH the payee and the vault: `withdraw(uint256,address,address)` carries no
        // decodable token recipient, so the recipient hook judges that leg by its TARGET.
        address[] memory recipients = new address[](2);
        recipients[0] = payee;
        recipients[1] = GAUNTLET_USDC_PRIME_V2;
        assertTrue(_installAddressBook(account, recipients, quorum), "address book install");
        assertTrue(_installSessionKeyPlugin(account, quorum), "session key plugin install");
        assertTrue(
            _installPlugin(account, address(hook), abi.encode(address(addressBookPlugin)), new FunctionReference[](0), quorum),
            "recipient hook install"
        );

        BufiEarnModule.ConfigInput[] memory cfg = new BufiEarnModule.ConfigInput[](1);
        cfg[0] = BufiEarnModule.ConfigInput({chainId: block.chainid, token: BASE_USDC, vault: GAUNTLET_USDC_PRIME_V2});
        vm.prank(earnOwner);
        uint256 configHash = earn.setConfig(cfg);
        assertTrue(
            _installPlugin(account, address(earn), abi.encode(configHash), _addressBookDependencies(), quorum),
            "earn install"
        );
    }

    /// @dev Sweep everything in, then pay out of the position with nothing liquid left behind.
    function test_agentPaysOutOfALiveMorphoPosition_withZeroLiquidUsdc() public {
        _giveUsdc(address(account), FUNDED);

        // 1. The relayer sweeps the WHOLE balance into the live vault. The treasury is now fully invested.
        vm.prank(relayer);
        BufiEarnModule(address(account)).autoEarn(BASE_USDC, FUNDED);

        assertEq(IERC20(BASE_USDC).balanceOf(address(account)), 0, "treasury is fully invested: zero liquid USDC");
        uint256 sharesAfterSweep = IERC20(GAUNTLET_USDC_PRIME_V2).balanceOf(address(account));
        assertGt(sharesAfterSweep, 0, "position opened");

        // FINDING — the counterpart of the `maxDeposit == 0` quirk already recorded for deposits, and the reason
        // no `maxWithdraw` preflight belongs anywhere in this path: Morpho Vault V2 reports ZERO withdrawable for
        // a holder that demonstrably CAN withdraw (the next step does). A sourcing guard shaped as
        // `require(maxWithdraw(account) >= shortfall)` would reject every single withdrawal from this vault.
        // Same for an SDK that preflights capacity with it. Use the real revert, or `convertToAssets(balanceOf)`.
        assertEq(IERC4626(GAUNTLET_USDC_PRIME_V2).maxWithdraw(address(account)), 0, "V2 maxWithdraw == 0 for a holder");
        emit log_named_uint(
            "convertToAssets(balanceOf): what the position is actually worth",
            IERC4626(GAUNTLET_USDC_PRIME_V2).convertToAssets(sharesAfterSweep)
        );

        // 2. Grant the agent: USDC.transfer under a budget, and the vault as a PLAIN permitted call.
        //    Deliberately NO ERC-20 spend limit on the vault — that flag admits transfer/approve only and would
        //    reject `withdraw` at validation. This mirrors `spendFromYieldGrant`.
        bytes[] memory grant = new bytes[](5);
        grant[0] = _permAddressEntry(BASE_USDC, true, true);
        grant[1] = _permFunctionEntry(BASE_USDC, IERC20.transfer.selector, true);
        grant[2] = _permErc20Limit(BASE_USDC, AGENT_BUDGET, 0);
        grant[3] = _permAddressEntry(GAUNTLET_USDC_PRIME_V2, true, true);
        grant[4] = _permFunctionEntry(GAUNTLET_USDC_PRIME_V2, IERC4626.withdraw.selector, true);
        assertTrue(_addSessionKey(account, agent.addr, bytes32("agent"), grant, quorum), "grant");

        // 3. ONE agent operation: redeem the shortfall, then pay. This is exactly what
        //    `buildSpendFromYieldCalls` emits for a zero balance.
        assertTrue(
            _executeSessionKeyUserOp(
                account,
                _calls(
                    _call(
                        GAUNTLET_USDC_PRIME_V2,
                        0,
                        abi.encodeCall(IERC4626.withdraw, (SPEND, address(account), address(account)))
                    ),
                    _erc20Transfer(BASE_USDC, payee, SPEND)
                ),
                agent
            ),
            "agent op: [vault.withdraw, usdc.transfer]"
        );

        assertEq(IERC20(BASE_USDC).balanceOf(payee), SPEND, "payee paid out of a live Morpho position");
        assertEq(IERC20(BASE_USDC).balanceOf(address(account)), 0, "sourced exactly the shortfall, nothing left idle");

        uint256 sharesBurned = sharesAfterSweep - IERC20(GAUNTLET_USDC_PRIME_V2).balanceOf(address(account));
        assertGt(sharesBurned, 0, "shares burned");
        assertApproxEqRel(
            IERC4626(GAUNTLET_USDC_PRIME_V2).convertToAssets(sharesBurned), SPEND, 5e15, "burned ~ SPEND (0.5%)"
        );
        assertApproxEqRel(
            IERC4626(GAUNTLET_USDC_PRIME_V2).convertToAssets(
                IERC20(GAUNTLET_USDC_PRIME_V2).balanceOf(address(account))
            ),
            FUNDED - SPEND,
            5e15,
            "the remainder keeps earning"
        );
    }

    /// @dev The same op is rejected at VALIDATION when the vault carries an ERC-20 spend limit — the grant-time
    ///      trap, on live infrastructure. `isAllowedERC20Function` is `transfer || approve` only.
    function test_vaultAsErc20SpendLimited_rejectsWithdraw_onLiveVault() public {
        _giveUsdc(address(account), FUNDED);
        vm.prank(relayer);
        BufiEarnModule(address(account)).autoEarn(BASE_USDC, FUNDED);

        bytes[] memory grant = new bytes[](6);
        grant[0] = _permAddressEntry(BASE_USDC, true, true);
        grant[1] = _permFunctionEntry(BASE_USDC, IERC20.transfer.selector, true);
        grant[2] = _permErc20Limit(BASE_USDC, AGENT_BUDGET, 0);
        grant[3] = _permAddressEntry(GAUNTLET_USDC_PRIME_V2, true, true);
        grant[4] = _permFunctionEntry(GAUNTLET_USDC_PRIME_V2, IERC4626.withdraw.selector, true);
        grant[5] = _permErc20Limit(GAUNTLET_USDC_PRIME_V2, AGENT_BUDGET, 0); // <-- the mistake
        assertTrue(_addSessionKey(account, agent.addr, bytes32("agent"), grant, quorum), "grant");

        _expectSessionKeyValidationRevert(
            account,
            _calls(
                _call(
                    GAUNTLET_USDC_PRIME_V2,
                    0,
                    abi.encodeCall(IERC4626.withdraw, (SPEND, address(account), address(account)))
                ),
                _erc20Transfer(BASE_USDC, payee, SPEND)
            ),
            agent,
            _aa23PermissionsCheckFailed()
        );
        assertEq(IERC20(BASE_USDC).balanceOf(payee), 0, "rejected at validation, no gas-burning revert");
    }
}
