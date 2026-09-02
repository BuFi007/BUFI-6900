// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {CircleCanonical} from "./CircleCanonical.sol";

import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {AccountTestUtils} from "@circle-test/msca/6900/v0.8/utils/AccountTestUtils.sol";
import {EMPTY_HASH, ZERO_BYTES32} from "@circle/common/Constants.sol";
import {UpgradableMSCA} from "@circle/msca/6900/v0.8/account/UpgradableMSCA.sol";
import {UpgradableMSCAFactory} from "@circle/msca/6900/v0.8/factories/UpgradableMSCAFactory.sol";
import {
    ColdStorageAddressBookModule
} from "@circle/msca/6900/v0.8/modules/addressbook/ColdStorageAddressBookModule.sol";
import {SignerMetadata} from "@circle/msca/6900/v0.8/modules/multisig/MultisigStructs.sol";
import {
    WeightedMultisigValidationModule
} from "@circle/msca/6900/v0.8/modules/multisig/WeightedMultisigValidationModule.sol";
import {SingleSignerValidationModule} from "@circle/msca/6900/v0.8/modules/validation/SingleSignerValidationModule.sol";
import {ExecutionManifest} from "@erc6900/reference-implementation/interfaces/IExecutionModule.sol";
import {
    Call,
    IModularAccount,
    ModuleEntity,
    ValidationConfig
} from "@erc6900/reference-implementation/interfaces/IModularAccount.sol";
import {ValidationDataView} from "@erc6900/reference-implementation/interfaces/IModularAccountView.sol";
import {HookConfigLib} from "@erc6900/reference-implementation/libraries/HookConfigLib.sol";
import {ModuleEntityLib} from "@erc6900/reference-implementation/libraries/ModuleEntityLib.sol";
import {ValidationConfigLib} from "@erc6900/reference-implementation/libraries/ValidationConfigLib.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Vm} from "forge-std/src/Vm.sol";

/// @title CircleV08Harness
/// @notice Test base for Circle's ERC-6900 **v0.8** account generation (`circle.msca.2.0.0`): EntryPoint v0.7 at
///         the canonical address, a fresh `UpgradableMSCAFactory` (which deploys the `UpgradableMSCA`
///         implementation in its constructor), `SingleSignerValidationModule`, `WeightedMultisigValidationModule`
///         and `ColdStorageAddressBookModule`, plus the userOp helpers a module test needs — create an account,
///         sign in Circle's v0.8 envelope, drive the EntryPoint, read the outcome.
///
///         The v0.8 address book is a VALIDATION HOOK, not a per-selector plugin hook as in v0.7: it hangs off one
///         validation function (`installValidation(..., hooks)`) and runs on every userOp that validation admits,
///         decoding the calldata as `execute(target, value, data)`. See `_addressBookHook`.
///
///         Unlike the v0.7 stack (`CircleStackHarness`), there is NO canonical deployment to recreate: Circle's
///         `src/msca/6900/v0.8/README.md` states the contracts "are still in active development and are not
///         deployed on any mainnets yet", and `script/` has no v0.8 deploy step. Plain `new` is therefore the
///         faithful setup.
///
///         Signature envelope (BaseMSCA._authenticateAndAuthorizeUserOp + Circle's `AccountTestUtils`):
///           `[ModuleEntity: 24 bytes][flag: 1 byte][per-hook segments…][0xff][validation-module signature]`
///           - `flag` is `GLOBAL_VALIDATION_FLAG` (1) or `PER_SELECTOR_VALIDATION_FLAG` (0). A selector that an
///             execution manifest marks `allowGlobalValidation: false` is only reachable with flag 0, and only if
///             the validation function lists that selector — see `_grantSelectorsToOwner`.
///           - SingleSigner: one 65-byte `[r ‖ s ‖ v]` over `toEthSignedMessageHash(userOpHash)`.
///           - WeightedMultisig: k × 65-byte chunks in ascending **signer id** order (`bytes30(keccak256(
///             abi.encode(CredentialType.ADDRESS, addr)))`, NOT address order); exactly one chunk signs the actual
///             digest (`v + 32`), the rest sign the minimal digest that zeroes the gas fields — same rule as v0.7.
abstract contract CircleV08Harness is AccountTestUtils {
    using MessageHashUtils for bytes32;
    using ModuleEntityLib for ModuleEntity;

    struct Signer {
        address addr;
        uint256 key;
    }

    IEntryPoint internal entryPoint;
    UpgradableMSCAFactory internal factory;
    SingleSignerValidationModule internal singleSigner;
    WeightedMultisigValidationModule internal weightedMultisig;
    ColdStorageAddressBookModule internal addressBook;

    address internal factoryOwner = makeAddr("v0.8 factory owner");
    address payable internal beneficiary = payable(makeAddr("bundler-beneficiary"));

    /// Entity ids are namespaced per validation module, so both can be 0.
    uint32 internal constant OWNER_ENTITY_ID = 0;
    uint32 internal constant MULTISIG_ENTITY_ID = 0;

    uint128 internal constant DEFAULT_VERIFICATION_GAS = 3_000_000;
    uint128 internal constant DEFAULT_CALL_GAS = 3_000_000;
    uint256 internal constant DEFAULT_PRE_VERIFICATION_GAS = 100_000;
    uint128 internal constant DEFAULT_MAX_FEE = 1 gwei;
    uint128 internal constant DEFAULT_MAX_PRIORITY_FEE = 1 gwei;

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Stack deployment                                                               ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    function _deployCircleV08Stack() internal {
        if (CircleCanonical.ENTRY_POINT_V07.code.length == 0) {
            deployCodeTo("EntryPoint.sol:EntryPoint", CircleCanonical.ENTRY_POINT_V07);
        }
        entryPoint = IEntryPoint(CircleCanonical.ENTRY_POINT_V07);
        vm.label(CircleCanonical.ENTRY_POINT_V07, "EntryPoint v0.7");

        factory = new UpgradableMSCAFactory(factoryOwner, CircleCanonical.ENTRY_POINT_V07);
        singleSigner = new SingleSignerValidationModule();
        weightedMultisig = new WeightedMultisigValidationModule(CircleCanonical.ENTRY_POINT_V07);
        addressBook = new ColdStorageAddressBookModule();

        // The factory only lets allowlisted validation modules be installed at creation time.
        address[] memory modules = new address[](2);
        modules[0] = address(singleSigner);
        modules[1] = address(weightedMultisig);
        bool[] memory permissions = new bool[](2);
        permissions[0] = true;
        permissions[1] = true;
        vm.prank(factoryOwner);
        factory.setModules(modules, permissions);

        vm.label(address(factory), "UpgradableMSCAFactory v0.8");
        vm.label(address(factory.ACCOUNT_IMPLEMENTATION()), "UpgradableMSCA v0.8 (impl)");
        vm.label(address(singleSigner), "SingleSignerValidationModule");
        vm.label(address(weightedMultisig), "WeightedMultisigValidationModule");
        vm.label(address(addressBook), "ColdStorageAddressBookModule v0.8");
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Signers / accounts                                                             ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    function _makeSigner(string memory name) internal returns (Signer memory s) {
        (s.addr, s.key) = makeAddrAndKey(name);
    }

    function _makeSigners(string memory prefix, uint256 n) internal returns (Signer[] memory signers) {
        signers = new Signer[](n);
        for (uint256 i = 0; i < n; i++) {
            signers[i] = _makeSigner(string.concat(prefix, "-", vm.toString(i)));
        }
    }

    function _ownerValidation() internal view returns (ModuleEntity) {
        return ModuleEntityLib.pack(address(singleSigner), OWNER_ENTITY_ID);
    }

    function _multisigValidation() internal view returns (ModuleEntity) {
        return ModuleEntityLib.pack(address(weightedMultisig), MULTISIG_ENTITY_ID);
    }

    /// @dev The shape Circle's own v0.8 tests use: one global owner validation (userOp + runtime + 1271), no
    ///      selectors, no hooks. Funds the account.
    function _createSingleSignerAccount(Signer memory owner, bytes32 salt) internal returns (UpgradableMSCA account) {
        ValidationConfig config = ValidationConfigLib.pack(_ownerValidation(), true, true, true);
        bytes memory initializingData =
            abi.encode(config, new bytes4[](0), abi.encode(OWNER_ENTITY_ID, owner.addr), new bytes[](0));
        account = factory.createAccountWithValidation(addressToBytes32(owner.addr), salt, initializingData);
        vm.deal(address(account), 100 ether);
        vm.label(address(account), "MSCA v0.8 (single signer)");
    }

    /// @dev A k-of-n EOA weighted multisig account — the v0.8 analogue of a BUFI treasury. Funds the account.
    function _createWeightedAccount(Signer[] memory signers, uint256[] memory weights, uint256 threshold, bytes32 salt)
        internal
        returns (UpgradableMSCA account)
    {
        SignerMetadata[] memory metadata = new SignerMetadata[](signers.length);
        for (uint256 i = 0; i < signers.length; i++) {
            metadata[i].weight = weights[i];
            metadata[i].addr = signers[i].addr;
        }
        ValidationConfig config = ValidationConfigLib.pack(_multisigValidation(), true, true, true);
        bytes memory initializingData =
            abi.encode(config, new bytes4[](0), abi.encode(MULTISIG_ENTITY_ID, metadata, threshold), new bytes[](0));
        account = factory.createAccountWithValidation(addressToBytes32(signers[0].addr), salt, initializingData);
        vm.deal(address(account), 100 ether);
        vm.label(address(account), "MSCA v0.8 (weighted multisig)");
    }

    function _uniformWeights(uint256 n, uint256 w) internal pure returns (uint256[] memory out) {
        out = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            out[i] = w;
        }
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  UserOps                                                                        ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    function _buildUserOp(address sender, bytes memory callData) internal view returns (PackedUserOperation memory op) {
        op.sender = sender;
        op.nonce = entryPoint.getNonce(sender, 0);
        op.initCode = "";
        op.callData = callData;
        op.accountGasLimits = bytes32(abi.encodePacked(DEFAULT_VERIFICATION_GAS, DEFAULT_CALL_GAS));
        op.preVerificationGas = DEFAULT_PRE_VERIFICATION_GAS;
        op.gasFees = bytes32(abi.encodePacked(DEFAULT_MAX_PRIORITY_FEE, DEFAULT_MAX_FEE));
        op.paymasterAndData = "";
    }

    /// @dev One EOA signature for any `SingleSignerValidationModule` entity, wrapped in the v0.8 envelope.
    function _signSingleSigner(PackedUserOperation memory op, uint32 entityId, uint256 key, bool global)
        internal
        view
        returns (bytes memory)
    {
        bytes memory sig = signUserOpHash(entryPoint, vm, key, op);
        ModuleEntity validation = ModuleEntityLib.pack(address(singleSigner), entityId);
        return encodeSignature(new PreValidationHookData[](0), validation, sig, global);
    }

    function _signOwner(PackedUserOperation memory op, uint256 key, bool global) internal view returns (bytes memory) {
        return _signSingleSigner(op, OWNER_ENTITY_ID, key, global);
    }

    /// @dev Mirrors WeightedMultisigValidationModule._getMinimalUserOpDigest (already eth-signed-message wrapped).
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
        return keccak256(abi.encode(h, CircleCanonical.ENTRY_POINT_V07, block.chainid)).toEthSignedMessageHash();
    }

    /// @dev Sorts by the module's signer id (keccak-derived), which is the order `checkNSignatures` enforces.
    function _sortBySignerId(Signer[] memory signers) internal view returns (Signer[] memory sorted) {
        sorted = new Signer[](signers.length);
        bytes30[] memory ids = new bytes30[](signers.length);
        for (uint256 i = 0; i < signers.length; i++) {
            sorted[i] = signers[i];
            ids[i] = weightedMultisig.getSignerId(signers[i].addr);
        }
        for (uint256 i = 1; i < sorted.length; i++) {
            Signer memory s = sorted[i];
            bytes30 id = ids[i];
            uint256 j = i;
            while (j > 0 && uint240(ids[j - 1]) > uint240(id)) {
                sorted[j] = sorted[j - 1];
                ids[j] = ids[j - 1];
                j--;
            }
            sorted[j] = s;
            ids[j] = id;
        }
    }

    /// @dev Signs with every provided signer; the lowest signer id signs the actual digest (`v + 32`), the rest
    ///      sign the minimal digest. Pass exactly the signers you want counted.
    function _signWeighted(PackedUserOperation memory op, Signer[] memory signers, bool global)
        internal
        view
        returns (bytes memory)
    {
        Signer[] memory ordered = _sortBySignerId(signers);
        bytes32 actual = entryPoint.getUserOpHash(op).toEthSignedMessageHash();
        bytes32 minimal = _minimalUserOpDigest(op);
        bytes memory sig;
        for (uint256 i = 0; i < ordered.length; i++) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(ordered[i].key, i == 0 ? actual : minimal);
            if (i == 0) v += 32;
            sig = bytes.concat(sig, abi.encodePacked(r, s, v));
        }
        return encodeSignature(new PreValidationHookData[](0), _multisigValidation(), sig, global);
    }

    function _handleOps(PackedUserOperation memory op) internal {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        entryPoint.handleOps(ops, beneficiary);
    }

    /// @dev Submits a signed op. Reverts if validation fails; returns whether the execution phase succeeded and
    ///      stashes the outcome for `_lastUserOpSucceeded` / `_lastUserOpRevertReason` (recorded logs can only be
    ///      drained once, so they are parsed here exactly once).
    function _executeSignedUserOp(PackedUserOperation memory op) internal returns (bool success) {
        vm.recordLogs();
        _handleOps(op);
        _readUserOpOutcome(vm.getRecordedLogs());
        return lastUserOpSuccess;
    }

    /// @dev Owner-signed, GLOBAL validation: native functions (`execute`, `installExecution`, …) and manifest
    ///      selectors marked `allowGlobalValidation: true`.
    function _executeUserOp(UpgradableMSCA account, bytes memory callData, uint256 signerKey) internal returns (bool) {
        return _executeUserOpAs(account, callData, OWNER_ENTITY_ID, true, signerKey);
    }

    /// @dev Owner-signed, PER-SELECTOR validation: needs the selector granted via `_grantSelectorsToOwner`.
    function _executeUserOpPerSelector(UpgradableMSCA account, bytes memory callData, uint256 signerKey)
        internal
        returns (bool)
    {
        return _executeUserOpAs(account, callData, OWNER_ENTITY_ID, false, signerKey);
    }

    /// @dev Any single-signer entity, either flag.
    function _executeUserOpAs(
        UpgradableMSCA account,
        bytes memory callData,
        uint32 entityId,
        bool global,
        uint256 signerKey
    ) internal returns (bool) {
        return _executeSignedUserOp(_prepareUserOp(account, callData, entityId, global, signerKey));
    }

    /// @dev Build → sign for a single-signer entity. Submit with `_executeSignedUserOp`; useful when a
    ///      `vm.expectEmit` has to sit between signing (which reads the nonce) and `handleOps`.
    function _prepareUserOp(
        UpgradableMSCA account,
        bytes memory callData,
        uint32 entityId,
        bool global,
        uint256 signerKey
    ) internal view returns (PackedUserOperation memory op) {
        op = _buildUserOp(address(account), callData);
        op.signature = _signSingleSigner(op, entityId, signerKey, global);
    }

    function _prepareOwnerUserOp(UpgradableMSCA account, bytes memory callData, uint256 ownerKey)
        internal
        view
        returns (PackedUserOperation memory)
    {
        return _prepareUserOp(account, callData, OWNER_ENTITY_ID, true, ownerKey);
    }

    function _prepareOwnerUserOpPerSelector(UpgradableMSCA account, bytes memory callData, uint256 ownerKey)
        internal
        view
        returns (PackedUserOperation memory)
    {
        return _prepareUserOp(account, callData, OWNER_ENTITY_ID, false, ownerKey);
    }

    function _executeWeightedUserOp(UpgradableMSCA account, bytes memory callData, Signer[] memory signers)
        internal
        returns (bool)
    {
        PackedUserOperation memory op = _buildUserOp(address(account), callData);
        op.signature = _signWeighted(op, signers, true);
        return _executeSignedUserOp(op);
    }

    /// @dev Asserts the EntryPoint rejects the op during validation. Use instead of `vm.expectRevert()` +
    ///      `_executeUserOp`, whose first external call is a view read and would swallow the expectation.
    function _expectValidationRevertSigned(PackedUserOperation memory op) internal {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.expectRevert();
        entryPoint.handleOps(ops, beneficiary);
    }

    /// @dev The precise form: the account's `validateUserOp` reverted with `inner` (an account error such as
    ///      `InvalidValidationFunction`, or a validation hook's revert bubbled up unwrapped), which EntryPoint
    ///      v0.7 always reports as `FailedOpWithRevert(0, "AA23 reverted", inner)`.
    function _expectFailedOpWithRevert(PackedUserOperation memory op, bytes memory inner) internal {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOpWithRevert.selector, 0, "AA23 reverted", inner));
        entryPoint.handleOps(ops, beneficiary);
    }

    function _expectValidationRevert(UpgradableMSCA account, bytes memory callData, uint256 signerKey) internal {
        _expectValidationRevertAs(account, callData, OWNER_ENTITY_ID, true, signerKey);
    }

    function _expectValidationRevertPerSelector(UpgradableMSCA account, bytes memory callData, uint256 signerKey)
        internal
    {
        _expectValidationRevertAs(account, callData, OWNER_ENTITY_ID, false, signerKey);
    }

    function _expectValidationRevertAs(
        UpgradableMSCA account,
        bytes memory callData,
        uint32 entityId,
        bool global,
        uint256 signerKey
    ) internal {
        PackedUserOperation memory op = _buildUserOp(address(account), callData);
        op.signature = _signSingleSigner(op, entityId, signerKey, global);
        _expectValidationRevertSigned(op);
    }

    function _expectWeightedValidationRevert(UpgradableMSCA account, bytes memory callData, Signer[] memory signers)
        internal
    {
        PackedUserOperation memory op = _buildUserOp(address(account), callData);
        op.signature = _signWeighted(op, signers, true);
        _expectValidationRevertSigned(op);
    }

    bool internal lastUserOpSuccess;
    bytes internal lastUserOpRevertReason;

    function _readUserOpOutcome(Vm.Log[] memory logs) internal {
        lastUserOpSuccess = false;
        delete lastUserOpRevertReason;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == IEntryPoint.UserOperationEvent.selector) {
                (, lastUserOpSuccess,,) = abi.decode(logs[i].data, (uint256, bool, uint256, uint256));
            } else if (logs[i].topics[0] == IEntryPoint.UserOperationRevertReason.selector) {
                (, lastUserOpRevertReason) = abi.decode(logs[i].data, (uint256, bytes));
            }
        }
    }

    function _lastUserOpSucceeded() internal view returns (bool) {
        return lastUserOpSuccess;
    }

    /// @dev Execution-phase revert reason of the last submitted userOp (empty when it succeeded, or when the
    ///      revert carried no data).
    function _lastUserOpRevertReason() internal view returns (bytes memory) {
        return lastUserOpRevertReason;
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Calldata builders (Circle-typed: reference-implementation v0.8.0)             ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    function _installExecutionCalldata(address module, ExecutionManifest memory manifest, bytes memory installData)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeCall(IModularAccount.installExecution, (module, manifest, installData));
    }

    function _uninstallExecutionCalldata(address module, ExecutionManifest memory manifest, bytes memory uninstallData)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeCall(IModularAccount.uninstallExecution, (module, manifest, uninstallData));
    }

    function _installValidationCalldata(
        ValidationConfig config,
        bytes4[] memory selectors,
        bytes memory installData,
        bytes[] memory hooks
    ) internal pure returns (bytes memory) {
        return abi.encodeCall(IModularAccount.installValidation, (config, selectors, installData, hooks));
    }

    function _executeCalldata(address target, uint256 value, bytes memory data) internal pure returns (bytes memory) {
        return abi.encodeCall(IModularAccount.execute, (target, value, data));
    }

    function _executeBatchCalldata(Call[] memory calls) internal pure returns (bytes memory) {
        return abi.encodeCall(IModularAccount.executeBatch, (calls));
    }

    /// @dev One entry of `installValidation`'s `hooks` array: a packed validation-hook config + its install data.
    function _validationHook(address module, uint32 entityId, bytes memory installData)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(HookConfigLib.packValidationHook(ModuleEntityLib.pack(module, entityId)), installData);
    }

    /// @dev Re-installs the owner validation with a selector list. Circle's `_installValidation` appends to the
    ///      selectors set (reverting `ItemAlreadyExists` on a repeat), keeps the flags, and skips `onInstall` for
    ///      empty install data — so this is how a manifest selector marked `allowGlobalValidation: false` becomes
    ///      reachable by the owner at all. Selectors can never be removed again short of `uninstallValidation`.
    function _grantSelectorsToOwner(UpgradableMSCA account, bytes4[] memory selectors, uint256 ownerKey)
        internal
        returns (bool)
    {
        ValidationConfig config = ValidationConfigLib.pack(_ownerValidation(), true, true, true);
        return _executeUserOp(account, _installValidationCalldata(config, selectors, "", new bytes[](0)), ownerKey);
    }

    /// @dev Attaches validation hooks to the (already installed) owner validation. Same append-only semantics as
    ///      `_grantSelectorsToOwner`; a hook entry comes from `_validationHook` / `_addressBookHook`.
    function _attachHooksToOwner(UpgradableMSCA account, bytes[] memory hooks, uint256 ownerKey)
        internal
        returns (bool)
    {
        ValidationConfig config = ValidationConfigLib.pack(_ownerValidation(), true, true, true);
        return _executeUserOp(account, _installValidationCalldata(config, new bytes4[](0), "", hooks), ownerKey);
    }

    /// @dev Installs a further `SingleSignerValidationModule` entity on the account through an owner userOp:
    ///      `signer` becomes the signer for `entityId`, reachable for `selectors` (per-selector flag) and, when
    ///      `isGlobal`, for everything global validation admits. `hooks` are validation-hook entries.
    function _installSingleSignerValidation(
        UpgradableMSCA account,
        uint32 entityId,
        address signer,
        bool isGlobal,
        bytes4[] memory selectors,
        bytes[] memory hooks,
        uint256 ownerKey
    ) internal returns (bool) {
        ValidationConfig config = ValidationConfigLib.pack(
            ModuleEntityLib.pack(address(singleSigner), entityId), isGlobal, false, true
        );
        bytes memory callData = _installValidationCalldata(config, selectors, abi.encode(entityId, signer), hooks);
        return _executeUserOp(account, callData, ownerKey);
    }

    /// @dev One `ColdStorageAddressBookModule` validation-hook entry. Entity 0 decodes the userOp as `execute`,
    ///      entity 1 as `executeBatch`; whichever is attached runs on EVERY userOp its validation admits. Pass an
    ///      allowlist as `installData` only if the module advertises `IValidationHookModule` — Circle's v0.8
    ///      module does not, so seed the allowlist through its execution manifest (`installExecution` with
    ///      `abi.encode(recipients)`) and attach the hook with empty data.
    function _addressBookHook(ColdStorageAddressBookModule.EntityId entityId, bytes memory installData)
        internal
        view
        returns (bytes memory)
    {
        return _validationHook(address(addressBook), uint32(entityId), installData);
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Loupe (IModularAccountView — Circle's v0.8 equivalent of IAccountLoupe)        ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    function _executionModule(UpgradableMSCA account, bytes4 selector) internal view returns (address) {
        return account.getExecutionData(selector).module;
    }

    /// @dev True when every selector in `manifest` is routed to `module`.
    function _routesManifestTo(UpgradableMSCA account, ExecutionManifest memory manifest, address module)
        internal
        view
        returns (bool)
    {
        for (uint256 i = 0; i < manifest.executionFunctions.length; i++) {
            if (_executionModule(account, manifest.executionFunctions[i].executionSelector) != module) return false;
        }
        return true;
    }

    function _validationData(UpgradableMSCA account, ModuleEntity validation)
        internal
        view
        returns (ValidationDataView memory)
    {
        return account.getValidationData(validation);
    }

    /// @dev True when `validation` lists `selector` for per-selector validation.
    function _validationHasSelector(UpgradableMSCA account, ModuleEntity validation, bytes4 selector)
        internal
        view
        returns (bool)
    {
        bytes4[] memory selectors = _validationData(account, validation).selectors;
        for (uint256 i = 0; i < selectors.length; i++) {
            if (selectors[i] == selector) return true;
        }
        return false;
    }
}
