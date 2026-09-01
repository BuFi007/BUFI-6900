// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {CircleCanonical} from "./CircleCanonical.sol";
import {CircleStackHarness} from "./CircleStackHarness.sol";

import {BufiSessionKeyPlugin} from "../../src/bufi/v0.7/session/BufiSessionKeyPlugin.sol";
import {IBufiSessionKeyPlugin} from "../../src/bufi/v0.7/session/IBufiSessionKeyPlugin.sol";
import {ISessionKeyPermissionsUpdates} from "../../src/bufi/v0.7/session/permissions/ISessionKeyPermissionsUpdates.sol";

import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {IPaymaster} from "@account-abstraction/contracts/interfaces/IPaymaster.sol";
import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {UpgradableMSCA} from "@circle/msca/6900/v0.7/account/UpgradableMSCA.sol";
import {Call, FunctionReference} from "@circle/msca/6900/v0.7/common/Structs.sol";
import {IPluginManager} from "@circle/msca/6900/v0.7/interfaces/IPluginManager.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Vm} from "forge-std/src/Vm.sol";

/// @title SessionKeyHarness
/// @notice `CircleStackHarness` plus everything a BufiSessionKeyPlugin test needs on the REAL Circle stack:
///         install with the production dependency slots, owner-side key management through multisig-signed
///         userOps (the only path Circle's weighted plugin allows), permission-update encoders, and session-key
///         userOps whose `callData` is `executeWithSessionKey(calls, sessionKey)` and whose `signature` is the
///         key's plain 65-byte ECDSA signature over `toEthSignedMessageHash(userOpHash)`.
///
///         Session-key userOps use the session key's address as the 192-bit nonce KEY by default — the plugin
///         requires it whenever a gas spend limit is set, and it is harmless otherwise.
abstract contract SessionKeyHarness is CircleStackHarness {
    using MessageHashUtils for bytes32;

    BufiSessionKeyPlugin internal sessionKeyPlugin;

    /// Gas parameters for session-key userOps unless a test overrides them. maxPriorityFee is 1 wei and
    /// block.basefee is 0 in tests, so the ACTUAL gas charged is negligible; the "max gas cost" the plugin's gas
    /// spend limit charges is (verification + call + preVerification) * maxFee.
    uint128 internal constant SK_VERIFICATION_GAS = 1_000_000;
    uint128 internal constant SK_CALL_GAS = 1_000_000;
    uint256 internal constant SK_PRE_VERIFICATION_GAS = 0;
    uint128 internal constant SK_MAX_FEE = 2;
    uint128 internal constant SK_MAX_PRIORITY_FEE = 1;

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Deployment / install                                                           ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    function _deploySessionKeyPlugin() internal {
        sessionKeyPlugin = new BufiSessionKeyPlugin();
        vm.label(address(sessionKeyPlugin), "BufiSessionKeyPlugin");
    }

    /// @dev The production dependency-slot arrangement on a Circle weighted-multisig account — identical to
    ///      ColdStorageAddressBookPlugin's: slot 0 (runtime validation of addSessionKey / removeSessionKey /
    ///      rotateSessionKey / updateKeyPermissions) → the deliberately unimplemented Weighted function id 1
    ///      (fail-closed), slot 1 (userOp validation of the same functions) → Weighted USER_OP_VALIDATION_OWNER (0).
    function _sessionKeyDependencies() internal view returns (FunctionReference[] memory deps) {
        deps = new FunctionReference[](2);
        deps[0] = FunctionReference(address(weightedPlugin), CircleCanonical.WEIGHTED_RUNTIME_DEPENDENCY_FAIL_CLOSED);
        deps[1] = FunctionReference(address(weightedPlugin), CircleCanonical.WEIGHTED_USER_OP_VALIDATION_OWNER);
    }

    function _emptySessionKeyInstallData() internal pure returns (bytes memory) {
        return abi.encode(new address[](0), new bytes32[](0), new bytes[][](0));
    }

    function _sessionKeyInstallData(address[] memory keys, bytes32[] memory tags, bytes[][] memory permissions)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(keys, tags, permissions);
    }

    function _installSessionKeyPlugin(UpgradableMSCA msca, Signer[] memory signers) internal returns (bool) {
        return _installPlugin(
            msca, address(sessionKeyPlugin), _emptySessionKeyInstallData(), _sessionKeyDependencies(), signers
        );
    }

    function _installSessionKeyPluginWith(UpgradableMSCA msca, bytes memory installData, Signer[] memory signers)
        internal
        returns (bool)
    {
        return _installPlugin(msca, address(sessionKeyPlugin), installData, _sessionKeyDependencies(), signers);
    }

    function _uninstallSessionKeyPlugin(UpgradableMSCA msca, Signer[] memory signers) internal returns (bool) {
        return _executeUserOp(
            msca, abi.encodeCall(IPluginManager.uninstallPlugin, (address(sessionKeyPlugin), "", "")), signers
        );
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Owner-side key management (multisig userOps)                                   ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    function _addSessionKeyCalldata(address key, bytes32 tag, bytes[] memory updates)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeCall(IBufiSessionKeyPlugin.addSessionKey, (key, tag, updates));
    }

    function _addSessionKey(
        UpgradableMSCA msca,
        address key,
        bytes32 tag,
        bytes[] memory updates,
        Signer[] memory signers
    ) internal returns (bool) {
        return _executeUserOp(msca, _addSessionKeyCalldata(key, tag, updates), signers);
    }

    /// @dev Adds a key with no permissions (allowlist enabled, native spend limit 0) — the plugin's defaults.
    function _addSessionKey(UpgradableMSCA msca, address key, Signer[] memory signers) internal returns (bool) {
        return _addSessionKey(msca, key, bytes32(0), new bytes[](0), signers);
    }

    function _updateKeyPermissions(UpgradableMSCA msca, address key, bytes[] memory updates, Signer[] memory signers)
        internal
        returns (bool)
    {
        return _executeUserOp(msca, abi.encodeCall(IBufiSessionKeyPlugin.updateKeyPermissions, (key, updates)), signers);
    }

    function _removeSessionKey(UpgradableMSCA msca, address key, Signer[] memory signers) internal returns (bool) {
        bytes32 predecessor = sessionKeyPlugin.findPredecessor(address(msca), key);
        return _executeUserOp(msca, abi.encodeCall(IBufiSessionKeyPlugin.removeSessionKey, (key, predecessor)), signers);
    }

    function _rotateSessionKey(UpgradableMSCA msca, address oldKey, address newKey, Signer[] memory signers)
        internal
        returns (bool)
    {
        bytes32 predecessor = sessionKeyPlugin.findPredecessor(address(msca), oldKey);
        return _executeUserOp(
            msca, abi.encodeCall(IBufiSessionKeyPlugin.rotateSessionKey, (oldKey, predecessor, newKey)), signers
        );
    }

    /// @dev Owner userOp whose execution-phase outcome AND revert reason are both needed (the base harness
    ///      helper consumes the recorded logs, so both must be read in one pass).
    function _executeOwnerUserOpWithReason(UpgradableMSCA msca, bytes memory callData, Signer[] memory signers)
        internal
        returns (bool success, bytes memory reason)
    {
        return _runOp(_prepareUserOp(msca, callData, signers));
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Permission-update encoders (ISessionKeyPermissionsUpdates ABI)                 ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    function _permAccessListType(IBufiSessionKeyPlugin.ContractAccessControlType t)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeCall(ISessionKeyPermissionsUpdates.setAccessListType, (t));
    }

    function _permAllowAll() internal pure returns (bytes memory) {
        return _permAccessListType(IBufiSessionKeyPlugin.ContractAccessControlType.ALLOW_ALL_ACCESS);
    }

    function _permAddressEntry(address target, bool isOnList, bool checkSelectors)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeCall(
            ISessionKeyPermissionsUpdates.updateAccessListAddressEntry, (target, isOnList, checkSelectors)
        );
    }

    function _permFunctionEntry(address target, bytes4 selector, bool isOnList) internal pure returns (bytes memory) {
        return abi.encodeCall(ISessionKeyPermissionsUpdates.updateAccessListFunctionEntry, (target, selector, isOnList));
    }

    function _permTimeRange(uint48 validAfter, uint48 validUntil) internal pure returns (bytes memory) {
        return abi.encodeCall(ISessionKeyPermissionsUpdates.updateTimeRange, (validAfter, validUntil));
    }

    function _permNativeLimit(uint256 limit, uint48 refreshInterval) internal pure returns (bytes memory) {
        return abi.encodeCall(ISessionKeyPermissionsUpdates.setNativeTokenSpendLimit, (limit, refreshInterval));
    }

    function _permNativeUnlimited() internal pure returns (bytes memory) {
        return _permNativeLimit(type(uint256).max, 0);
    }

    function _permErc20Limit(address token, uint256 limit, uint48 refreshInterval)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeCall(ISessionKeyPermissionsUpdates.setERC20SpendLimit, (token, limit, refreshInterval));
    }

    function _permGasLimit(uint256 limit, uint48 refreshInterval) internal pure returns (bytes memory) {
        return abi.encodeCall(ISessionKeyPermissionsUpdates.setGasSpendLimit, (limit, refreshInterval));
    }

    function _permRequiredPaymaster(address paymaster) internal pure returns (bytes memory) {
        return abi.encodeCall(ISessionKeyPermissionsUpdates.setRequiredPaymaster, (paymaster));
    }

    function _updates(bytes memory a) internal pure returns (bytes[] memory u) {
        u = new bytes[](1);
        u[0] = a;
    }

    function _updates(bytes memory a, bytes memory b) internal pure returns (bytes[] memory u) {
        u = new bytes[](2);
        u[0] = a;
        u[1] = b;
    }

    function _updates(bytes memory a, bytes memory b, bytes memory c) internal pure returns (bytes[] memory u) {
        u = new bytes[](3);
        u[0] = a;
        u[1] = b;
        u[2] = c;
    }

    function _updates(bytes memory a, bytes memory b, bytes memory c, bytes memory d)
        internal
        pure
        returns (bytes[] memory u)
    {
        u = new bytes[](4);
        u[0] = a;
        u[1] = b;
        u[2] = c;
        u[3] = d;
    }

    /// @dev "Unrestricted" key: no access list and no native token limit (the two defaults that otherwise block
    ///      every call). Mirrors what Alchemy's tests set up before exercising a single rule in isolation.
    function _permUnrestricted() internal pure returns (bytes[] memory) {
        return _updates(_permAllowAll(), _permNativeUnlimited());
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Calls                                                                          ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    function _call(address target, uint256 value, bytes memory data) internal pure returns (Call memory) {
        return Call({target: target, value: value, data: data});
    }

    function _calls(Call memory a) internal pure returns (Call[] memory c) {
        c = new Call[](1);
        c[0] = a;
    }

    function _calls(Call memory a, Call memory b) internal pure returns (Call[] memory c) {
        c = new Call[](2);
        c[0] = a;
        c[1] = b;
    }

    function _calls(Call memory a, Call memory b, Call memory d) internal pure returns (Call[] memory c) {
        c = new Call[](3);
        c[0] = a;
        c[1] = b;
        c[2] = d;
    }

    function _erc20Transfer(address token, address to, uint256 amount) internal pure returns (Call memory) {
        return _call(token, 0, abi.encodeCall(IERC20.transfer, (to, amount)));
    }

    function _erc20Approve(address token, address spender, uint256 amount) internal pure returns (Call memory) {
        return _call(token, 0, abi.encodeCall(IERC20.approve, (spender, amount)));
    }

    function _nativeTransfer(address to, uint256 amount) internal pure returns (Call memory) {
        return _call(to, amount, "");
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Session-key userOps                                                            ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    function _sessionKeyNonceKey(address sessionKey) internal pure returns (uint192) {
        return uint192(uint160(sessionKey));
    }

    /// @dev Next nonce for a session key on `msca`, with the key's address as the 192-bit nonce key.
    function _sessionKeyNonce(UpgradableMSCA msca, address sessionKey) internal view returns (uint256) {
        return entryPoint.getNonce(address(msca), _sessionKeyNonceKey(sessionKey));
    }

    /// @dev `nonce | (key << 64)` — the nonce layout the plugin inspects when a gas spend limit is set.
    function _wrapNonceWithKey(uint64 sequence, address sessionKey) internal pure returns (uint256) {
        return uint256(sequence) | (uint256(uint160(sessionKey)) << 64);
    }

    function _executeWithSessionKeyCalldata(Call[] memory calls, address sessionKey)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeCall(IBufiSessionKeyPlugin.executeWithSessionKey, (calls, sessionKey));
    }

    /// @dev Unsigned session-key userOp with the harness defaults and the session-key nonce key.
    function _buildSessionKeyUserOp(UpgradableMSCA msca, Call[] memory calls, address sessionKey)
        internal
        view
        returns (PackedUserOperation memory op)
    {
        op = _buildSessionKeyUserOpWithGas(
            msca,
            calls,
            sessionKey,
            SK_VERIFICATION_GAS,
            SK_CALL_GAS,
            SK_PRE_VERIFICATION_GAS,
            SK_MAX_FEE,
            SK_MAX_PRIORITY_FEE,
            ""
        );
    }

    function _buildSessionKeyUserOpWithGas(
        UpgradableMSCA msca,
        Call[] memory calls,
        address sessionKey,
        uint128 verificationGas,
        uint128 callGas,
        uint256 preVerificationGas,
        uint128 maxFee,
        uint128 maxPriorityFee,
        bytes memory paymasterAndData
    ) internal view returns (PackedUserOperation memory op) {
        op.sender = address(msca);
        op.nonce = _sessionKeyNonce(msca, sessionKey);
        op.initCode = "";
        op.callData = _executeWithSessionKeyCalldata(calls, sessionKey);
        op.accountGasLimits = bytes32(abi.encodePacked(verificationGas, callGas));
        op.preVerificationGas = preVerificationGas;
        op.gasFees = bytes32(abi.encodePacked(maxPriorityFee, maxFee));
        op.paymasterAndData = paymasterAndData;
    }

    /// @dev The signature format the plugin verifies: `[r ‖ s ‖ v]` over `toEthSignedMessageHash(userOpHash)`.
    function _signSessionKey(PackedUserOperation memory op, uint256 sessionKeyPrivate)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = entryPoint.getUserOpHash(op).toEthSignedMessageHash();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(sessionKeyPrivate, digest);
        return abi.encodePacked(r, s, v);
    }

    function _prepareSessionKeyUserOp(UpgradableMSCA msca, Call[] memory calls, Signer memory sessionKey)
        internal
        view
        returns (PackedUserOperation memory op)
    {
        op = _buildSessionKeyUserOp(msca, calls, sessionKey.addr);
        op.signature = _signSessionKey(op, sessionKey.key);
    }

    /// @dev Build → sign → submit. Reverts if the EntryPoint rejects the op during validation; returns whether
    ///      the execution phase succeeded.
    function _executeSessionKeyUserOp(UpgradableMSCA msca, Call[] memory calls, Signer memory sessionKey)
        internal
        returns (bool success)
    {
        (success,) = _runOp(_prepareSessionKeyUserOp(msca, calls, sessionKey));
    }

    /// @dev Same, also returning the execution-phase revert reason (empty when it succeeded).
    function _executeSessionKeyUserOpWithReason(UpgradableMSCA msca, Call[] memory calls, Signer memory sessionKey)
        internal
        returns (bool success, bytes memory reason)
    {
        return _runOp(_prepareSessionKeyUserOp(msca, calls, sessionKey));
    }

    /// @dev Submits one op through `handleOps` and reads back (success, revert reason) from the EntryPoint events
    ///      in a single log pass.
    function _runOp(PackedUserOperation memory op) internal returns (bool success, bytes memory reason) {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        (bool[] memory successes, bytes[] memory reasons) = _runOps(ops);
        return (successes[0], reasons[0]);
    }

    /// @dev Submits a bundle. Reverts if the EntryPoint rejects any op during validation. Per-op results are
    ///      returned in submission order (UserOperationEvent / UserOperationRevertReason are emitted in order).
    function _runOps(PackedUserOperation[] memory ops)
        internal
        returns (bool[] memory successes, bytes[] memory reasons)
    {
        vm.recordLogs();
        entryPoint.handleOps(ops, beneficiary);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        successes = new bool[](ops.length);
        reasons = new bytes[](ops.length);
        uint256 eventIndex;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == IEntryPoint.UserOperationRevertReason.selector) {
                // The revert-reason event precedes its UserOperationEvent, so it belongs to op `eventIndex`.
                (, bytes memory r) = abi.decode(logs[i].data, (uint256, bytes));
                reasons[eventIndex] = r;
            } else if (logs[i].topics[0] == IEntryPoint.UserOperationEvent.selector) {
                (, bool ok,,) = abi.decode(logs[i].data, (uint256, bool, uint256, uint256));
                successes[eventIndex++] = ok;
            }
        }
    }

    /// @dev Asserts the EntryPoint rejects the session-key op during validation, with any reason.
    function _expectSessionKeyValidationRevert(UpgradableMSCA msca, Call[] memory calls, Signer memory sessionKey)
        internal
    {
        PackedUserOperation memory op = _prepareSessionKeyUserOp(msca, calls, sessionKey);
        _expectHandleOpsRevert(op, "");
    }

    /// @dev Asserts the EntryPoint rejects the session-key op with EXACTLY `expectedError` (an encoded
    ///      FailedOp / FailedOpWithRevert — see the `_aa*` helpers).
    function _expectSessionKeyValidationRevert(
        UpgradableMSCA msca,
        Call[] memory calls,
        Signer memory sessionKey,
        bytes memory expectedError
    ) internal {
        PackedUserOperation memory op = _prepareSessionKeyUserOp(msca, calls, sessionKey);
        _expectHandleOpsRevert(op, expectedError);
    }

    function _expectHandleOpsRevert(PackedUserOperation memory op, bytes memory expectedError) internal {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        _expectHandleOpsRevert(ops, expectedError);
    }

    function _expectHandleOpsRevert(PackedUserOperation[] memory ops, bytes memory expectedError) internal {
        if (expectedError.length == 0) {
            vm.expectRevert();
        } else {
            vm.expectRevert(expectedError);
        }
        entryPoint.handleOps(ops, beneficiary);
    }

    /// @dev Runs the account's `validateUserOp` as the EntryPoint would, WITHOUT executing, so tests can inspect
    ///      the packed validation data (validAfter / validUntil / authorizer). Note the plugin's gas-limit rule
    ///      mutates state during validation, exactly as it would under a bundler.
    function _validateAsEntryPoint(UpgradableMSCA msca, PackedUserOperation memory op)
        internal
        returns (uint256 validationData)
    {
        bytes32 userOpHash = entryPoint.getUserOpHash(op);
        vm.prank(address(entryPoint));
        validationData = msca.validateUserOp(op, userOpHash, 0);
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  EntryPoint v0.7 rejection encoders                                             ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    /// @dev Account validation reverted with `inner` (v0.7 wraps it in FailedOpWithRevert).
    function _aa23(uint256 opIndex, bytes memory inner) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IEntryPoint.FailedOpWithRevert.selector, opIndex, "AA23 reverted", inner);
    }

    function _aa23(bytes memory inner) internal pure returns (bytes memory) {
        return _aa23(0, inner);
    }

    /// @dev The plugin's own permission failure, as the EntryPoint reports it.
    function _aa23PermissionsCheckFailed() internal pure returns (bytes memory) {
        return _aa23(abi.encodeWithSelector(IBufiSessionKeyPlugin.PermissionsCheckFailed.selector));
    }

    function _aa23PermissionsCheckFailed(uint256 opIndex) internal pure returns (bytes memory) {
        return _aa23(opIndex, abi.encodeWithSelector(IBufiSessionKeyPlugin.PermissionsCheckFailed.selector));
    }

    /// @dev Validation returned SIG_VALIDATION_FAILED.
    function _aa24(uint256 opIndex) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IEntryPoint.FailedOp.selector, opIndex, "AA24 signature error");
    }

    function _aa24() internal pure returns (bytes memory) {
        return _aa24(0);
    }

    /// @dev Validation passed but block.timestamp is outside [validAfter, validUntil].
    function _aa22(uint256 opIndex) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IEntryPoint.FailedOp.selector, opIndex, "AA22 expired or not due");
    }

    function _aa22() internal pure returns (bytes memory) {
        return _aa22(0);
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  ERC-4337 v0.7 gas accounting                                                   ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    /// @dev EntryPoint v0.7 `_getRequiredPrefund`, recomputed test-side from a memory op so tests can assert the
    ///      exact amount the plugin's gas spend limit will charge.
    function _requiredPrefundV07(PackedUserOperation memory op) internal pure returns (uint256) {
        uint256 verificationGas = uint256(op.accountGasLimits) >> 128;
        uint256 callGas = uint128(uint256(op.accountGasLimits));
        uint256 maxFee = uint128(uint256(op.gasFees));
        uint256 pmVerification;
        uint256 pmPostOp;
        if (op.paymasterAndData.length > 0) {
            bytes memory pm = op.paymasterAndData;
            pmVerification = uint128(bytes16(_slice(pm, 20, 36)));
            pmPostOp = uint128(bytes16(_slice(pm, 36, 52)));
        }
        return (verificationGas + callGas + pmVerification + pmPostOp + op.preVerificationGas) * maxFee;
    }

    function _slice(bytes memory data, uint256 start, uint256 end) internal pure returns (bytes32 out) {
        for (uint256 i = start; i < end; i++) {
            out |= bytes32(data[i]) >> (8 * (i - start));
        }
    }

    /// @dev `paymasterAndData` in the v0.7 layout: paymaster(20) ‖ verificationGasLimit(16) ‖ postOpGasLimit(16).
    function _paymasterAndData(address paymaster, uint128 verificationGas, uint128 postOpGas)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(paymaster, verificationGas, postOpGas);
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Account helpers                                                                ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    /// @dev A 2-of-3 weighted account with the session key plugin installed. Returns the account and the two
    ///      owners that form the quorum used for every management userOp in the test.
    function _createAccountWithSessionKeyPlugin(string memory prefix, bytes32 salt)
        internal
        returns (UpgradableMSCA msca, Signer[] memory quorum)
    {
        Signer[] memory owners = _makeSigners(prefix, 3);
        msca = _createWeightedMsca(owners, _uniformWeights(3, 1), 2, salt);
        quorum = new Signer[](2);
        quorum[0] = owners[0];
        quorum[1] = owners[1];
        require(_installSessionKeyPlugin(msca, quorum), "session key plugin install failed");
    }

    function _signerFrom(string memory name) internal returns (Signer memory s) {
        (s.addr, s.key) = makeAddrAndKey(name);
    }
}

/// @notice Minimal target with two selectors, for access-list tests.
contract SessionCounter {
    uint256 public number;

    function increment() external {
        number++;
    }

    function setNumber(uint256 n) external {
        number = n;
    }
}

/// @notice Accept-everything ERC-4337 v0.7 paymaster with an EntryPoint deposit, for required-paymaster tests.
contract SessionTestPaymaster is IPaymaster {
    IEntryPoint public immutable ENTRY_POINT;

    constructor(IEntryPoint entryPoint) {
        ENTRY_POINT = entryPoint;
    }

    function deposit() external payable {
        ENTRY_POINT.depositTo{value: msg.value}(address(this));
    }

    function validatePaymasterUserOp(PackedUserOperation calldata, bytes32, uint256)
        external
        view
        override
        returns (bytes memory context, uint256 validationData)
    {
        require(msg.sender == address(ENTRY_POINT), "not entrypoint");
        return ("", 0);
    }

    function postOp(PostOpMode, bytes calldata, uint256, uint256) external view override {
        require(msg.sender == address(ENTRY_POINT), "not entrypoint");
    }
}
