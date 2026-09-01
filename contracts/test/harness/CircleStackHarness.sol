// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {CircleCanonical} from "./CircleCanonical.sol";

import {EMPTY_HASH, ZERO_BYTES32} from "@circle/common/Constants.sol";
import {PublicKey} from "@circle/common/CommonStructs.sol";
import {UpgradableMSCA} from "@circle/msca/6900/v0.7/account/UpgradableMSCA.sol";
import {FunctionReference} from "@circle/msca/6900/v0.7/common/Structs.sol";
import {UpgradableMSCAFactory} from "@circle/msca/6900/v0.7/factories/UpgradableMSCAFactory.sol";
import {IAccountLoupe} from "@circle/msca/6900/v0.7/interfaces/IAccountLoupe.sol";
import {IPlugin} from "@circle/msca/6900/v0.7/interfaces/IPlugin.sol";
import {IPluginManager} from "@circle/msca/6900/v0.7/interfaces/IPluginManager.sol";
import {IStandardExecutor} from "@circle/msca/6900/v0.7/interfaces/IStandardExecutor.sol";
import {PluginManager} from "@circle/msca/6900/v0.7/managers/PluginManager.sol";
import {ColdStorageAddressBookPlugin} from
    "@circle/msca/6900/v0.7/plugins/v1_0_0/addressbook/ColdStorageAddressBookPlugin.sol";
import {WeightedWebauthnMultisigPlugin} from
    "@circle/msca/6900/v0.7/plugins/v1_0_0/multisig/WeightedWebauthnMultisigPlugin.sol";
import {TestUtils} from "@circle-test/util/TestUtils.sol";
import {EntryPoint} from "@account-abstraction/contracts/core/EntryPoint.sol";
import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Vm} from "forge-std/src/Vm.sol";

/// @title CircleStackHarness
/// @notice Test base that recreates Circle's production ERC-6900 v0.7 stack at Circle's canonical addresses
///         (byte-identical bytecode, same CREATE2 salts, same constructor args) and offers the multisig-signed
///         userOp helpers every BUFI plugin test needs: create a weighted-multisig MSCA, install plugins with
///         dependency slots, sign with k-of-n EOA owners in the plugin's wire format, and drive the EntryPoint.
///
///         Signature wire format (BaseMultisigPlugin.userOpValidationFunction + checkNSignatures):
///           - k × 65-byte `[r ‖ s ‖ v]` chunks, ordered by ascending owner id (bytes30 of the address);
///           - exactly ONE chunk signs the ACTUAL digest (`v + 32`, i.e. 59/60), all others sign the
///             MINIMAL digest (`v` 27/28) that zeroes the gas fields — this is what lets a bundler re-estimate
///             gas without re-collecting signatures;
///           - both digests are `toEthSignedMessageHash(...)` wrapped.
abstract contract CircleStackHarness is TestUtils {
    using MessageHashUtils for bytes32;

    struct Signer {
        address addr;
        uint256 key;
    }

    IEntryPoint internal entryPoint;
    PluginManager internal pluginManager;
    UpgradableMSCAFactory internal factory;
    WeightedWebauthnMultisigPlugin internal weightedPlugin;
    ColdStorageAddressBookPlugin internal addressBookPlugin;

    address payable internal beneficiary = payable(makeAddr("bundler-beneficiary"));

    uint128 internal constant DEFAULT_VERIFICATION_GAS = 3_000_000;
    uint128 internal constant DEFAULT_CALL_GAS = 3_000_000;
    uint256 internal constant DEFAULT_PRE_VERIFICATION_GAS = 100_000;
    uint128 internal constant DEFAULT_MAX_FEE = 1 gwei;
    uint128 internal constant DEFAULT_MAX_PRIORITY_FEE = 1 gwei;

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Stack deployment — Circle bytecode at Circle addresses                        ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    function _deployCircleCanonicalStack() internal {
        // EntryPoint v0.7 from the pinned eth-infinitism release, placed at the canonical address so that
        // the plugins' hard-coded ENTRYPOINT constant, the SDK's `entryPoint07Address` and the account's
        // immutable all agree.
        if (CircleCanonical.ENTRY_POINT_V07.code.length == 0) {
            deployCodeTo("EntryPoint.sol:EntryPoint", CircleCanonical.ENTRY_POINT_V07);
        }
        entryPoint = IEntryPoint(CircleCanonical.ENTRY_POINT_V07);
        vm.label(CircleCanonical.ENTRY_POINT_V07, "EntryPoint v0.7");

        if (CircleCanonical.CREATE2_DEPLOYER.code.length == 0) {
            vm.etch(CircleCanonical.CREATE2_DEPLOYER, CircleCanonical.CREATE2_DEPLOYER_RUNTIME);
        }
        vm.label(CircleCanonical.CREATE2_DEPLOYER, "CREATE2 deployer");

        _create2Circle(
            "PluginManager.json", CircleCanonical.PLUGIN_MANAGER_SALT, "", CircleCanonical.PLUGIN_MANAGER
        );
        _create2Circle(
            "UpgradableMSCAFactory.json",
            CircleCanonical.UPGRADABLE_MSCA_FACTORY_SALT,
            abi.encode(CircleCanonical.FACTORY_OWNER, CircleCanonical.ENTRY_POINT_V07, CircleCanonical.PLUGIN_MANAGER),
            CircleCanonical.UPGRADABLE_MSCA_FACTORY
        );
        _create2Circle(
            "ColdStorageAddressBookPlugin.json",
            CircleCanonical.COLD_STORAGE_ADDRESS_BOOK_PLUGIN_SALT,
            "",
            CircleCanonical.COLD_STORAGE_ADDRESS_BOOK_PLUGIN
        );
        _create2Circle(
            "WeightedWebauthnMultisigPlugin.json",
            CircleCanonical.WEIGHTED_WEBAUTHN_MULTISIG_PLUGIN_SALT,
            abi.encode(CircleCanonical.ENTRY_POINT_V07),
            CircleCanonical.WEIGHTED_WEBAUTHN_MULTISIG_PLUGIN
        );

        pluginManager = PluginManager(CircleCanonical.PLUGIN_MANAGER);
        factory = UpgradableMSCAFactory(payable(CircleCanonical.UPGRADABLE_MSCA_FACTORY));
        weightedPlugin = WeightedWebauthnMultisigPlugin(CircleCanonical.WEIGHTED_WEBAUTHN_MULTISIG_PLUGIN);
        addressBookPlugin = ColdStorageAddressBookPlugin(CircleCanonical.COLD_STORAGE_ADDRESS_BOOK_PLUGIN);

        vm.label(CircleCanonical.PLUGIN_MANAGER, "PluginManager");
        vm.label(CircleCanonical.UPGRADABLE_MSCA_FACTORY, "UpgradableMSCAFactory");
        vm.label(CircleCanonical.UPGRADABLE_MSCA_IMPL, "UpgradableMSCA (impl)");
        vm.label(CircleCanonical.WEIGHTED_WEBAUTHN_MULTISIG_PLUGIN, "WeightedWebauthnMultisigPlugin");
        vm.label(CircleCanonical.COLD_STORAGE_ADDRESS_BOOK_PLUGIN, "ColdStorageAddressBookPlugin");
        vm.label(CircleCanonical.FACTORY_OWNER, "Circle factory owner");

        // Step 105 of Circle's runbook: the factory owner allowlists the two production plugins.
        address[] memory plugins = new address[](2);
        plugins[0] = CircleCanonical.COLD_STORAGE_ADDRESS_BOOK_PLUGIN;
        plugins[1] = CircleCanonical.WEIGHTED_WEBAUTHN_MULTISIG_PLUGIN;
        _allowPluginsOnFactory(plugins);
    }

    /// @dev Sandbox-only: the factory owner allowlists extra plugins so they can be installed at account
    ///      creation time. Post-creation `installPlugin` needs no allowlist — that is what production BUFI
    ///      wallets rely on — but allowing them here lets tests exercise the init path too.
    function _allowPluginsOnFactory(address[] memory plugins) internal {
        bool[] memory permissions = new bool[](plugins.length);
        for (uint256 i = 0; i < plugins.length; i++) {
            permissions[i] = true;
        }
        vm.prank(CircleCanonical.FACTORY_OWNER);
        factory.setPlugins(plugins, permissions);
    }

    function _create2Circle(string memory artifact, bytes32 salt, bytes memory args, address expected) internal {
        if (expected.code.length != 0) return;
        string memory json = vm.readFile(string.concat(vm.projectRoot(), CircleCanonical.BUILD_OUTPUT_DIR, artifact));
        bytes memory creationCode = abi.decode(vm.parseJson(json, ".bytecode.object"), (bytes));
        (bool ok, bytes memory ret) = CircleCanonical.CREATE2_DEPLOYER.call(abi.encodePacked(salt, creationCode, args));
        require(ok, string.concat("CREATE2 deploy failed: ", artifact));
        address deployed = address(bytes20(ret));
        require(deployed == expected, string.concat("CREATE2 address mismatch: ", artifact));
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Owners / accounts                                                              ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    /// @dev Creates `n` EOA signers sorted ascending by owner id (the order checkNSignatures enforces).
    function _makeSigners(string memory prefix, uint256 n) internal returns (Signer[] memory signers) {
        signers = new Signer[](n);
        for (uint256 i = 0; i < n; i++) {
            (address a, uint256 k) = makeAddrAndKey(string.concat(prefix, "-", vm.toString(i)));
            signers[i] = Signer(a, k);
        }
        _sortSigners(signers);
    }

    function _sortSigners(Signer[] memory signers) internal pure {
        for (uint256 i = 1; i < signers.length; i++) {
            Signer memory s = signers[i];
            uint256 j = i;
            while (j > 0 && uint160(signers[j - 1].addr) > uint160(s.addr)) {
                signers[j] = signers[j - 1];
                j--;
            }
            signers[j] = s;
        }
    }

    function _addresses(Signer[] memory signers) internal pure returns (address[] memory out) {
        out = new address[](signers.length);
        for (uint256 i = 0; i < signers.length; i++) {
            out[i] = signers[i].addr;
        }
    }

    function _uniformWeights(uint256 n, uint256 w) internal pure returns (uint256[] memory out) {
        out = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            out[i] = w;
        }
    }

    function _weightedInstallData(address[] memory owners, uint256[] memory weights, uint256 threshold)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(owners, weights, new PublicKey[](0), new uint256[](0), threshold);
    }

    /// @dev Deploys a weighted-multisig MSCA through the canonical factory exactly like the SDK does:
    ///      one plugin (WeightedWebauthnMultisigPlugin) installed at init with the owner set. Funds it.
    function _createWeightedMsca(Signer[] memory signers, uint256[] memory weights, uint256 threshold, bytes32 salt)
        internal
        returns (UpgradableMSCA msca)
    {
        address[] memory plugins = new address[](1);
        bytes32[] memory manifestHashes = new bytes32[](1);
        bytes[] memory installData = new bytes[](1);
        plugins[0] = address(weightedPlugin);
        manifestHashes[0] = keccak256(abi.encode(weightedPlugin.pluginManifest()));
        installData[0] = _weightedInstallData(_addresses(signers), weights, threshold);
        bytes memory initializingData = abi.encode(plugins, manifestHashes, installData);
        msca = factory.createAccount(addressToBytes32(signers[0].addr), salt, initializingData);
        vm.deal(address(msca), 100 ether);
        vm.label(address(msca), "MSCA");
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  UserOps                                                                        ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    function _buildUserOp(address sender, bytes memory callData)
        internal
        view
        returns (PackedUserOperation memory op)
    {
        op.sender = sender;
        op.nonce = entryPoint.getNonce(sender, 0);
        op.initCode = "";
        op.callData = callData;
        op.accountGasLimits = bytes32(abi.encodePacked(DEFAULT_VERIFICATION_GAS, DEFAULT_CALL_GAS));
        op.preVerificationGas = DEFAULT_PRE_VERIFICATION_GAS;
        op.gasFees = bytes32(abi.encodePacked(DEFAULT_MAX_PRIORITY_FEE, DEFAULT_MAX_FEE));
        op.paymasterAndData = "";
    }

    /// @dev Mirrors BaseMultisigPlugin._getMinimalUserOpDigest: gas fields and paymasterAndData zeroed.
    function _minimalUserOpDigest(PackedUserOperation memory op) internal view returns (bytes32) {
        bytes32 h = keccak256(
            abi.encode(
                op.sender,
                op.nonce,
                keccak256(op.initCode),
                keccak256(op.callData),
                ZERO_BYTES32,
                uint256(0),
                ZERO_BYTES32,
                EMPTY_HASH
            )
        );
        return keccak256(abi.encode(h, CircleCanonical.ENTRY_POINT_V07, block.chainid));
    }

    /// @dev Signs with every provided signer (must be sorted ascending). `signers[0]` signs the actual digest
    ///      (v + 32); the rest sign the minimal digest. Pass exactly the signers you want counted.
    function _signMultisig(PackedUserOperation memory op, Signer[] memory signers)
        internal
        view
        returns (bytes memory sig)
    {
        bytes32 actual = entryPoint.getUserOpHash(op).toEthSignedMessageHash();
        bytes32 minimal = _minimalUserOpDigest(op).toEthSignedMessageHash();
        for (uint256 i = 0; i < signers.length; i++) {
            bytes32 digest = i == 0 ? actual : minimal;
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(signers[i].key, digest);
            if (i == 0) v += 32;
            sig = bytes.concat(sig, abi.encodePacked(r, s, v));
        }
    }

    function _handleOps(PackedUserOperation memory op) internal {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        entryPoint.handleOps(ops, beneficiary);
    }

    /// @dev Build → sign (all `signers`). Submit with `_handleOps` / `_executeSignedUserOp`.
    function _prepareUserOp(UpgradableMSCA msca, bytes memory callData, Signer[] memory signers)
        internal
        view
        returns (PackedUserOperation memory op)
    {
        op = _buildUserOp(address(msca), callData);
        op.signature = _signMultisig(op, signers);
    }

    /// @dev Submits a signed op. Reverts if validation fails (FailedOp / FailedOpWithRevert) and returns
    ///      whether the execution phase succeeded (read from UserOperationEvent).
    function _executeSignedUserOp(PackedUserOperation memory op) internal returns (bool success) {
        vm.recordLogs();
        _handleOps(op);
        success = _lastUserOpSucceeded();
    }

    /// @dev Build → sign (all `signers`) → submit. See `_executeSignedUserOp` for semantics.
    function _executeUserOp(UpgradableMSCA msca, bytes memory callData, Signer[] memory signers)
        internal
        returns (bool success)
    {
        return _executeSignedUserOp(_prepareUserOp(msca, callData, signers));
    }

    /// @dev Asserts the EntryPoint rejects the op during validation (signature below threshold, hook denial,
    ///      expired key …). Use instead of `vm.expectRevert()` + `_executeUserOp`, whose first external call
    ///      is a view read and would swallow the expectation.
    function _expectValidationRevert(UpgradableMSCA msca, bytes memory callData, Signer[] memory signers)
        internal
    {
        PackedUserOperation memory op = _prepareUserOp(msca, callData, signers);
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.expectRevert();
        entryPoint.handleOps(ops, beneficiary);
    }

    function _lastUserOpSucceeded() internal returns (bool success) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic = IEntryPoint.UserOperationEvent.selector;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == topic) {
                (, success,,) = abi.decode(logs[i].data, (uint256, bool, uint256, uint256));
            }
        }
    }

    /// @dev Execution-phase revert reason of the last recorded userOp (empty when it succeeded).
    function _lastUserOpRevertReason() internal returns (bytes memory reason) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic = IEntryPoint.UserOperationRevertReason.selector;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == topic) {
                (, reason) = abi.decode(logs[i].data, (uint256, bytes));
            }
        }
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Plugin install helpers                                                         ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    function _installPluginCalldata(
        address plugin,
        bytes memory installData,
        FunctionReference[] memory dependencies
    ) internal view returns (bytes memory) {
        bytes32 manifestHash = keccak256(abi.encode(IPlugin(plugin).pluginManifest()));
        return abi.encodeCall(IPluginManager.installPlugin, (plugin, manifestHash, installData, dependencies));
    }

    /// @dev Installs a plugin through a multisig-signed userOp (the only path production wallets use).
    function _installPlugin(
        UpgradableMSCA msca,
        address plugin,
        bytes memory installData,
        FunctionReference[] memory dependencies,
        Signer[] memory signers
    ) internal returns (bool) {
        return _executeUserOp(msca, _installPluginCalldata(plugin, installData, dependencies), signers);
    }

    /// @dev The production dependency-slot arrangement for ColdStorageAddressBookPlugin on a weighted
    ///      multisig account (desk-v1 `getAddressBookDependencies`): slot 0 (runtime validation) → the
    ///      deliberately unimplemented Weighted function id 1 (fail-closed), slot 1 (userOp validation) →
    ///      Weighted owner validation id 0.
    function _addressBookDependencies() internal view returns (FunctionReference[] memory deps) {
        deps = new FunctionReference[](2);
        deps[0] = FunctionReference(address(weightedPlugin), CircleCanonical.WEIGHTED_RUNTIME_DEPENDENCY_FAIL_CLOSED);
        deps[1] = FunctionReference(address(weightedPlugin), CircleCanonical.WEIGHTED_USER_OP_VALIDATION_OWNER);
    }

    function _installAddressBook(UpgradableMSCA msca, address[] memory recipients, Signer[] memory signers)
        internal
        returns (bool)
    {
        return _installPlugin(msca, address(addressBookPlugin), abi.encode(recipients), _addressBookDependencies(), signers);
    }

    function _executeCalldata(address target, uint256 value, bytes memory data) internal pure returns (bytes memory) {
        return abi.encodeCall(IStandardExecutor.execute, (target, value, data));
    }

    function _installedPlugins(UpgradableMSCA msca) internal view returns (address[] memory) {
        return IAccountLoupe(address(msca)).getInstalledPlugins();
    }

    function _isInstalled(UpgradableMSCA msca, address plugin) internal view returns (bool) {
        address[] memory installed = _installedPlugins(msca);
        for (uint256 i = 0; i < installed.length; i++) {
            if (installed[i] == plugin) return true;
        }
        return false;
    }
}
