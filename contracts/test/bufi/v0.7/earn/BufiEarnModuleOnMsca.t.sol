// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {CircleCanonical} from "../../../harness/CircleCanonical.sol";
import {CircleStackHarness} from "../../../harness/CircleStackHarness.sol";
import {MockVault} from "./mocks/Mocks.sol";

import {BufiEarnModule} from "../../../../src/bufi/v0.7/earn/BufiEarnModule.sol";
import {SandboxUSDC} from "../../../../src/sandbox/SandboxUSDC.sol";

import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {InvalidValidationFunctionId, NotImplemented} from "@circle/msca/6900/shared/common/Errors.sol";
import {BaseMSCA} from "@circle/msca/6900/v0.7/account/BaseMSCA.sol";
import {UpgradableMSCA} from "@circle/msca/6900/v0.7/account/UpgradableMSCA.sol";
import {ManifestAssociatedFunctionType, PluginManifest} from "@circle/msca/6900/v0.7/common/PluginManifest.sol";
import {Call, ExecutionFunctionConfig, FunctionReference} from "@circle/msca/6900/v0.7/common/Structs.sol";
import {IAccountLoupe} from "@circle/msca/6900/v0.7/interfaces/IAccountLoupe.sol";
import {IPlugin} from "@circle/msca/6900/v0.7/interfaces/IPlugin.sol";
import {IPluginExecutor} from "@circle/msca/6900/v0.7/interfaces/IPluginExecutor.sol";
import {IPluginManager} from "@circle/msca/6900/v0.7/interfaces/IPluginManager.sol";
import {IStandardExecutor} from "@circle/msca/6900/v0.7/interfaces/IStandardExecutor.sol";
import {PluginExecutor} from "@circle/msca/6900/v0.7/managers/PluginExecutor.sol";
import {PluginManager} from "@circle/msca/6900/v0.7/managers/PluginManager.sol";
import {StandardExecutor} from "@circle/msca/6900/v0.7/managers/StandardExecutor.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Vm} from "forge-std/src/Vm.sol";

/// @notice BufiEarnModule installed on Circle's REAL ERC-6900 v0.7 account (canonical bytecode, canonical
///         addresses, multisig-signed userOps through EntryPoint v0.7) instead of the `MockMsca` its unit
///         suite uses. Covers install/uninstall through the multisig, the relayer runtime path, every
///         rejection the account enforces, multisig adoption of a new config set through the routed
///         `changeConfigHash`, and composition with ColdStorageAddressBookPlugin — whose allowlist does not
///         see plugin-initiated deposits (see `src/bufi/v0.7/earn/EARN-NOTES.md`).
contract BufiEarnModuleOnMscaTest is CircleStackHarness {
    BufiEarnModule internal module;
    SandboxUSDC internal usdc;
    MockVault internal vault;
    UpgradableMSCA internal msca;

    /// 3 treasury owners, weight 1 each, threshold 2.
    Signer[] internal owners;
    /// owners[0] + owners[2] — any 2 of 3.
    Signer[] internal quorum;

    address internal bufiOps = makeAddr("bufi-ops");
    address internal relayer = makeAddr("shiva-relayer");
    address internal stranger = makeAddr("stranger");

    uint256 internal configHash;
    uint256 internal constant TREASURY_BALANCE = 1_000_000e6;

    function setUp() public {
        _deployCircleCanonicalStack();

        usdc = new SandboxUSDC();
        vault = new MockVault(IERC20(address(usdc)));
        module = new BufiEarnModule(relayer, bufiOps);
        vm.label(address(module), "BufiEarnModule");
        vm.label(address(vault), "vault");

        Signer[] memory made = _makeSigners("treasury", 3);
        for (uint256 i = 0; i < made.length; i++) {
            owners.push(made[i]);
        }
        quorum.push(owners[0]);
        quorum.push(owners[2]);
        msca = _createWeightedMsca(made, _uniformWeights(3, 1), 2, bytes32(uint256(0xEA)));

        configHash = _registerConfig(address(vault));
        usdc.mint(address(msca), TREASURY_BALANCE);
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Manifest + install                                                             ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    /// The manifest facts every integrator must know before calling installPlugin.
    function test_manifest_declaresTwoExecutionFunctionsAndTwoOwnerDependencySlots() public view {
        PluginManifest memory m = module.pluginManifest();

        assertEq(m.executionFunctions.length, 2, "autoEarn + changeConfigHash");
        assertEq(m.executionFunctions[0], BufiEarnModule.autoEarn.selector);
        assertEq(m.executionFunctions[1], BufiEarnModule.changeConfigHash.selector);

        assertEq(m.dependencyInterfaceIds.length, 2, "install with TWO dependency slots");
        assertEq(m.dependencyInterfaceIds[0], type(IPlugin).interfaceId);
        assertEq(m.dependencyInterfaceIds[1], type(IPlugin).interfaceId);
        assertEq(module.OWNER_RUNTIME_VALIDATION_DEPENDENCY_INDEX(), 0);
        assertEq(module.OWNER_USER_OP_VALIDATION_DEPENDENCY_INDEX(), 1);

        assertEq(m.runtimeValidationFunctions.length, 2);
        assertEq(m.runtimeValidationFunctions[0].executionSelector, BufiEarnModule.autoEarn.selector);
        assertTrue(
            m.runtimeValidationFunctions[0].associatedFunction.functionType == ManifestAssociatedFunctionType.SELF,
            "autoEarn: SELF runtime validation (relayer check)"
        );
        assertEq(m.runtimeValidationFunctions[0].associatedFunction.functionId, 0);
        assertEq(m.runtimeValidationFunctions[1].executionSelector, BufiEarnModule.changeConfigHash.selector);
        assertTrue(
            m.runtimeValidationFunctions[1].associatedFunction.functionType
                == ManifestAssociatedFunctionType.DEPENDENCY,
            "changeConfigHash: runtime validation -> dependency slot 0"
        );
        assertEq(m.runtimeValidationFunctions[1].associatedFunction.dependencyIndex, 0);

        assertEq(m.userOpValidationFunctions.length, 1, "only changeConfigHash has a userOp path");
        assertEq(m.userOpValidationFunctions[0].executionSelector, BufiEarnModule.changeConfigHash.selector);
        assertTrue(
            m.userOpValidationFunctions[0].associatedFunction.functionType == ManifestAssociatedFunctionType.DEPENDENCY,
            "changeConfigHash: userOp validation -> dependency slot 1"
        );
        assertEq(m.userOpValidationFunctions[0].associatedFunction.dependencyIndex, 1);

        assertTrue(m.permitAnyExternalAddress, "vault targets are config-driven");
        assertFalse(m.canSpendNativeToken);
        assertEq(m.interfaceIds.length, 0);
        assertEq(m.permittedExecutionSelectors.length, 0);
        assertEq(m.permittedExternalCalls.length, 0);
        assertEq(m.executionHooks.length, 0);
        assertEq(m.preUserOpValidationHooks.length, 0);
        assertEq(m.preRuntimeValidationHooks.length, 0);
    }

    function test_install_throughMultisigUserOp_withOwnerDependencies_bindsBothFunctions() public {
        bytes32 expectedHash = keccak256(abi.encode(module.pluginManifest()));
        assertEq(module.manifestHash(), expectedHash, "manifestHash() == keccak256(abi.encode(manifest))");
        FunctionReference[] memory deps = _earnDependencies();

        vm.expectEmit(true, false, false, true, address(msca));
        emit IPluginManager.PluginInstalled(address(module), expectedHash, deps);
        assertTrue(_installEarn(configHash), "install userOp executes");

        assertTrue(_isInstalled(msca, address(module)), "getInstalledPlugins lists the module");
        assertTrue(module.isInitialized(address(msca)));
        assertEq(module.accountConfig(address(msca)), configHash, "onInstall adopted the config hash");

        IAccountLoupe loupe = IAccountLoupe(address(msca));
        ExecutionFunctionConfig memory earn = loupe.getExecutionFunctionConfig(BufiEarnModule.autoEarn.selector);
        assertEq(earn.plugin, address(module), "autoEarn routes to the module");
        assertEq(earn.runtimeValidationFunction.plugin, address(module));
        assertEq(earn.runtimeValidationFunction.functionId, module.FUNCTION_ID_RUNTIME_VALIDATION_RELAYER());
        assertEq(earn.userOpValidationFunction.plugin, address(0), "autoEarn: no userOp validation function");

        ExecutionFunctionConfig memory adopt =
            loupe.getExecutionFunctionConfig(BufiEarnModule.changeConfigHash.selector);
        assertEq(adopt.plugin, address(module), "changeConfigHash routes to the module");
        assertEq(adopt.userOpValidationFunction.plugin, address(weightedPlugin), "userOp: weighted owner validation");
        assertEq(adopt.userOpValidationFunction.functionId, CircleCanonical.WEIGHTED_USER_OP_VALIDATION_OWNER);
        assertEq(adopt.runtimeValidationFunction.plugin, address(weightedPlugin), "runtime: weighted, fail-closed id");
        assertEq(adopt.runtimeValidationFunction.functionId, CircleCanonical.WEIGHTED_RUNTIME_DEPENDENCY_FAIL_CLOSED);
    }

    function test_install_rejectsAnEmptyOrShortDependencyArray() public {
        (bool ok, bytes memory reason) = _executeUserOpWithReason(
            _installPluginCalldata(address(module), abi.encode(configHash), new FunctionReference[](0)), quorum
        );
        assertFalse(ok, "empty array: execution phase reverts");
        assertEq(reason, abi.encodeWithSelector(PluginManager.InvalidPluginDependency.selector, address(module)));

        FunctionReference[] memory one = new FunctionReference[](1);
        one[0] = _earnDependencies()[1];
        (ok, reason) =
            _executeUserOpWithReason(_installPluginCalldata(address(module), abi.encode(configHash), one), quorum);
        assertFalse(ok, "one slot: execution phase reverts");
        assertEq(reason, abi.encodeWithSelector(PluginManager.InvalidPluginDependency.selector, address(module)));

        assertFalse(_isInstalled(msca, address(module)));
        assertFalse(module.isInitialized(address(msca)));
    }

    function test_install_rejectsADependencyPluginThatIsNotInstalledOnTheAccount() public {
        FunctionReference[] memory deps = new FunctionReference[](2);
        deps[0] = FunctionReference(address(addressBookPlugin), 1);
        deps[1] = FunctionReference(address(addressBookPlugin), 0);
        (bool ok, bytes memory reason) =
            _executeUserOpWithReason(_installPluginCalldata(address(module), abi.encode(configHash), deps), quorum);
        assertFalse(ok);
        assertEq(
            reason, abi.encodeWithSelector(PluginManager.InvalidPluginDependency.selector, address(addressBookPlugin))
        );
        assertFalse(_isInstalled(msca, address(module)));
    }

    function test_install_rejectsZeroConfigHash_surfacedAsFailToCallOnInstall() public {
        (bool ok, bytes memory reason) = _executeUserOpWithReason(
            _installPluginCalldata(address(module), abi.encode(uint256(0)), _earnDependencies()), quorum
        );
        assertFalse(ok);
        assertEq(
            reason,
            abi.encodeWithSelector(
                PluginManager.FailToCallOnInstall.selector,
                address(module),
                abi.encodeWithSelector(BufiEarnModule.InvalidConfigHash.selector)
            )
        );
        assertFalse(_isInstalled(msca, address(module)));
    }

    function test_installAndUninstall_requireTheMultisigQuorum() public {
        Signer[] memory solo = new Signer[](1);
        solo[0] = owners[1];
        _expectValidationRevert(
            msca, _installPluginCalldata(address(module), abi.encode(configHash), _earnDependencies()), solo
        );
        assertFalse(_isInstalled(msca, address(module)));

        assertTrue(_installEarn(configHash));
        _expectValidationRevert(msca, _uninstallCalldata(), solo);
        assertTrue(_isInstalled(msca, address(module)), "still installed after the under-threshold attempt");
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Relayer runtime path                                                           ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    function test_relayer_autoEarn_depositsThroughExecuteFromPluginExternal_sharesMintToTheAccount() public {
        assertTrue(_installEarn(configHash));
        uint256 amount = 250_000e6;
        uint256 expectedShares = vault.previewDeposit(amount);

        vm.expectEmit(true, true, false, true, address(module));
        emit BufiEarnModule.AutoEarnExecuted(address(msca), address(usdc), amount);
        _autoEarnAs(relayer, address(usdc), amount);

        assertEq(usdc.balanceOf(address(msca)), TREASURY_BALANCE - amount, "USDC left the account");
        assertEq(usdc.balanceOf(address(vault)), amount, "...and reached the vault");
        assertEq(vault.balanceOf(address(msca)), expectedShares, "shares minted to the MSCA");
        assertEq(vault.balanceOf(relayer), 0, "never to the relayer");
        assertEq(vault.balanceOf(address(module)), 0, "never to the module");
        assertEq(usdc.allowance(address(msca), address(vault)), 0, "approval fully consumed by the deposit");
    }

    function test_moduleOwner_canAlsoTriggerAutoEarn() public {
        assertTrue(_installEarn(configHash));
        uint256 expectedShares = vault.previewDeposit(1e6);
        _autoEarnAs(bufiOps, address(usdc), 1e6);
        assertEq(vault.balanceOf(address(msca)), expectedShares);
    }

    function test_unauthorizedCaller_isRejectedByTheAccountsRuntimeValidation() public {
        assertTrue(_installEarn(configHash));

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                BaseMSCA.RuntimeValidationFailed.selector,
                address(module),
                uint8(0),
                abi.encodeWithSelector(BufiEarnModule.NotAuthorized.selector, stranger)
            )
        );
        BufiEarnModule(address(msca)).autoEarn(address(usdc), 1e6);

        assertEq(vault.balanceOf(address(msca)), 0);
        assertEq(usdc.balanceOf(address(msca)), TREASURY_BALANCE);
    }

    function test_removedRelayer_isRejected_andANewRelayerIsAccepted() public {
        assertTrue(_installEarn(configHash));

        vm.prank(bufiOps);
        module.removeAuthorizedRelayer(relayer);
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                BaseMSCA.RuntimeValidationFailed.selector,
                address(module),
                uint8(0),
                abi.encodeWithSelector(BufiEarnModule.NotAuthorized.selector, relayer)
            )
        );
        BufiEarnModule(address(msca)).autoEarn(address(usdc), 1e6);

        address cre = makeAddr("cre-extractor");
        vm.prank(bufiOps);
        module.addAuthorizedRelayer(cre);
        uint256 expectedShares = vault.previewDeposit(2e6);
        _autoEarnAs(cre, address(usdc), 2e6);
        assertEq(vault.balanceOf(address(msca)), expectedShares);
    }

    /// The manifest declares no userOp validation for autoEarn, so even a fully-signed multisig userOp is
    /// rejected by the EntryPoint (AA23: InvalidValidationFunctionId). Relayer runtime calls are the only way in.
    function test_autoEarn_isNotReachableThroughAUserOp_evenWithQuorum() public {
        assertTrue(_installEarn(configHash));
        _expectValidationRevert(msca, abi.encodeCall(BufiEarnModule.autoEarn, (address(usdc), 1e6)), quorum);
        assertEq(vault.balanceOf(address(msca)), 0);
    }

    function test_tokenWithoutAnAdoptedConfig_isRejected() public {
        assertTrue(_installEarn(configHash));
        SandboxUSDC other = new SandboxUSDC();
        other.mint(address(msca), 5e6);

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(BufiEarnModule.ConfigNotFound.selector, address(other)));
        BufiEarnModule(address(msca)).autoEarn(address(other), 5e6);

        assertEq(other.balanceOf(address(msca)), 5e6);
    }

    function test_ownerReregisteringADifferentVault_yieldsANewHash_theAccountKeepsItsAdoptedOne() public {
        assertTrue(_installEarn(configHash));
        MockVault evilVault = new MockVault(IERC20(address(usdc)));
        uint256 otherHash = _registerConfig(address(evilVault));
        assertTrue(otherHash != configHash, "content-addressed: a different vault is a different hash");
        assertEq(module.accountConfig(address(msca)), configHash, "adopted hash untouched");

        uint256 expectedShares = vault.previewDeposit(10e6);
        _autoEarnAs(relayer, address(usdc), 10e6);
        assertEq(vault.balanceOf(address(msca)), expectedShares, "funds went to the adopted vault");
        assertEq(evilVault.balanceOf(address(msca)), 0, "nothing reached the re-registered one");
        assertEq(usdc.balanceOf(address(evilVault)), 0);
    }

    function test_executeFromPluginExternal_refusesAnyCallerThatIsNotAnInstalledPlugin() public {
        assertTrue(_installEarn(configHash));
        bytes memory transferOut = abi.encodeCall(IERC20.transfer, (stranger, 1e6));

        BufiEarnModule impostor = new BufiEarnModule(relayer, bufiOps);
        vm.prank(address(impostor));
        vm.expectRevert(
            abi.encodeWithSelector(
                PluginExecutor.ExecFromPluginToSelectorNotPermitted.selector,
                address(impostor),
                IERC20.transfer.selector
            )
        );
        IPluginExecutor(address(msca)).executeFromPluginExternal(address(usdc), 0, transferOut);

        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                PluginExecutor.ExecFromPluginToSelectorNotPermitted.selector, relayer, IERC20.transfer.selector
            )
        );
        IPluginExecutor(address(msca)).executeFromPluginExternal(address(usdc), 0, transferOut);

        assertEq(usdc.balanceOf(stranger), 0);
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Config adoption on a real account                                              ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    /// `changeConfigHash` is an execution function routed through the account with AddressBook-style owner
    /// validation: a threshold-signed userOp on the ACCOUNT is the one door. Runtime callers of any kind hit
    /// the fail-closed dependency slot, a single owner is below threshold, and the old `execute(plugin, ...)`
    /// path is still refused by the executor.
    function test_quorumAdoptsNewConfigHash_viaUserOp() public {
        assertTrue(_installEarn(configHash));
        uint256 firstShares = vault.previewDeposit(100e6);
        _autoEarnAs(relayer, address(usdc), 100e6);
        assertEq(vault.balanceOf(address(msca)), firstShares, "vault A works before the switch");

        MockVault vaultB = new MockVault(IERC20(address(usdc)));
        uint256 newHash = _registerConfig(address(vaultB));
        bytes memory adopt = abi.encodeCall(BufiEarnModule.changeConfigHash, (newHash));

        // (a) A single owner is below threshold: rejected at the EntryPoint.
        Signer[] memory solo = new Signer[](1);
        solo[0] = owners[1];
        _expectValidationRevert(msca, adopt, solo);

        // (b) Runtime calls hit the fail-closed dependency slot (weighted id 1 is unimplemented): an owner EOA,
        //     the relayer and a stranger are all refused the same way.
        bytes memory failClosed = abi.encodeWithSelector(
            BaseMSCA.RuntimeValidationFailed.selector,
            address(weightedPlugin),
            CircleCanonical.WEIGHTED_RUNTIME_DEPENDENCY_FAIL_CLOSED,
            abi.encodeWithSelector(
                NotImplemented.selector,
                IPlugin.runtimeValidationFunction.selector,
                CircleCanonical.WEIGHTED_RUNTIME_DEPENDENCY_FAIL_CLOSED
            )
        );
        vm.prank(owners[0].addr);
        vm.expectRevert(failClosed);
        BufiEarnModule(address(msca)).changeConfigHash(newHash);
        vm.prank(relayer);
        vm.expectRevert(failClosed);
        BufiEarnModule(address(msca)).changeConfigHash(newHash);
        vm.prank(stranger);
        vm.expectRevert(failClosed);
        BufiEarnModule(address(msca)).changeConfigHash(newHash);

        // (c) execute(plugin, ...) is still not a door: the executor refuses plugin targets.
        (bool ok, bytes memory reason) = _executeUserOpWithReason(_executeCalldata(address(module), 0, adopt), quorum);
        assertFalse(ok);
        assertEq(reason, abi.encodeWithSelector(StandardExecutor.TargetIsPlugin.selector, address(module)));
        assertEq(module.accountConfig(address(msca)), configHash, "nothing above changed the adopted hash");

        // (d) The quorum's userOp on the ACCOUNT adopts the new set.
        vm.expectEmit(true, false, false, true, address(module));
        emit BufiEarnModule.ConfigHashChanged(address(msca), configHash, newHash);
        assertTrue(_executeUserOp(msca, adopt, quorum), "changeConfigHash userOp executes");
        assertEq(module.accountConfig(address(msca)), newHash);
        BufiEarnModule.ConfigWithToken[] memory cfg = module.getAllConfigs(address(msca));
        assertEq(cfg.length, 1);
        assertEq(cfg[0].vault, address(vaultB));

        // (e) Deposits now land in vault B; the vault A position is untouched.
        uint256 secondShares = vaultB.previewDeposit(50e6);
        _autoEarnAs(relayer, address(usdc), 50e6);
        assertEq(vaultB.balanceOf(address(msca)), secondShares, "deposit went to vault B");
        assertEq(usdc.balanceOf(address(vaultB)), 50e6);
        assertEq(vault.balanceOf(address(msca)), firstShares, "vault A position untouched");
    }

    function test_changeConfigHash_viaUserOp_rejectsAZeroHash() public {
        assertTrue(_installEarn(configHash));
        (bool ok, bytes memory reason) =
            _executeUserOpWithReason(abi.encodeCall(BufiEarnModule.changeConfigHash, (0)), quorum);
        assertFalse(ok, "execution phase reverts");
        assertEq(reason, abi.encodeWithSelector(BufiEarnModule.InvalidConfigHash.selector));
        assertEq(module.accountConfig(address(msca)), configHash);
    }

    /// Alternative path, still valid: uninstall and reinstall with the new hash (two multisig userOps).
    function test_adoptingANewConfig_alsoWorksAsUninstallThenReinstallWithTheNewHash() public {
        assertTrue(_installEarn(configHash));
        uint256 firstShares = vault.previewDeposit(100e6);
        _autoEarnAs(relayer, address(usdc), 100e6);
        assertEq(vault.balanceOf(address(msca)), firstShares);

        MockVault other = new MockVault(IERC20(address(usdc)));
        uint256 newHash = _registerConfig(address(other));

        assertTrue(_uninstallEarn(), "uninstall userOp");
        assertFalse(module.isInitialized(address(msca)), "onUninstall cleared the adopted hash");
        assertTrue(_installEarn(newHash), "reinstall with the new hash");
        assertEq(module.accountConfig(address(msca)), newHash);

        uint256 secondShares = other.previewDeposit(50e6);
        _autoEarnAs(relayer, address(usdc), 50e6);
        assertEq(other.balanceOf(address(msca)), secondShares, "deposits now go to the new vault");
        assertEq(vault.balanceOf(address(msca)), firstShares, "the old position is untouched");
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Composition with ColdStorageAddressBookPlugin                                  ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    /// AddressBook installs pre-validation hooks on `execute` / `executeBatch` only. The earn deposit runs
    /// through `executeFromPluginExternal`, on which NOTHING is registered, so a vault outside the allowlist
    /// still receives the deposit while the multisig itself could not have sent a single unit there.
    function test_addressBook_doesNotGateThePluginInitiatedDeposit_vaultOutsideAllowlistStillReceives() public {
        assertTrue(_installEarn(configHash));
        address payee = makeAddr("allowlisted-payee");
        address[] memory allowlist = new address[](1);
        allowlist[0] = payee;
        assertTrue(_installAddressBook(msca, allowlist, quorum), "address book install userOp");
        assertTrue(_isInstalled(msca, address(addressBookPlugin)));

        // Structural: hooks exist on `execute`, none on `executeFromPluginExternal`.
        IAccountLoupe loupe = IAccountLoupe(address(msca));
        (FunctionReference[] memory preUo, FunctionReference[] memory preRt) =
            loupe.getPreValidationHooks(IStandardExecutor.execute.selector);
        assertEq(preUo.length, 1, "address book pre-userOp hook on execute");
        assertEq(preRt.length, 1, "address book pre-runtime hook on execute");
        assertEq(preUo[0].plugin, address(addressBookPlugin));
        (preUo, preRt) = loupe.getPreValidationHooks(IPluginExecutor.executeFromPluginExternal.selector);
        assertEq(preUo.length, 0, "nothing on executeFromPluginExternal (pre-userOp)");
        assertEq(preRt.length, 0, "nothing on executeFromPluginExternal (pre-runtime)");
        assertEq(loupe.getExecutionHooks(IPluginExecutor.executeFromPluginExternal.selector).length, 0);
        assertEq(loupe.getExecutionHooks(IStandardExecutor.execute.selector).length, 0, "no exec hooks either");

        // Behavioural: the multisig cannot reach the vault by any `execute` shape ...
        _expectValidationRevert(
            msca, _executeCalldata(address(usdc), 0, abi.encodeCall(IERC20.transfer, (address(vault), 1e6))), quorum
        );
        _expectValidationRevert(
            msca, _executeCalldata(address(usdc), 0, abi.encodeCall(IERC20.approve, (address(vault), 1e6))), quorum
        );
        // (`deposit(uint256,address)` is not a selector the address book can decode a recipient from)
        _expectValidationRevert(
            msca, _executeCalldata(address(vault), 0, abi.encodeCall(IERC4626.deposit, (1e6, address(msca)))), quorum
        );
        assertEq(usdc.balanceOf(address(vault)), 0, "multisig moved nothing");

        // ... while the relayer's plugin-initiated deposit sails through.
        uint256 amount = 100_000e6;
        uint256 expectedShares = vault.previewDeposit(amount);
        _autoEarnAs(relayer, address(usdc), amount);
        assertEq(usdc.balanceOf(address(vault)), amount, "vault outside the allowlist received the deposit");
        assertEq(vault.balanceOf(address(msca)), expectedShares);

        address[] memory onchain = addressBookPlugin.getAllowedRecipients(address(msca));
        assertEq(onchain.length, 1, "allowlist untouched");
        assertEq(onchain[0], payee);
    }

    /// Same account, install order reversed: the address book first, then the earn plugin. The finding does
    /// not depend on install order.
    function test_addressBook_installedFirst_stillDoesNotGateTheDeposit() public {
        address[] memory allowlist = new address[](0);
        assertTrue(_installAddressBook(msca, allowlist, quorum));
        assertTrue(_installEarn(configHash));

        uint256 expectedShares = vault.previewDeposit(1e6);
        _autoEarnAs(relayer, address(usdc), 1e6);
        assertEq(vault.balanceOf(address(msca)), expectedShares, "empty allowlist, deposit still lands");
    }

    /// The address book does not see `changeConfigHash` either (it is not `execute`), so the multisig can
    /// re-point deposits at a vault the allowlist never mentions. The multisig quorum is the whole gate.
    function test_addressBook_doesNotGateChangeConfigHash() public {
        assertTrue(_installEarn(configHash));
        address[] memory allowlist = new address[](0);
        assertTrue(_installAddressBook(msca, allowlist, quorum));

        MockVault vaultB = new MockVault(IERC20(address(usdc)));
        uint256 newHash = _registerConfig(address(vaultB));
        assertTrue(_executeUserOp(msca, abi.encodeCall(BufiEarnModule.changeConfigHash, (newHash)), quorum));
        assertEq(module.accountConfig(address(msca)), newHash);

        uint256 expectedShares = vaultB.previewDeposit(1e6);
        _autoEarnAs(relayer, address(usdc), 1e6);
        assertEq(vaultB.balanceOf(address(msca)), expectedShares);
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Uninstall                                                                      ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    function test_uninstall_throughMultisigUserOp_disablesBothFunctionsAndRemovesItFromTheLoupe() public {
        assertTrue(_installEarn(configHash));

        vm.expectEmit(true, true, false, true, address(msca));
        emit IPluginManager.PluginUninstalled(address(module), true);
        assertTrue(_uninstallEarn(), "uninstall userOp executes");

        assertFalse(_isInstalled(msca, address(module)), "getInstalledPlugins no longer lists it");
        assertFalse(module.isInitialized(address(msca)), "onUninstall cleared the account's config");
        IAccountLoupe loupe = IAccountLoupe(address(msca));
        assertEq(loupe.getExecutionFunctionConfig(BufiEarnModule.autoEarn.selector).plugin, address(0));
        ExecutionFunctionConfig memory adopt =
            loupe.getExecutionFunctionConfig(BufiEarnModule.changeConfigHash.selector);
        assertEq(adopt.plugin, address(0), "changeConfigHash selector unbound");
        assertEq(adopt.userOpValidationFunction.plugin, address(0), "...and its owner validation released");

        // The relayer now hits an empty runtime validation slot before the plugin is even consulted ...
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(InvalidValidationFunctionId.selector, uint8(0)));
        BufiEarnModule(address(msca)).autoEarn(address(usdc), 1e6);
        assertEq(vault.balanceOf(address(msca)), 0);
        // ... and a changeConfigHash userOp has no validation function any more.
        _expectValidationRevert(msca, abi.encodeCall(BufiEarnModule.changeConfigHash, (configHash)), quorum);

        // And the account can install it again — plugin storage and dependency counters were fully released.
        assertTrue(_installEarn(configHash), "reinstall after uninstall");
        assertTrue(_isInstalled(msca, address(module)));
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Helpers                                                                        ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    function _registerConfig(address vault_) internal returns (uint256) {
        BufiEarnModule.ConfigInput[] memory cfg = new BufiEarnModule.ConfigInput[](1);
        cfg[0] = BufiEarnModule.ConfigInput({chainId: block.chainid, token: address(usdc), vault: vault_});
        vm.prank(bufiOps);
        return module.setConfig(cfg);
    }

    /// The production dependency pair on a weighted account — identical to the address book's:
    /// slot 0 (runtime) -> Weighted id 1 (unimplemented, fail-closed), slot 1 (userOp) -> Weighted id 0.
    function _earnDependencies() internal view returns (FunctionReference[] memory) {
        return _addressBookDependencies();
    }

    function _installEarn(uint256 hash) internal returns (bool) {
        return _installPlugin(msca, address(module), abi.encode(hash), _earnDependencies(), quorum);
    }

    function _uninstallCalldata() internal view returns (bytes memory) {
        return abi.encodeCall(IPluginManager.uninstallPlugin, (address(module), "", ""));
    }

    function _uninstallEarn() internal returns (bool) {
        return _executeUserOp(msca, _uninstallCalldata(), quorum);
    }

    function _autoEarnAs(address caller, address token, uint256 amount) internal {
        vm.prank(caller);
        BufiEarnModule(address(msca)).autoEarn(token, amount);
    }

    /// Submits a signed op and returns both the execution-phase outcome and its revert reason. The harness
    /// helpers each consume the recorded logs, so they cannot be combined for a single op.
    function _executeUserOpWithReason(bytes memory callData, Signer[] memory signers)
        internal
        returns (bool success, bytes memory reason)
    {
        PackedUserOperation memory op = _prepareUserOp(msca, callData, signers);
        vm.recordLogs();
        _handleOps(op);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == IEntryPoint.UserOperationEvent.selector) {
                (, success,,) = abi.decode(logs[i].data, (uint256, bool, uint256, uint256));
            } else if (logs[i].topics[0] == IEntryPoint.UserOperationRevertReason.selector) {
                (, reason) = abi.decode(logs[i].data, (uint256, bytes));
            }
        }
    }
}
