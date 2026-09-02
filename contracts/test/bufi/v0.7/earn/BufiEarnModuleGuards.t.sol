// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {Test} from "forge-std/src/Test.sol";

import {BufiEarnModule} from "../../../../src/bufi/v0.7/earn/BufiEarnModule.sol";
import {MockMsca, MockUsdc, MockVault} from "./mocks/Mocks.sol";
import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {FunctionReference} from "@circle/msca/6900/v0.7/common/Structs.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev A vault that reports an `asset()` other than the token the account is depositing. The F-06 check rejects
///      it before any transfer, so nothing else needs to work.
contract WrongAssetVault {
    address public immutable asset;

    constructor(address asset_) {
        asset = asset_;
    }

    function balanceOf(address) external pure returns (uint256) {
        return 0;
    }
}

/// @dev A vault whose `asset()` is correct and which DOES mint shares — so `ZeroSharesMinted` cannot fire — but
///      which pulls only half of what it was asked for. This is the case the pre-F-06 module reported as a clean
///      success: shares appeared, the event fired, and the difference stayed silently in the account.
contract ShortDebitVault {
    address public immutable asset;

    mapping(address => uint256) public balanceOf;

    constructor(address asset_) {
        asset = asset_;
    }

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        shares = assets / 2;
        IERC20(asset).transferFrom(msg.sender, address(this), shares);
        balanceOf[receiver] += shares;
    }
}

/// @notice Coverage for `BufiEarnModule`'s guard branches — the F-06 deposit checks above all, plus the
///         configuration guards and the ERC-6900 entry points the module deliberately does not implement.
///         Companion to `BufiEarnModule.t.sol` (happy paths) and `EarnAdversarial.t.sol` (economic attacks).
contract BufiEarnModuleGuardsTest is Test {
    BufiEarnModule internal module;
    MockMsca internal account;
    MockUsdc internal usdc;
    MockVault internal vault;

    address internal owner = makeAddr("owner");
    address internal relayer = makeAddr("relayer");

    uint256 internal configHash;

    uint256 internal constant TREASURY_BALANCE = 1_000_000e6;
    uint256 internal constant MAX_TOKENS = 100;

    function setUp() public {
        usdc = new MockUsdc();
        vault = new MockVault(usdc);
        module = new BufiEarnModule(relayer, owner);
        account = new MockMsca();

        configHash = _register(address(usdc), address(vault));
        account.installPlugin(address(module), module.manifestHash(), abi.encode(configHash), _ownerDeps());
        usdc.mint(address(account), TREASURY_BALANCE);
    }

    // ── configuration guards
    // ────────────────────────────────────────────────────────────────────────────────

    function test_setConfig_revertsOnEmptyList() public {
        BufiEarnModule.ConfigInput[] memory empty = new BufiEarnModule.ConfigInput[](0);
        vm.prank(owner);
        vm.expectRevert(BufiEarnModule.EmptyConfigList.selector);
        module.setConfig(empty);
    }

    /// @dev MAX_TOKENS is a per-(configHash, chainId) cap. The 101st distinct token in one canonical set is the
    ///      first that cannot be listed.
    function test_setConfig_revertsAboveMaxTokens() public {
        uint256 n = MAX_TOKENS + 1;
        BufiEarnModule.ConfigInput[] memory configs = new BufiEarnModule.ConfigInput[](n);
        for (uint256 i = 0; i < n; i++) {
            // strictly increasing by (chainId, token) — the F-08 canonical order
            configs[i] = BufiEarnModule.ConfigInput({
                chainId: block.chainid, token: address(uint160(i + 1)), vault: address(vault)
            });
        }
        vm.prank(owner);
        vm.expectRevert(BufiEarnModule.TooManyTokens.selector);
        module.setConfig(configs);
    }

    function test_setConfig_acceptsExactlyMaxTokens() public {
        BufiEarnModule.ConfigInput[] memory configs = new BufiEarnModule.ConfigInput[](MAX_TOKENS);
        for (uint256 i = 0; i < MAX_TOKENS; i++) {
            configs[i] = BufiEarnModule.ConfigInput({
                chainId: block.chainid, token: address(uint160(i + 1)), vault: address(vault)
            });
        }
        vm.prank(owner);
        uint256 hash_ = module.setConfig(configs);
        assertEq(module.getTokens(hash_, block.chainid).length, MAX_TOKENS);
    }

    /// @dev `changeConfigHash` reads `msg.sender` as the account, so an address that never installed the module
    ///      has no adopted config and must be rejected rather than silently given one.
    function test_changeConfigHash_revertsWhenAccountNotInitialized() public {
        address neverInstalled = makeAddr("never-installed");
        vm.prank(neverInstalled);
        vm.expectRevert(abi.encodeWithSelector(BufiEarnModule.ModuleNotInitialized.selector, neverInstalled));
        module.changeConfigHash(configHash);
    }

    function test_getAllConfigs_isEmptyForUnadoptedAccount() public {
        assertEq(module.getAllConfigs(makeAddr("stranger")).length, 0);
    }

    function test_getAllConfigs_returnsTheAdoptedSet() public view {
        BufiEarnModule.ConfigWithToken[] memory all = module.getAllConfigs(address(account));
        assertEq(all.length, 1);
        assertEq(all[0].token, address(usdc));
        assertEq(all[0].vault, address(vault));
    }

    // ── F-06: the deposit leg is bounded on both sides
    // ──────────────────────────────────────────────────────

    /// @dev Adoption authorises a DESTINATION. A vault that turns out to hold a different asset is not that
    ///      destination, and the module must refuse before it approves anything.
    function test_autoEarn_revertsWhenVaultAssetDoesNotMatchToken() public {
        address otherAsset = makeAddr("some-other-erc20");
        WrongAssetVault bad = new WrongAssetVault(otherAsset);
        (MockMsca acct,) = _accountAdopting(address(usdc), address(bad));

        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(BufiEarnModule.VaultAssetMismatch.selector, address(bad), address(usdc), otherAsset)
        );
        BufiEarnModule(address(acct)).autoEarn(address(usdc), 1_000e6);
    }

    /// @dev The case the pre-F-06 module called a success: shares ARE minted, so `ZeroSharesMinted` never fires,
    ///      but the vault debited less than it was asked for.
    function test_autoEarn_revertsWhenVaultDebitsADifferentAmount() public {
        ShortDebitVault bad = new ShortDebitVault(address(usdc));
        (MockMsca acct,) = _accountAdopting(address(usdc), address(bad));
        usdc.mint(address(acct), TREASURY_BALANCE);

        uint256 amount = 1_000e6;
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(BufiEarnModule.UnexpectedAssetDelta.selector, address(bad), amount, amount / 2)
        );
        BufiEarnModule(address(acct)).autoEarn(address(usdc), amount);
    }

    /// @dev And the same vault is a clean success once the amount it debits matches: the guard rejects the
    ///      mismatch, not the vault.
    function test_autoEarn_shortDebitVaultSucceedsWhenTheDeltaMatches() public {
        ShortDebitVault half = new ShortDebitVault(address(usdc));
        (MockMsca acct,) = _accountAdopting(address(usdc), address(half));
        usdc.mint(address(acct), TREASURY_BALANCE);

        // The vault always pulls half, so no amount satisfies `tokenSpent == amountToSave` except zero — and zero
        // mints zero shares, which the earlier guard catches first. Both guards are live and ordered.
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(BufiEarnModule.ZeroSharesMinted.selector, address(half)));
        BufiEarnModule(address(acct)).autoEarn(address(usdc), 0);
    }

    // ── ERC-6900 entry points this module does not implement
    // ────────────────────────────────────────────────

    function test_runtimeValidation_revertsOnUnknownFunctionId() public {
        uint8 unknownId = 200;
        vm.expectRevert(abi.encodeWithSelector(BufiEarnModule.InvalidFunctionId.selector, unknownId));
        module.runtimeValidationFunction(unknownId, relayer, 0, "");
    }

    /// @dev The module provides exactly one validation function (relayer runtime validation). Every other
    ///      ERC-6900 entry point must fail closed rather than return a permissive default.
    function test_unimplementedEntryPointsAllRevert() public {
        PackedUserOperation memory op;

        vm.expectRevert(BufiEarnModule.NotImplemented.selector);
        module.preUserOpValidationHook(0, op, bytes32(0));

        vm.expectRevert(BufiEarnModule.NotImplemented.selector);
        module.userOpValidationFunction(0, op, bytes32(0));

        vm.expectRevert(BufiEarnModule.NotImplemented.selector);
        module.preRuntimeValidationHook(0, relayer, 0, "");

        vm.expectRevert(BufiEarnModule.NotImplemented.selector);
        module.preExecutionHook(0, relayer, 0, "");

        vm.expectRevert(BufiEarnModule.NotImplemented.selector);
        module.postExecutionHook(0, "");
    }

    function test_pluginMetadataDescribesBothSelectors() public view {
        assertEq(module.pluginMetadata().permissionDescriptors.length, 2);
        assertEq(module.pluginMetadata().permissionDescriptors[0].functionSelector, module.autoEarn.selector);
        assertEq(module.pluginMetadata().permissionDescriptors[1].functionSelector, module.changeConfigHash.selector);
        assertEq(module.pluginMetadata().author, "BUFI");
    }

    function test_manifestHashMatchesTheManifest() public view {
        assertEq(module.manifestHash(), keccak256(abi.encode(module.pluginManifest())));
    }

    // ── helpers
    // ─────────────────────────────────────────────────────────────────────────────────────────────

    function _register(address token, address vault_) internal returns (uint256) {
        BufiEarnModule.ConfigInput[] memory configs = new BufiEarnModule.ConfigInput[](1);
        configs[0] = BufiEarnModule.ConfigInput({chainId: block.chainid, token: token, vault: vault_});
        vm.prank(owner);
        return module.setConfig(configs);
    }

    function _accountAdopting(address token, address vault_) internal returns (MockMsca acct, uint256 hash_) {
        hash_ = _register(token, vault_);
        acct = new MockMsca();
        acct.installPlugin(address(module), module.manifestHash(), abi.encode(hash_), _ownerDeps());
    }

    function _ownerDeps() internal returns (FunctionReference[] memory deps) {
        deps = new FunctionReference[](2);
        deps[0] = FunctionReference(makeAddr("owner-plugin"), 1);
        deps[1] = FunctionReference(makeAddr("owner-plugin"), 0);
    }
}
