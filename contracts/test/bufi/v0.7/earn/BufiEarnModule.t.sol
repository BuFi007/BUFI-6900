// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {Test} from "forge-std/src/Test.sol";

import {BufiEarnModule} from "../../../../src/bufi/v0.7/earn/BufiEarnModule.sol";
import {MockMsca, MockUsdc, MockVault} from "./mocks/Mocks.sol";
import {FunctionReference} from "@circle/msca/6900/v0.7/common/Structs.sol";

contract BufiEarnModuleTest is Test {
    BufiEarnModule internal module;
    MockMsca internal account;
    MockUsdc internal usdc;
    MockVault internal vault;

    address internal owner = makeAddr("owner");
    address internal relayer = makeAddr("relayer");
    address internal stranger = makeAddr("stranger");

    uint256 internal configHash;

    uint256 internal constant TREASURY_BALANCE = 1_000_000e6;

    function setUp() public {
        usdc = new MockUsdc();
        vault = new MockVault(usdc);
        module = new BufiEarnModule(owner);
        account = new MockMsca();

        BufiEarnModule.ConfigInput[] memory configs = new BufiEarnModule.ConfigInput[](1);
        configs[0] = BufiEarnModule.ConfigInput({chainId: block.chainid, token: address(usdc), vault: address(vault)});
        vm.prank(owner);
        configHash = module.setConfig(configs);

        account.installPlugin(address(module), module.manifestHash(), abi.encode(configHash, relayer), _ownerDeps());

        usdc.mint(address(account), TREASURY_BALANCE);
    }

    /// @dev The two owner-validation slots changeConfigHash depends on. The mock only checks the
    /// count; on a real weighted account these are (weighted, 1) and (weighted, 0).
    function _ownerDeps() internal returns (FunctionReference[] memory deps) {
        deps = new FunctionReference[](2);
        deps[0] = FunctionReference(makeAddr("owner-plugin"), 1);
        deps[1] = FunctionReference(makeAddr("owner-plugin"), 0);
    }

    function test_relayerAutoEarnDepositsIntoVault() public {
        uint256 amount = 250_000e6;

        vm.prank(relayer);
        BufiEarnModule(address(account)).autoEarn(address(usdc), amount);

        assertEq(usdc.balanceOf(address(account)), TREASURY_BALANCE - amount);
        assertEq(vault.balanceOf(address(account)), vault.convertToShares(amount));
        assertEq(usdc.balanceOf(address(vault)), amount);
        // shares mint to the account itself — never to relayer or module
        assertEq(vault.balanceOf(relayer), 0);
        assertEq(vault.balanceOf(address(module)), 0);
    }

    /// Plan 398: the owner (the chain's Safe in production) is governance, not an
    /// operational key. It is NOT implicitly a relayer.
    function test_ownerCannotTriggerAutoEarn() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(BufiEarnModule.NotAuthorized.selector, owner));
        BufiEarnModule(address(account)).autoEarn(address(usdc), 1e6);
        assertEq(vault.balanceOf(address(account)), 0);
    }

    function test_constructorRefusesZeroOwner() public {
        vm.expectRevert(abi.encodeWithSignature("OwnableInvalidOwner(address)", address(0)));
        new BufiEarnModule(address(0));
    }

    // ── per-account relayer (plan 398, founder 2026-10-08)
    // ─────────────────────────────────────────────

    function _secondAccount(address relayerB) internal returns (MockMsca b) {
        b = new MockMsca();
        b.installPlugin(address(module), module.manifestHash(), abi.encode(configHash, relayerB), _ownerDeps());
        usdc.mint(address(b), TREASURY_BALANCE);
    }

    function test_installRecordsTheAccountsOwnRelayer() public view {
        assertEq(module.relayerOf(address(account)), relayer);
    }

    function test_eachRelayerActsOnlyOnTheAccountThatNamedIt() public {
        address relayerB = makeAddr("relayer-b");
        MockMsca b = _secondAccount(relayerB);
        assertEq(module.relayerOf(address(b)), relayerB);

        // A on 1: ok
        vm.prank(relayer);
        BufiEarnModule(address(account)).autoEarn(address(usdc), 1e6);
        assertEq(vault.balanceOf(address(account)), vault.convertToShares(1e6));

        // A on 2: refused
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(BufiEarnModule.NotAuthorized.selector, relayer));
        BufiEarnModule(address(b)).autoEarn(address(usdc), 1e6);

        // B on 1: refused
        vm.prank(relayerB);
        vm.expectRevert(abi.encodeWithSelector(BufiEarnModule.NotAuthorized.selector, relayerB));
        BufiEarnModule(address(account)).autoEarn(address(usdc), 1e6);

        // B on 2: ok
        vm.prank(relayerB);
        BufiEarnModule(address(b)).autoEarn(address(usdc), 2e6);
        assertEq(vault.balanceOf(address(b)), vault.convertToShares(2e6));
        assertEq(vault.balanceOf(address(account)), vault.convertToShares(1e6), "account 1 untouched by B");
    }

    /// The validation function itself keys on msg.sender (the account being validated), so asking it about
    /// another account's relayer from this account is refused even with the right sender argument.
    function test_runtimeValidationIsKeyedOnTheCallingAccount() public {
        address relayerB = makeAddr("relayer-b");
        MockMsca b = _secondAccount(relayerB);
        uint8 id = module.FUNCTION_ID_RUNTIME_VALIDATION_RELAYER();
        vm.prank(address(account));
        module.runtimeValidationFunction(id, relayer, 0, "");
        vm.prank(address(account));
        vm.expectRevert(abi.encodeWithSelector(BufiEarnModule.NotAuthorized.selector, relayerB));
        module.runtimeValidationFunction(id, relayerB, 0, "");
        vm.prank(address(b));
        vm.expectRevert(abi.encodeWithSelector(BufiEarnModule.NotAuthorized.selector, relayer));
        module.runtimeValidationFunction(id, relayer, 0, "");
        // an account with no relayer refuses everyone, including the zero address
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(BufiEarnModule.NotAuthorized.selector, address(0)));
        module.runtimeValidationFunction(id, address(0), 0, "");
    }

    function test_installRefusesZeroRelayer() public {
        MockMsca fresh = new MockMsca();
        bytes32 hash = module.manifestHash();
        FunctionReference[] memory deps = _ownerDeps();
        vm.expectRevert(BufiEarnModule.ZeroAddress.selector);
        fresh.installPlugin(address(module), hash, abi.encode(configHash, address(0)), deps);
    }

    /// The pre-398 install shape (configHash alone) must not install with an implicit relayer.
    function test_installRefusesTheOldConfigHashOnlyShape() public {
        MockMsca fresh = new MockMsca();
        bytes32 hash = module.manifestHash();
        FunctionReference[] memory deps = _ownerDeps();
        vm.expectRevert();
        fresh.installPlugin(address(module), hash, abi.encode(configHash), deps);
        assertFalse(module.isInitialized(address(fresh)));
    }

    function test_setRelayerOnlyByTheAccountItself() public {
        address next = makeAddr("next-relayer");
        // the account (its own validation passed — the multisig IRL) rotates its relayer
        vm.expectEmit(true, true, false, false, address(module));
        emit BufiEarnModule.RelayerSet(address(account), next);
        account.callPlugin(abi.encodeCall(BufiEarnModule.setRelayer, (next)));
        assertEq(module.relayerOf(address(account)), next);

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(BufiEarnModule.NotAuthorized.selector, relayer));
        BufiEarnModule(address(account)).autoEarn(address(usdc), 1e6);
        vm.prank(next);
        BufiEarnModule(address(account)).autoEarn(address(usdc), 1e6);
    }

    function test_setRelayerRuntimeCallThroughTheAccountIsFailClosed() public {
        // neither the current relayer nor the module owner can rotate it at runtime
        address[2] memory callers = [relayer, owner];
        for (uint256 i = 0; i < 2; i++) {
            vm.prank(callers[i]);
            vm.expectRevert(
                abi.encodeWithSelector(
                    MockMsca.RuntimeValidationFailClosed.selector, BufiEarnModule.setRelayer.selector
                )
            );
            BufiEarnModule(address(account)).setRelayer(callers[i]);
        }
        assertEq(module.relayerOf(address(account)), relayer);
    }

    /// A direct call to the module only ever writes the CALLER's slot, and an uninstalled caller has none.
    function test_directSetRelayerCannotTouchAnotherAccount() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(BufiEarnModule.ModuleNotInitialized.selector, owner));
        module.setRelayer(owner);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(BufiEarnModule.ModuleNotInitialized.selector, stranger));
        module.setRelayer(stranger);
        assertEq(module.relayerOf(address(account)), relayer);
    }

    function test_setRelayerRefusesZero() public {
        vm.expectRevert(BufiEarnModule.ZeroAddress.selector);
        account.callPlugin(abi.encodeCall(BufiEarnModule.setRelayer, (address(0))));
        assertEq(module.relayerOf(address(account)), relayer);
    }

    function test_uninstallClearsTheRelayer_andReinstallNamesAFreshOne() public {
        account.uninstallPlugin("");
        assertEq(module.relayerOf(address(account)), address(0));
        address next = makeAddr("next-relayer");
        account.installPlugin(address(module), module.manifestHash(), abi.encode(configHash, next), _ownerDeps());
        assertEq(module.relayerOf(address(account)), next);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(BufiEarnModule.NotAuthorized.selector, relayer));
        BufiEarnModule(address(account)).autoEarn(address(usdc), 1e6);
    }

    /// The global relayer registry is gone: no constructor arg, no add/remove, no set getter.
    function test_globalRelayerFunctionsAreGone() public {
        bytes[3] memory calls = [
            abi.encodeWithSignature("addAuthorizedRelayer(address)", stranger),
            abi.encodeWithSignature("removeAuthorizedRelayer(address)", relayer),
            abi.encodeWithSignature("authorizedRelayers(address)", relayer)
        ];
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(owner);
            (bool ok,) = address(module).call(calls[i]);
            assertFalse(ok, "removed function still answers");
        }
    }

    function test_renounceOwnershipStillReverts() public {
        vm.prank(owner);
        vm.expectRevert(BufiEarnModule.RenounceDisabled.selector);
        module.renounceOwnership();
        assertEq(module.owner(), owner);
    }

    function test_ownershipIsTwoStep() public {
        address safe = makeAddr("safe");
        vm.prank(owner);
        module.transferOwnership(safe);
        // nothing moved yet: the old owner still governs, the Safe is only pending
        assertEq(module.owner(), owner);
        assertEq(module.pendingOwner(), safe);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", stranger));
        module.acceptOwnership();

        vm.prank(safe);
        module.acceptOwnership();
        assertEq(module.owner(), safe);
        assertEq(module.pendingOwner(), address(0));

        BufiEarnModule.ConfigInput[] memory configs = new BufiEarnModule.ConfigInput[](1);
        configs[0] = BufiEarnModule.ConfigInput({chainId: block.chainid, token: address(usdc), vault: address(vault)});
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", owner));
        module.setConfig(configs);
    }

    function test_strangerCannotTriggerAutoEarn() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(BufiEarnModule.NotAuthorized.selector, stranger));
        BufiEarnModule(address(account)).autoEarn(address(usdc), 1e6);
    }

    function test_unconfiguredTokenReverts() public {
        MockUsdc other = new MockUsdc();
        other.mint(address(account), 1e6);

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(BufiEarnModule.ConfigNotFound.selector, address(other)));
        BufiEarnModule(address(account)).autoEarn(address(other), 1e6);
    }

    function test_directPluginCallFromUninitializedAccountReverts() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(BufiEarnModule.ModuleNotInitialized.selector, stranger));
        module.autoEarn(address(usdc), 1e6);
    }

    function test_uninstallClearsConfigAndBlocksAutoEarn() public {
        account.uninstallPlugin("");
        assertFalse(module.isInitialized(address(account)));

        // The relayer was cleared with the config, so the account's own validation refuses it first ...
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(BufiEarnModule.NotAuthorized.selector, relayer));
        BufiEarnModule(address(account)).autoEarn(address(usdc), 1e6);
        // ... and the execution function itself still refuses an uninitialized account.
        vm.prank(address(account));
        vm.expectRevert(abi.encodeWithSelector(BufiEarnModule.ModuleNotInitialized.selector, address(account)));
        module.autoEarn(address(usdc), 1e6);
    }

    function test_installRejectsZeroConfigHash() public {
        MockMsca fresh = new MockMsca();
        bytes32 hash = module.manifestHash();
        FunctionReference[] memory deps = _ownerDeps();
        vm.expectRevert(BufiEarnModule.InvalidConfigHash.selector);
        fresh.installPlugin(address(module), hash, abi.encode(uint256(0), relayer), deps);
    }

    function test_installRequiresTheTwoOwnerDependencySlots() public {
        MockMsca fresh = new MockMsca();
        bytes32 hash = module.manifestHash();
        FunctionReference[] memory none = new FunctionReference[](0);
        vm.expectRevert(abi.encodeWithSelector(MockMsca.DependencyCountMismatch.selector, 2, 0));
        fresh.installPlugin(address(module), hash, abi.encode(configHash, relayer), none);

        assertEq(account.dependencyCount(), 2);
        (, uint8 runtimeId) = account.dependencies(module.OWNER_RUNTIME_VALIDATION_DEPENDENCY_INDEX());
        (, uint8 userOpId) = account.dependencies(module.OWNER_USER_OP_VALIDATION_DEPENDENCY_INDEX());
        assertEq(runtimeId, 1, "slot 0: fail-closed runtime id");
        assertEq(userOpId, 0, "slot 1: owner userOp validation id");
    }

    function test_changeConfigHashRuntimeCallIsFailClosed() public {
        // Dependency-backed runtime validation: neither the relayer nor anyone
        // else can re-point the vault set by calling the account at runtime.
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                MockMsca.RuntimeValidationFailClosed.selector, BufiEarnModule.changeConfigHash.selector
            )
        );
        BufiEarnModule(address(account)).changeConfigHash(configHash + 1);
        assertEq(module.accountConfig(address(account)), configHash);
    }

    function test_installRejectsDoubleInstall() public {
        vm.expectRevert(abi.encodeWithSelector(BufiEarnModule.ModuleAlreadyInitialized.selector, address(account)));
        vm.prank(address(account));
        module.onInstall(abi.encode(configHash, relayer));
    }

    function test_setConfigOnlyOwner() public {
        BufiEarnModule.ConfigInput[] memory configs = new BufiEarnModule.ConfigInput[](1);
        configs[0] = BufiEarnModule.ConfigInput({chainId: block.chainid, token: address(usdc), vault: address(vault)});
        vm.prank(stranger);
        vm.expectRevert();
        module.setConfig(configs);
    }

    function test_accountCanChangeConfigHash() public {
        MockVault newVault = new MockVault(usdc);
        BufiEarnModule.ConfigInput[] memory configs = new BufiEarnModule.ConfigInput[](1);
        configs[0] =
            BufiEarnModule.ConfigInput({chainId: block.chainid, token: address(usdc), vault: address(newVault)});
        vm.prank(owner);
        uint256 newHash = module.setConfig(configs);

        // the account itself adopts the new set (multisig action IRL)
        account.callPlugin(abi.encodeCall(BufiEarnModule.changeConfigHash, (newHash)));
        assertEq(module.accountConfig(address(account)), newHash);

        vm.prank(relayer);
        BufiEarnModule(address(account)).autoEarn(address(usdc), 5e6);
        assertEq(newVault.balanceOf(address(account)), newVault.convertToShares(5e6));
        assertEq(vault.balanceOf(address(account)), 0);
    }

    function test_ownerCannotSilentlyRerouteAdoptedConfig() public {
        // re-registering a different vault under the SAME (chainId, token) list
        // produces a DIFFERENT hash — the account's adopted mapping is untouched
        MockVault evilVault = new MockVault(usdc);
        BufiEarnModule.ConfigInput[] memory configs = new BufiEarnModule.ConfigInput[](1);
        configs[0] =
            BufiEarnModule.ConfigInput({chainId: block.chainid, token: address(usdc), vault: address(evilVault)});
        vm.prank(owner);
        uint256 otherHash = module.setConfig(configs);
        assertTrue(otherHash != configHash);

        vm.prank(relayer);
        BufiEarnModule(address(account)).autoEarn(address(usdc), 1e6);
        assertEq(vault.balanceOf(address(account)), vault.convertToShares(1e6));
        assertEq(evilVault.balanceOf(address(account)), 0);
    }

    function test_getAllConfigsReturnsCurrentChainSet() public view {
        BufiEarnModule.ConfigWithToken[] memory configs = module.getAllConfigs(address(account));
        assertEq(configs.length, 1);
        assertEq(configs[0].token, address(usdc));
        assertEq(configs[0].vault, address(vault));
    }

    function test_manifestHashMatchesManifestEncoding() public view {
        assertEq(module.manifestHash(), keccak256(abi.encode(module.pluginManifest())));
    }

    function test_multiChainConfigSharesOneHash() public {
        // Avalanche (43114) + Arc entries in one set: only the current chain's
        // mapping resolves; the other chain's tokens don't leak in
        // Canonical order is strictly increasing by (chainId, token) — F-08. The local chain (31337) sorts before
        // Avalanche (43114).
        BufiEarnModule.ConfigInput[] memory configs = new BufiEarnModule.ConfigInput[](2);
        configs[0] = BufiEarnModule.ConfigInput({chainId: block.chainid, token: address(usdc), vault: address(vault)});
        configs[1] = BufiEarnModule.ConfigInput({chainId: 43_114, token: address(usdc), vault: address(vault)});
        vm.prank(owner);
        uint256 multiHash = module.setConfig(configs);

        assertEq(module.getTokens(multiHash, 43_114).length, 1);
        assertEq(module.getTokens(multiHash, block.chainid).length, 1);
        assertEq(module.config(multiHash, 43_114, address(usdc)), address(vault));
    }
}
