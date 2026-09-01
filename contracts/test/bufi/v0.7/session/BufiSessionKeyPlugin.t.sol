// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {SessionCounter, SessionKeyHarness, SessionTestPaymaster} from "../../../harness/SessionKeyHarness.sol";

import {BufiSessionKeyPlugin} from "../../../../src/bufi/v0.7/session/BufiSessionKeyPlugin.sol";
import {IBufiSessionKeyPlugin} from "../../../../src/bufi/v0.7/session/IBufiSessionKeyPlugin.sol";
import {SandboxUSDC} from "../../../../src/sandbox/SandboxUSDC.sol";

import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {InvalidValidationFunctionId, NotImplemented} from "@circle/msca/6900/shared/common/Errors.sol";
import {UpgradableMSCA} from "@circle/msca/6900/v0.7/account/UpgradableMSCA.sol";
import {Call} from "@circle/msca/6900/v0.7/common/Structs.sol";
import {IPlugin} from "@circle/msca/6900/v0.7/interfaces/IPlugin.sol";

/// @notice Port of alchemyplatform/modular-account v1.0.1 `test/plugin/session/**` (SessionKeyPluginWithMultiOwner,
///         SessionKeyPermissions, SessionKeyERC20SpendLimits, SessionKeyNativeTokenSpendLimits, SessionKeyGasLimits)
///         running on the REAL Circle `UpgradableMSCA` with a 2-of-3 WeightedWebauthnMultisigPlugin owner set.
///
///         Two systematic translations from the upstream suite:
///           - every owner action (`vm.prank(owner)` upstream) is a multisig-signed userOp here, because the
///             production dependency slots make the runtime path fail-closed on Circle;
///           - "AA23 reverted (or OOG)" upstream is EntryPoint v0.7's `FailedOpWithRevert(0, "AA23 reverted",
///             PermissionsCheckFailed())` here, and the gas-limit amounts follow v0.7's prefund formula.
contract BufiSessionKeyPluginTest is SessionKeyHarness {
    UpgradableMSCA internal account;
    Signer[] internal quorum;
    Signer internal sessionKey1;

    SessionCounter internal counter1;
    SessionCounter internal counter2;
    SandboxUSDC internal token1;
    SandboxUSDC internal token2;

    address payable internal recipient;
    address internal recipient1;
    address internal recipient2;
    address internal recipient3;

    uint256 internal constant TIME0 = 1_698_708_080;

    function setUp() public {
        _deployCircleCanonicalStack();
        _deploySessionKeyPlugin();

        (UpgradableMSCA msca, Signer[] memory q) = _createAccountWithSessionKeyPlugin("owner", bytes32(uint256(1)));
        account = msca;
        quorum.push(q[0]);
        quorum.push(q[1]);

        sessionKey1 = _signerFrom("sessionKey1");
        assertTrue(_addSessionKey(account, sessionKey1.addr, quorum), "add sessionKey1");

        counter1 = new SessionCounter();
        counter1.increment();
        counter2 = new SessionCounter();
        counter2.increment();
        token1 = new SandboxUSDC();
        token2 = new SandboxUSDC();

        recipient = payable(makeAddr("recipient"));
        recipient1 = makeAddr("recipient1");
        recipient2 = makeAddr("recipient2");
        recipient3 = makeAddr("recipient3");
        vm.deal(recipient, 1 wei);
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Key management (SessionKeyPluginWithMultiOwner.t.sol)                          ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    function test_sessionKey_addKeySuccess() public {
        address keyToAdd = makeAddr("sessionKey2");
        PackedUserOperation memory op =
            _prepareUserOp(account, _addSessionKeyCalldata(keyToAdd, bytes32(uint256(7)), new bytes[](0)), quorum);

        vm.expectEmit(true, true, true, true, address(sessionKeyPlugin));
        emit IBufiSessionKeyPlugin.SessionKeyAdded(address(account), keyToAdd, bytes32(uint256(7)));
        (bool ok,) = _runOp(op);
        assertTrue(ok);

        address[] memory keys = sessionKeyPlugin.sessionKeysOf(address(account));
        assertEq(keys.length, 2);
        assertEq(keys[0], keyToAdd);
        assertEq(keys[1], sessionKey1.addr);
        assertTrue(sessionKeyPlugin.isSessionKeyOf(address(account), keyToAdd));
    }

    function test_sessionKey_addKeyFailure_zeroAddress() public {
        (bool ok, bytes memory reason) = _executeOwnerUserOpWithReason(
            account, _addSessionKeyCalldata(address(0), bytes32(0), new bytes[](0)), quorum
        );
        assertFalse(ok);
        assertEq(reason, abi.encodeWithSelector(IBufiSessionKeyPlugin.InvalidSessionKey.selector, address(0)));
        assertEq(sessionKeyPlugin.sessionKeysOf(address(account)).length, 1);
    }

    function test_sessionKey_addKeyFailure_duplicate() public {
        (bool ok, bytes memory reason) = _executeOwnerUserOpWithReason(
            account, _addSessionKeyCalldata(sessionKey1.addr, bytes32(0), new bytes[](0)), quorum
        );
        assertFalse(ok);
        assertEq(reason, abi.encodeWithSelector(IBufiSessionKeyPlugin.InvalidSessionKey.selector, sessionKey1.addr));

        address[] memory keys = sessionKeyPlugin.sessionKeysOf(address(account));
        assertEq(keys.length, 1);
        assertEq(keys[0], sessionKey1.addr);
    }

    function test_sessionKey_addAndRemoveKeys() public {
        address key2 = makeAddr("sessionKey2");
        assertTrue(_addSessionKey(account, key2, quorum));

        address[] memory keys = sessionKeyPlugin.sessionKeysOf(address(account));
        assertEq(keys.length, 2);
        assertEq(keys[0], key2);
        assertEq(keys[1], sessionKey1.addr);

        bytes32 predecessor = sessionKeyPlugin.findPredecessor(address(account), sessionKey1.addr);
        PackedUserOperation memory op = _prepareUserOp(
            account, abi.encodeCall(IBufiSessionKeyPlugin.removeSessionKey, (sessionKey1.addr, predecessor)), quorum
        );
        vm.expectEmit(true, true, true, true, address(sessionKeyPlugin));
        emit IBufiSessionKeyPlugin.SessionKeyRemoved(address(account), sessionKey1.addr);
        (bool ok,) = _runOp(op);
        assertTrue(ok);

        keys = sessionKeyPlugin.sessionKeysOf(address(account));
        assertEq(keys.length, 1);
        assertEq(keys[0], key2);
        assertFalse(sessionKeyPlugin.isSessionKeyOf(address(account), sessionKey1.addr));
        assertTrue(sessionKeyPlugin.isSessionKeyOf(address(account), key2));
    }

    function testFuzz_sessionKey_addKeysDuringInstall(uint8 seed) public {
        assertTrue(_uninstallSessionKeyPlugin(account, quorum), "uninstall");
        assertFalse(_isInstalled(account, address(sessionKeyPlugin)));

        uint256 count = (seed % 16) + 1;
        address[] memory keys = new address[](count);
        bytes32[] memory tags = new bytes32[](count);
        for (uint256 i = 0; i < count; i++) {
            keys[i] = makeAddr(string.concat(vm.toString(seed), "sessionKey", vm.toString(i)));
            tags[i] = bytes32(uint256(i) + seed);
        }

        PackedUserOperation memory op = _prepareUserOp(
            account,
            _installPluginCalldata(
                address(sessionKeyPlugin),
                _sessionKeyInstallData(keys, tags, new bytes[][](count)),
                _sessionKeyDependencies()
            ),
            quorum
        );
        for (uint256 i = 0; i < count; i++) {
            vm.expectEmit(true, true, true, true, address(sessionKeyPlugin));
            emit IBufiSessionKeyPlugin.SessionKeyAdded(address(account), keys[i], tags[i]);
        }
        (bool ok,) = _runOp(op);
        assertTrue(ok, "reinstall with keys");

        address[] memory installed = sessionKeyPlugin.sessionKeysOf(address(account));
        assertEq(installed.length, count);
        for (uint256 i = 0; i < count; i++) {
            // The set iterates most-recent first.
            assertEq(installed[installed.length - 1 - i], keys[i]);
            assertTrue(sessionKeyPlugin.isSessionKeyOf(address(account), keys[i]));
        }
    }

    function test_sessionKey_rotate_valid() public {
        address key2 = makeAddr("sessionKey2");
        bytes32 predecessor = sessionKeyPlugin.findPredecessor(address(account), sessionKey1.addr);
        PackedUserOperation memory op = _prepareUserOp(
            account,
            abi.encodeCall(IBufiSessionKeyPlugin.rotateSessionKey, (sessionKey1.addr, predecessor, key2)),
            quorum
        );
        vm.expectEmit(true, true, true, true, address(sessionKeyPlugin));
        emit IBufiSessionKeyPlugin.SessionKeyRotated(address(account), sessionKey1.addr, key2);
        (bool ok,) = _runOp(op);
        assertTrue(ok);

        address[] memory keys = sessionKeyPlugin.sessionKeysOf(address(account));
        assertEq(keys.length, 1);
        assertEq(keys[0], key2);
        assertFalse(sessionKeyPlugin.isSessionKeyOf(address(account), sessionKey1.addr));
        assertTrue(sessionKeyPlugin.isSessionKeyOf(address(account), key2));
    }

    function test_sessionKey_rotate_existing() public {
        address key2 = makeAddr("sessionKey2");
        assertTrue(_addSessionKey(account, key2, quorum));

        bytes32 predecessor = sessionKeyPlugin.findPredecessor(address(account), sessionKey1.addr);
        (bool ok, bytes memory reason) = _executeOwnerUserOpWithReason(
            account,
            abi.encodeCall(IBufiSessionKeyPlugin.rotateSessionKey, (sessionKey1.addr, predecessor, key2)),
            quorum
        );
        assertFalse(ok);
        assertEq(reason, abi.encodeWithSelector(IBufiSessionKeyPlugin.InvalidSessionKey.selector, key2));
    }

    function test_sessionKey_rotate_invalid() public {
        bytes32 predecessor = sessionKeyPlugin.findPredecessor(address(account), sessionKey1.addr);
        (bool ok, bytes memory reason) = _executeOwnerUserOpWithReason(
            account,
            abi.encodeCall(IBufiSessionKeyPlugin.rotateSessionKey, (sessionKey1.addr, predecessor, address(0))),
            quorum
        );
        assertFalse(ok);
        assertEq(reason, abi.encodeWithSelector(IBufiSessionKeyPlugin.InvalidSessionKey.selector, address(0)));
    }

    function test_sessionKey_useSessionKey() public {
        assertTrue(_updateKeyPermissions(account, sessionKey1.addr, _permUnrestricted(), quorum));

        assertTrue(_executeSessionKeyUserOp(account, _calls(_nativeTransfer(recipient, 1 wei)), sessionKey1));
        assertEq(recipient.balance, 2 wei);
    }

    /// @dev Upstream expects `AlwaysDenyRule` here. Circle's BaseMSCA rejects the runtime path one step earlier:
    ///      `executeWithSessionKey` has no runtime validation function, so `_processPreRuntimeHooksAndValidation`
    ///      reverts `InvalidValidationFunctionId(0)` before the always-deny pre-runtime hook is even reached.
    function test_sessionKey_useSessionKey_failInRuntime() public {
        Call[] memory calls = _calls(_nativeTransfer(recipient, 1 wei));

        vm.prank(sessionKey1.addr);
        vm.expectRevert(abi.encodeWithSelector(InvalidValidationFunctionId.selector, uint8(0)));
        IBufiSessionKeyPlugin(address(account)).executeWithSessionKey(calls, sessionKey1.addr);

        vm.prank(quorum[0].addr);
        vm.expectRevert(abi.encodeWithSelector(InvalidValidationFunctionId.selector, uint8(0)));
        IBufiSessionKeyPlugin(address(account)).executeWithSessionKey(calls, sessionKey1.addr);
    }

    function testFuzz_sessionKey_userOpValidation_valid(uint16 seed) public {
        uint256[] memory privateKeys = _createSessionKeys(uint8(seed));
        uint256 signerKey = privateKeys[(seed >> 8) % privateKeys.length];
        address signer = vm.addr(signerKey);

        PackedUserOperation memory op =
            _buildSessionKeyUserOp(account, _calls(_nativeTransfer(recipient, 1 wei)), signer);
        op.signature = _signSessionKey(op, signerKey);
        bytes32 userOpHash = entryPoint.getUserOpHash(op);

        vm.prank(address(account));
        uint256 result = sessionKeyPlugin.userOpValidationFunction(
            uint8(IBufiSessionKeyPlugin.FunctionId.USER_OP_VALIDATION_SESSION_KEY), op, userOpHash
        );
        assertEq(result, 0);
    }

    function testFuzz_sessionKey_userOpValidation_mismatchedSig(uint8 sessionKeysSeed, uint64 signerSeed) public {
        _createSessionKeys(sessionKeysSeed);
        (address signer, uint256 signerKey) = makeAddrAndKey(string.concat("Signer", vm.toString(uint32(signerSeed))));
        vm.assume(!sessionKeyPlugin.isSessionKeyOf(address(account), signer));

        PackedUserOperation memory op =
            _buildSessionKeyUserOp(account, _calls(_nativeTransfer(recipient, 1 wei)), signer);
        op.signature = _signSessionKey(op, signerKey);
        bytes32 userOpHash = entryPoint.getUserOpHash(op);

        vm.prank(address(account));
        vm.expectRevert(IBufiSessionKeyPlugin.PermissionsCheckFailed.selector);
        sessionKeyPlugin.userOpValidationFunction(
            uint8(IBufiSessionKeyPlugin.FunctionId.USER_OP_VALIDATION_SESSION_KEY), op, userOpHash
        );
    }

    function test_sessionKey_userOpValidation_invalidSig() public {
        PackedUserOperation memory op =
            _buildSessionKeyUserOp(account, _calls(_nativeTransfer(recipient, 1 wei)), sessionKey1.addr);
        op.signature = "";
        bytes32 userOpHash = entryPoint.getUserOpHash(op);

        vm.prank(address(account));
        vm.expectRevert(abi.encodeWithSelector(IBufiSessionKeyPlugin.InvalidSignature.selector, sessionKey1.addr));
        sessionKeyPlugin.userOpValidationFunction(
            uint8(IBufiSessionKeyPlugin.FunctionId.USER_OP_VALIDATION_SESSION_KEY), op, userOpHash
        );
    }

    /// @dev A wrong signature over a registered key does not revert: it returns SIG_VALIDATION_FAILED, which the
    ///      EntryPoint reports as AA24.
    function test_sessionKey_userOpValidation_wrongSignerReturnsSigFailed() public {
        assertTrue(_updateKeyPermissions(account, sessionKey1.addr, _permUnrestricted(), quorum));
        Signer memory impostor = _signerFrom("impostor");

        PackedUserOperation memory op =
            _buildSessionKeyUserOp(account, _calls(_nativeTransfer(recipient, 1 wei)), sessionKey1.addr);
        op.signature = _signSessionKey(op, impostor.key);
        bytes32 userOpHash = entryPoint.getUserOpHash(op);

        vm.prank(address(account));
        uint256 result = sessionKeyPlugin.userOpValidationFunction(
            uint8(IBufiSessionKeyPlugin.FunctionId.USER_OP_VALIDATION_SESSION_KEY), op, userOpHash
        );
        assertEq(uint160(result), 1, "SIG_VALIDATION_FAILED");

        _expectHandleOpsRevert(op, _aa24());
    }

    function testFuzz_sessionKey_invalidFunctionId(uint8 functionId) public {
        vm.assume(functionId != uint8(IBufiSessionKeyPlugin.FunctionId.USER_OP_VALIDATION_SESSION_KEY));
        PackedUserOperation memory op =
            _buildSessionKeyUserOp(account, _calls(_nativeTransfer(recipient, 1 wei)), sessionKey1.addr);
        bytes32 userOpHash = entryPoint.getUserOpHash(op);

        vm.expectRevert(
            abi.encodeWithSelector(NotImplemented.selector, IPlugin.userOpValidationFunction.selector, functionId)
        );
        sessionKeyPlugin.userOpValidationFunction(functionId, op, userOpHash);
    }

    function test_sessionKey_getPredecessor_sentinel() public {
        address key2 = makeAddr("sessionKey2");
        assertTrue(_addSessionKey(account, key2, quorum));

        bytes32 predecessor = sessionKeyPlugin.findPredecessor(address(account), key2);
        assertEq(predecessor, bytes32(uint256(1)));

        assertTrue(
            _executeUserOp(account, abi.encodeCall(IBufiSessionKeyPlugin.removeSessionKey, (key2, predecessor)), quorum)
        );
        address[] memory keys = sessionKeyPlugin.sessionKeysOf(address(account));
        assertEq(keys.length, 1);
        assertEq(keys[0], sessionKey1.addr);
        assertFalse(sessionKeyPlugin.isSessionKeyOf(address(account), key2));
    }

    function test_sessionKey_getPredecessor_address() public {
        address key2 = makeAddr("sessionKey2");
        assertTrue(_addSessionKey(account, key2, quorum));

        bytes32 predecessor = sessionKeyPlugin.findPredecessor(address(account), sessionKey1.addr);
        assertEq(predecessor, bytes32(bytes20(key2)));

        assertTrue(
            _executeUserOp(
                account, abi.encodeCall(IBufiSessionKeyPlugin.removeSessionKey, (sessionKey1.addr, predecessor)), quorum
            )
        );
        address[] memory keys = sessionKeyPlugin.sessionKeysOf(address(account));
        assertEq(keys.length, 1);
        assertEq(keys[0], key2);
    }

    function test_sessionKey_getPredecessor_missing() public {
        address key2 = makeAddr("sessionKey2");
        vm.expectRevert(abi.encodeWithSelector(IBufiSessionKeyPlugin.SessionKeyNotFound.selector, key2));
        sessionKeyPlugin.findPredecessor(address(account), key2);
    }

    function test_sessionKey_removeWithWrongPredecessorFails() public {
        (bool ok, bytes memory reason) = _executeOwnerUserOpWithReason(
            account,
            abi.encodeCall(IBufiSessionKeyPlugin.removeSessionKey, (sessionKey1.addr, bytes32(bytes20(recipient1)))),
            quorum
        );
        assertFalse(ok);
        assertEq(reason, abi.encodeWithSelector(IBufiSessionKeyPlugin.InvalidSessionKey.selector, sessionKey1.addr));
        assertTrue(sessionKeyPlugin.isSessionKeyOf(address(account), sessionKey1.addr));
    }

    function test_sessionKey_doesNotContainSentinelValue() public view {
        assertFalse(sessionKeyPlugin.isSessionKeyOf(address(account), address(1)));
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Permissions (SessionKeyPermissions.t.sol)                                      ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    function test_sessionPerms_validateSetUp() public view {
        assertEq(
            uint8(sessionKeyPlugin.getAccessControlType(address(account), sessionKey1.addr)),
            uint8(IBufiSessionKeyPlugin.ContractAccessControlType.ALLOWLIST)
        );
    }

    function test_sessionPerms_contractDefaultAllowList() public {
        Call[] memory calls = _calls(_call(address(counter1), 0, abi.encodeCall(SessionCounter.increment, ())));
        _expectSessionKeyValidationRevert(account, calls, sessionKey1, _aa23PermissionsCheckFailed());
        assertEq(counter1.number(), 1);

        assertTrue(_updateKeyPermissions(account, sessionKey1.addr, _updates(_permAllowAll()), quorum));

        assertTrue(_executeSessionKeyUserOp(account, calls, sessionKey1));
        assertEq(counter1.number(), 2);
    }

    function test_sessionPerms_contractAllowList() public {
        (bool isOnList, bool checkSelectors) =
            sessionKeyPlugin.getAccessControlEntry(address(account), sessionKey1.addr, address(counter1));
        assertFalse(isOnList);
        assertFalse(checkSelectors);

        assertTrue(
            _updateKeyPermissions(
                account, sessionKey1.addr, _updates(_permAddressEntry(address(counter1), true, false)), quorum
            )
        );
        (isOnList, checkSelectors) =
            sessionKeyPlugin.getAccessControlEntry(address(account), sessionKey1.addr, address(counter1));
        assertTrue(isOnList);
        assertFalse(checkSelectors);

        bytes memory increment = abi.encodeCall(SessionCounter.increment, ());
        assertTrue(_executeSessionKeyUserOp(account, _calls(_call(address(counter1), 0, increment)), sessionKey1));
        assertEq(counter1.number(), 2);

        _expectSessionKeyValidationRevert(
            account, _calls(_call(address(counter2), 0, increment)), sessionKey1, _aa23PermissionsCheckFailed()
        );
        assertEq(counter2.number(), 1);
    }

    function test_sessionPerms_contractDenyList() public {
        assertTrue(
            _updateKeyPermissions(
                account,
                sessionKey1.addr,
                _updates(
                    _permAccessListType(IBufiSessionKeyPlugin.ContractAccessControlType.DENYLIST),
                    _permAddressEntry(address(counter1), true, false)
                ),
                quorum
            )
        );

        bytes memory increment = abi.encodeCall(SessionCounter.increment, ());
        _expectSessionKeyValidationRevert(
            account, _calls(_call(address(counter1), 0, increment)), sessionKey1, _aa23PermissionsCheckFailed()
        );
        assertEq(counter1.number(), 1);

        assertTrue(_executeSessionKeyUserOp(account, _calls(_call(address(counter2), 0, increment)), sessionKey1));
        assertEq(counter2.number(), 2);
    }

    function test_sessionPerms_selectorAllowList() public {
        assertFalse(
            sessionKeyPlugin.isSelectorOnAccessControlList(
                address(account), sessionKey1.addr, address(counter1), SessionCounter.increment.selector
            )
        );
        assertTrue(
            _updateKeyPermissions(
                account,
                sessionKey1.addr,
                _updates(
                    _permAddressEntry(address(counter1), true, true),
                    _permFunctionEntry(address(counter1), SessionCounter.increment.selector, true)
                ),
                quorum
            )
        );
        (bool isOnList, bool checkSelectors) =
            sessionKeyPlugin.getAccessControlEntry(address(account), sessionKey1.addr, address(counter1));
        assertTrue(isOnList);
        assertTrue(checkSelectors);
        assertTrue(
            sessionKeyPlugin.isSelectorOnAccessControlList(
                address(account), sessionKey1.addr, address(counter1), SessionCounter.increment.selector
            )
        );

        assertTrue(
            _executeSessionKeyUserOp(
                account, _calls(_call(address(counter1), 0, abi.encodeCall(SessionCounter.increment, ()))), sessionKey1
            )
        );
        assertEq(counter1.number(), 2);

        _expectSessionKeyValidationRevert(
            account,
            _calls(_call(address(counter1), 0, abi.encodeCall(SessionCounter.setNumber, (5)))),
            sessionKey1,
            _aa23PermissionsCheckFailed()
        );
        assertEq(counter1.number(), 2);
    }

    function test_sessionPerms_selectorDenyList() public {
        assertTrue(
            _updateKeyPermissions(
                account,
                sessionKey1.addr,
                _updates(
                    _permAccessListType(IBufiSessionKeyPlugin.ContractAccessControlType.DENYLIST),
                    _permAddressEntry(address(counter1), true, true),
                    _permFunctionEntry(address(counter1), SessionCounter.increment.selector, true)
                ),
                quorum
            )
        );

        _expectSessionKeyValidationRevert(
            account,
            _calls(_call(address(counter1), 0, abi.encodeCall(SessionCounter.increment, ()))),
            sessionKey1,
            _aa23PermissionsCheckFailed()
        );
        assertEq(counter1.number(), 1);

        assertTrue(
            _executeSessionKeyUserOp(
                account, _calls(_call(address(counter1), 0, abi.encodeCall(SessionCounter.setNumber, (5)))), sessionKey1
            )
        );
        assertEq(counter1.number(), 5);
    }

    /// @dev Circle's `ValidationDataLib._intersectValidationData` reverts `WrongTimeBounds` for validAfter >
    ///      validUntil and flags validAfter >= validUntil as SIG_FAIL, so only well-formed ranges are fuzzed.
    function testFuzz_sessionKeyTimeRange(uint48 startTime, uint48 endTime) public {
        vm.assume(endTime == 0 || startTime < endTime);
        assertTrue(
            _updateKeyPermissions(
                account, sessionKey1.addr, _updates(_permTimeRange(startTime, endTime), _permAllowAll()), quorum
            )
        );
        (uint48 gotStart, uint48 gotEnd) = sessionKeyPlugin.getKeyTimeRange(address(account), sessionKey1.addr);
        assertEq(gotStart, startTime);
        assertEq(gotEnd, endTime);

        PackedUserOperation memory op = _prepareSessionKeyUserOp(account, _calls(_call(address(0), 0, "")), sessionKey1);
        uint256 validationData = _validateAsEntryPoint(account, op);

        if (endTime != 0) {
            assertEq(uint48(validationData >> 160), endTime, "validUntil");
        } else {
            assertEq(uint48(validationData >> 160), type(uint48).max, "validUntil (0 repacked as max by Circle)");
        }
        assertEq(uint48(validationData >> 208), startTime, "validAfter");
        assertEq(uint160(validationData), 0, "authorizer");
    }

    function test_rotateKey_basic() public {
        assertTrue(_updateKeyPermissions(account, sessionKey1.addr, _updates(_permAllowAll()), quorum));
        Signer memory sessionKey2 = _signerFrom("sessionKey2");
        assertTrue(_rotateSessionKey(account, sessionKey1.addr, sessionKey2.addr, quorum));

        Call[] memory calls = _calls(_call(address(counter1), 0, abi.encodeCall(SessionCounter.increment, ())));
        _expectSessionKeyValidationRevert(account, calls, sessionKey1, _aa23PermissionsCheckFailed());
        assertTrue(_executeSessionKeyUserOp(account, calls, sessionKey2));
        assertEq(counter1.number(), 2);
    }

    function test_rotateKey_permissionsTransfer() public {
        uint48 startTime = uint48(block.timestamp);
        uint48 endTime = uint48(block.timestamp + 1000);
        assertTrue(
            _updateKeyPermissions(account, sessionKey1.addr, _updates(_permTimeRange(startTime, endTime)), quorum)
        );
        address sessionKey2 = makeAddr("sessionKey2");
        assertTrue(_rotateSessionKey(account, sessionKey1.addr, sessionKey2, quorum));

        (uint48 gotStart, uint48 gotEnd) = sessionKeyPlugin.getKeyTimeRange(address(account), sessionKey2);
        assertEq(gotStart, startTime);
        assertEq(gotEnd, endTime);
    }

    function testFuzz_sessionKeyPermissions_setRequiredPaymaster(address requiredPaymaster) public {
        assertTrue(
            _updateKeyPermissions(
                account, sessionKey1.addr, _updates(_permRequiredPaymaster(requiredPaymaster)), quorum
            )
        );
        assertEq(sessionKeyPlugin.getRequiredPaymaster(address(account), sessionKey1.addr), requiredPaymaster);

        assertTrue(
            _updateKeyPermissions(account, sessionKey1.addr, _updates(_permRequiredPaymaster(address(0))), quorum)
        );
        assertEq(sessionKeyPlugin.getRequiredPaymaster(address(account), sessionKey1.addr), address(0));
    }

    function testFuzz_sessionKeyPermissions_checkRequiredPaymaster(address requiredPaymaster, address providedPaymaster)
        public
    {
        vm.assume(providedPaymaster != address(0));
        assertTrue(_updateKeyPermissions(account, sessionKey1.addr, _permUnrestricted(), quorum));

        PackedUserOperation memory op = _buildSessionKeyUserOpWithGas(
            account,
            _calls(_nativeTransfer(recipient, 1 wei)),
            sessionKey1.addr,
            SK_VERIFICATION_GAS,
            SK_CALL_GAS,
            0,
            SK_MAX_FEE,
            SK_MAX_PRIORITY_FEE,
            _paymasterAndData(providedPaymaster, 0, 0)
        );
        op.signature = _signSessionKey(op, sessionKey1.key);

        // Without the rule, any paymaster passes.
        assertEq(uint160(_validateAsEntryPoint(account, op)), 0);

        assertTrue(
            _updateKeyPermissions(
                account, sessionKey1.addr, _updates(_permRequiredPaymaster(requiredPaymaster)), quorum
            )
        );

        bytes32 userOpHash = entryPoint.getUserOpHash(op);
        if (requiredPaymaster == providedPaymaster || requiredPaymaster == address(0)) {
            assertEq(uint160(_validateAsEntryPoint(account, op)), 0);
        } else {
            vm.prank(address(entryPoint));
            vm.expectRevert(IBufiSessionKeyPlugin.PermissionsCheckFailed.selector);
            account.validateUserOp(op, userOpHash, 0);
        }
    }

    /// @dev EntryPoint v0.7 rejects any non-empty paymasterAndData shorter than 52 bytes before validation runs.
    function test_sessionKeyPerms_requiredPaymaster_partialAddressFails() public {
        address paymasterAddr = 0x1234123412341234000000000000000000000000;
        assertTrue(
            _updateKeyPermissions(
                account, sessionKey1.addr, _updates(_permAllowAll(), _permRequiredPaymaster(paymasterAddr)), quorum
            )
        );
        PackedUserOperation memory op = _buildSessionKeyUserOpWithGas(
            account,
            _calls(_nativeTransfer(recipient, 1 wei)),
            sessionKey1.addr,
            SK_VERIFICATION_GAS,
            SK_CALL_GAS,
            0,
            SK_MAX_FEE,
            SK_MAX_PRIORITY_FEE,
            abi.encodePacked(uint64(0x1234123412341234))
        );
        op.signature = _signSessionKey(op, sessionKey1.key);
        _expectHandleOpsRevert(op, abi.encodeWithSignature("Error(string)", "AA93 invalid paymasterAndData"));
    }

    /// @dev Full `handleOps` flow with a real (accept-all) v0.7 paymaster: the required-paymaster rule passes for
    ///      the configured paymaster, and rejects a self-funded op and an op sponsored by a different paymaster.
    function test_sessionKeyPerms_requiredPaymaster_liveFlow() public {
        SessionTestPaymaster paymaster = new SessionTestPaymaster(entryPoint);
        paymaster.deposit{value: 10 ether}();
        SessionTestPaymaster other = new SessionTestPaymaster(entryPoint);
        other.deposit{value: 10 ether}();

        assertTrue(
            _updateKeyPermissions(
                account,
                sessionKey1.addr,
                _updates(_permAllowAll(), _permNativeUnlimited(), _permRequiredPaymaster(address(paymaster))),
                quorum
            )
        );

        PackedUserOperation memory op = _buildSessionKeyUserOpWithGas(
            account,
            _calls(_nativeTransfer(recipient, 1 wei)),
            sessionKey1.addr,
            SK_VERIFICATION_GAS,
            SK_CALL_GAS,
            0,
            SK_MAX_FEE,
            SK_MAX_PRIORITY_FEE,
            _paymasterAndData(address(paymaster), 200_000, 100_000)
        );
        op.signature = _signSessionKey(op, sessionKey1.key);
        (bool ok,) = _runOp(op);
        assertTrue(ok, "sponsored by the required paymaster");
        assertEq(recipient.balance, 2 wei);

        // Self-funded: rejected.
        _expectSessionKeyValidationRevert(
            account, _calls(_nativeTransfer(recipient, 1 wei)), sessionKey1, _aa23PermissionsCheckFailed()
        );

        // Sponsored by another paymaster: rejected.
        op = _buildSessionKeyUserOpWithGas(
            account,
            _calls(_nativeTransfer(recipient, 1 wei)),
            sessionKey1.addr,
            SK_VERIFICATION_GAS,
            SK_CALL_GAS,
            0,
            SK_MAX_FEE,
            SK_MAX_PRIORITY_FEE,
            _paymasterAndData(address(other), 200_000, 100_000)
        );
        op.signature = _signSessionKey(op, sessionKey1.key);
        _expectHandleOpsRevert(op, _aa23PermissionsCheckFailed());
        assertEq(recipient.balance, 2 wei);
    }

    function test_sessionKeyPerms_updatePermissions_invalidUpdates() public {
        bytes[] memory updates = new bytes[](1);
        updates[0] = hex"112233"; // < 4 bytes
        (bool ok, bytes memory reason) = _executeOwnerUserOpWithReason(
            account, abi.encodeCall(IBufiSessionKeyPlugin.updateKeyPermissions, (sessionKey1.addr, updates)), quorum
        );
        assertFalse(ok);
        assertEq(
            reason, abi.encodeWithSelector(IBufiSessionKeyPlugin.InvalidPermissionsUpdate.selector, bytes4(updates[0]))
        );

        updates[0] = hex"11223344"; // unknown selector
        (ok, reason) = _executeOwnerUserOpWithReason(
            account, abi.encodeCall(IBufiSessionKeyPlugin.updateKeyPermissions, (sessionKey1.addr, updates)), quorum
        );
        assertFalse(ok);
        assertEq(
            reason, abi.encodeWithSelector(IBufiSessionKeyPlugin.InvalidPermissionsUpdate.selector, bytes4(updates[0]))
        );
    }

    function test_sessionKeyPerms_updateUnknownKeyFails() public {
        address unknown = makeAddr("unknown");
        (bool ok, bytes memory reason) = _executeOwnerUserOpWithReason(
            account,
            abi.encodeCall(IBufiSessionKeyPlugin.updateKeyPermissions, (unknown, _updates(_permAllowAll()))),
            quorum
        );
        assertFalse(ok);
        assertEq(reason, abi.encodeWithSelector(IBufiSessionKeyPlugin.InvalidSessionKey.selector, unknown));
    }

    function test_sessionKeyPerms_independentKeyStorage() public {
        address sessionKey2 = makeAddr("sessionKey2");
        assertTrue(_addSessionKey(account, sessionKey2, quorum));

        assertEq(
            uint8(sessionKeyPlugin.getAccessControlType(address(account), sessionKey1.addr)),
            uint8(IBufiSessionKeyPlugin.ContractAccessControlType.ALLOWLIST)
        );
        assertEq(
            uint8(sessionKeyPlugin.getAccessControlType(address(account), sessionKey2)),
            uint8(IBufiSessionKeyPlugin.ContractAccessControlType.ALLOWLIST)
        );

        assertTrue(_updateKeyPermissions(account, sessionKey1.addr, _updates(_permAllowAll()), quorum));

        assertEq(
            uint8(sessionKeyPlugin.getAccessControlType(address(account), sessionKey1.addr)),
            uint8(IBufiSessionKeyPlugin.ContractAccessControlType.ALLOW_ALL_ACCESS)
        );
        assertEq(
            uint8(sessionKeyPlugin.getAccessControlType(address(account), sessionKey2)),
            uint8(IBufiSessionKeyPlugin.ContractAccessControlType.ALLOWLIST)
        );
    }

    function test_sessionKeyPerms_reinstallResets() public {
        assertTrue(_updateKeyPermissions(account, sessionKey1.addr, _updates(_permTimeRange(2000, 3000)), quorum));
        (uint48 gotStart, uint48 gotEnd) = sessionKeyPlugin.getKeyTimeRange(address(account), sessionKey1.addr);
        assertEq(gotStart, 2000);
        assertEq(gotEnd, 3000);

        assertTrue(_uninstallSessionKeyPlugin(account, quorum));
        assertTrue(_installSessionKeyPlugin(account, quorum));
        assertTrue(_addSessionKey(account, sessionKey1.addr, quorum));

        (gotStart, gotEnd) = sessionKeyPlugin.getKeyTimeRange(address(account), sessionKey1.addr);
        assertEq(gotStart, 0);
        assertEq(gotEnd, 0);
    }

    function test_initialSessionKeysWithPermissions() public {
        assertTrue(_uninstallSessionKeyPlugin(account, quorum));

        address[] memory keys = new address[](2);
        keys[0] = makeAddr("k1");
        keys[1] = makeAddr("k2");
        bytes32[] memory tags = new bytes32[](2);
        tags[0] = bytes32(uint256(1));
        tags[1] = bytes32(uint256(2));
        bytes[][] memory permissions = new bytes[][](2);
        permissions[0] = _updates(_permAllowAll());
        permissions[1] = _updates(_permTimeRange(100, 200), _permNativeLimit(5 ether, 1 days));

        PackedUserOperation memory op = _prepareUserOp(
            account,
            _installPluginCalldata(
                address(sessionKeyPlugin), _sessionKeyInstallData(keys, tags, permissions), _sessionKeyDependencies()
            ),
            quorum
        );
        for (uint256 i = 0; i < 2; i++) {
            vm.expectEmit(true, true, true, true, address(sessionKeyPlugin));
            emit IBufiSessionKeyPlugin.SessionKeyAdded(address(account), keys[i], tags[i]);
            vm.expectEmit(true, true, true, true, address(sessionKeyPlugin));
            emit IBufiSessionKeyPlugin.PermissionsUpdated(address(account), keys[i], permissions[i]);
        }
        (bool ok,) = _runOp(op);
        assertTrue(ok);

        assertEq(
            uint8(sessionKeyPlugin.getAccessControlType(address(account), keys[0])),
            uint8(IBufiSessionKeyPlugin.ContractAccessControlType.ALLOW_ALL_ACCESS)
        );
        (uint48 gotStart, uint48 gotEnd) = sessionKeyPlugin.getKeyTimeRange(address(account), keys[1]);
        assertEq(gotStart, 100);
        assertEq(gotEnd, 200);
        IBufiSessionKeyPlugin.SpendLimitInfo memory info =
            sessionKeyPlugin.getNativeTokenSpendLimitInfo(address(account), keys[1]);
        assertTrue(info.hasLimit);
        assertEq(info.limit, 5 ether);
        assertEq(info.refreshInterval, 1 days);
    }

    function test_install_lengthMismatchReverts() public {
        assertTrue(_uninstallSessionKeyPlugin(account, quorum));
        address[] memory keys = new address[](2);
        keys[0] = makeAddr("k1");
        keys[1] = makeAddr("k2");
        (bool ok,) = _executeOwnerUserOpWithReason(
            account,
            _installPluginCalldata(
                address(sessionKeyPlugin),
                _sessionKeyInstallData(keys, new bytes32[](1), new bytes[][](2)),
                _sessionKeyDependencies()
            ),
            quorum
        );
        assertFalse(ok, "install with mismatched lengths must fail");
        assertFalse(_isInstalled(account, address(sessionKeyPlugin)));
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  ERC-20 spend limits (SessionKeyERC20SpendLimits.t.sol)                         ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    function _allowAllForErc20() internal {
        assertTrue(_updateKeyPermissions(account, sessionKey1.addr, _updates(_permAllowAll()), quorum));
    }

    function _setErc20Limit(address token, uint256 limit, uint48 interval) internal {
        assertTrue(
            _updateKeyPermissions(account, sessionKey1.addr, _updates(_permErc20Limit(token, limit, interval)), quorum)
        );
    }

    function _erc20Info(address token) internal view returns (IBufiSessionKeyPlugin.SpendLimitInfo memory) {
        return sessionKeyPlugin.getERC20SpendLimitInfo(address(account), sessionKey1.addr, token);
    }

    function _assertErc20Info(address token, uint256 limit, uint256 used, uint48 interval, uint48 lastUsed)
        internal
        view
    {
        IBufiSessionKeyPlugin.SpendLimitInfo memory info = _erc20Info(token);
        assertEq(info.limit, limit, "limit");
        assertEq(info.limitUsed, used, "limitUsed");
        assertEq(info.refreshInterval, interval, "refreshInterval");
        assertEq(info.lastUsedTime, lastUsed, "lastUsedTime");
    }

    function _expectErc20Exceeded(address token) internal pure returns (bytes memory) {
        return
            abi.encodeWithSelector(
                IBufiSessionKeyPlugin.ERC20SpendLimitExceeded.selector, address(0), address(0), token
            );
    }

    function testFuzz_sessionKeyERC20SpendLimits_setLimits(
        address token,
        uint256 limit,
        uint48 interval,
        uint48 timestamp
    ) public {
        vm.assume(token != address(0));
        vm.warp(timestamp);
        _allowAllForErc20();

        IBufiSessionKeyPlugin.SpendLimitInfo memory info = _erc20Info(token);
        assertFalse(info.hasLimit);
        assertEq(info.limit, 0);

        _setErc20Limit(token, limit, interval);
        info = _erc20Info(token);
        if (limit == type(uint256).max) {
            assertFalse(info.hasLimit);
            assertEq(info.limit, 0);
            assertEq(info.refreshInterval, 0);
            assertEq(info.limitUsed, 0);
        } else {
            assertTrue(info.hasLimit);
            assertEq(info.limit, limit);
            assertEq(info.refreshInterval, interval);
            assertEq(info.limitUsed, 0);
            assertEq(info.lastUsedTime, interval == 0 ? 0 : timestamp);
        }
    }

    function test_sessionKeyERC20SpendLimits_tokenAddressZeroFails() public {
        (bool ok, bytes memory reason) = _executeOwnerUserOpWithReason(
            account,
            abi.encodeCall(
                IBufiSessionKeyPlugin.updateKeyPermissions,
                (sessionKey1.addr, _updates(_permErc20Limit(address(0), 1000, 0)))
            ),
            quorum
        );
        assertFalse(ok);
        assertEq(reason, abi.encodeWithSelector(IBufiSessionKeyPlugin.InvalidToken.selector, address(0)));
    }

    function test_sessionKeyERC20SpendLimits_unknownSelectorFails() public {
        _allowAllForErc20();
        token1.mint(address(account), 100e6);
        _setErc20Limit(address(token1), 1e6, 0);

        _expectSessionKeyValidationRevert(
            account,
            _calls(_call(address(token1), 0, abi.encodeCall(token1.name, ()))),
            sessionKey1,
            _aa23PermissionsCheckFailed()
        );
    }

    function test_sessionKeyERC20SpendLimits_enforceLimit_none_basic() public {
        _allowAllForErc20();
        token1.mint(address(account), 100e6);
        _setErc20Limit(address(token1), 0, 0);

        // Execution-phase failure: the EntryPoint does not revert, the op reports failure with the plugin's error.
        (bool ok, bytes memory reason) = _executeSessionKeyUserOpWithReason(
            account, _calls(_erc20Transfer(address(token1), recipient1, 1)), sessionKey1
        );
        assertFalse(ok);
        assertEq(
            reason,
            abi.encodeWithSelector(
                IBufiSessionKeyPlugin.ERC20SpendLimitExceeded.selector,
                address(account),
                sessionKey1.addr,
                address(token1)
            )
        );
        assertEq(token1.balanceOf(recipient1), 0);

        assertTrue(
            _executeSessionKeyUserOp(account, _calls(_erc20Transfer(address(token1), recipient1, 0)), sessionKey1)
        );
    }

    function test_sessionKeyERC20SpendLimits_enforceLimit_none_batch() public {
        _allowAllForErc20();
        token1.mint(address(account), 100e6);
        _setErc20Limit(address(token1), 0, 0);

        assertTrue(
            _executeSessionKeyUserOp(
                account,
                _calls(
                    _erc20Transfer(address(token1), recipient1, 0),
                    _erc20Transfer(address(token1), recipient1, 0),
                    _erc20Approve(address(token1), recipient1, 0)
                ),
                sessionKey1
            )
        );
    }

    function test_sessionKeyERC20SpendLimits_basic_single_and_exceed() public {
        _allowAllForErc20();
        token1.mint(address(account), 100e6);
        _setErc20Limit(address(token1), 1e6, 0);

        assertTrue(
            _executeSessionKeyUserOp(account, _calls(_erc20Transfer(address(token1), recipient1, 1)), sessionKey1)
        );
        assertEq(token1.balanceOf(recipient1), 1);
        _assertErc20Info(address(token1), 1e6, 1, 0, 0);

        (bool ok,) = _executeSessionKeyUserOpWithReason(
            account, _calls(_erc20Transfer(address(token1), recipient1, 1e6)), sessionKey1
        );
        assertFalse(ok);
        assertEq(token1.balanceOf(recipient1), 1);
        _assertErc20Info(address(token1), 1e6, 1, 0, 0);
    }

    function test_executeWithSessionKey_success_multipleTransfer() public {
        _allowAllForErc20();
        token1.mint(address(account), 100e6);
        _setErc20Limit(address(token1), 1e6, 0);

        assertTrue(
            _executeSessionKeyUserOp(
                account,
                _calls(
                    _erc20Transfer(address(token1), recipient1, 1),
                    _erc20Transfer(address(token1), recipient1, 1),
                    _erc20Transfer(address(token1), recipient2, 1)
                ),
                sessionKey1
            )
        );
        assertEq(token1.balanceOf(recipient1), 2);
        assertEq(token1.balanceOf(recipient2), 1);
        _assertErc20Info(address(token1), 1e6, 3, 0, 0);
    }

    function test_executeWithSessionKey_approveAlwaysCountsFullAmount() public {
        _allowAllForErc20();
        token1.mint(address(account), 100e6);
        vm.prank(address(account));
        token1.approve(recipient1, 0.5e6);
        _setErc20Limit(address(token1), 1e6, 0);

        assertTrue(
            _executeSessionKeyUserOp(account, _calls(_erc20Approve(address(token1), recipient1, 1e6)), sessionKey1)
        );
        assertEq(token1.allowance(address(account), recipient1), 1e6);
        _assertErc20Info(address(token1), 1e6, 1e6, 0, 0);
    }

    function test_executeWithSessionKey_success_multipleSpendFunctions_multipleTokens() public {
        _allowAllForErc20();
        token1.mint(address(account), 100e6);
        token2.mint(address(account), 100e6);
        assertTrue(
            _updateKeyPermissions(
                account,
                sessionKey1.addr,
                _updates(_permErc20Limit(address(token1), 1e6, 0), _permErc20Limit(address(token2), 1e6, 0)),
                quorum
            )
        );

        assertTrue(
            _executeSessionKeyUserOp(
                account,
                _calls(
                    _erc20Transfer(address(token1), recipient1, 1),
                    _erc20Approve(address(token2), address(account), 1),
                    _erc20Transfer(address(token2), recipient2, 1)
                ),
                sessionKey1
            )
        );
        _assertErc20Info(address(token1), 1e6, 1, 0, 0);
        _assertErc20Info(address(token2), 1e6, 2, 0, 0);
    }

    function test_executeWithSessionKey_failWithExceedLimit_batchIsAtomic() public {
        _allowAllForErc20();
        token1.mint(address(account), 100e6);
        _setErc20Limit(address(token1), 1, 0);

        (bool ok,) = _executeSessionKeyUserOpWithReason(
            account,
            _calls(_erc20Transfer(address(token1), recipient1, 1), _erc20Transfer(address(token1), recipient2, 1)),
            sessionKey1
        );
        assertFalse(ok);
        assertEq(token1.balanceOf(recipient1), 0, "first transfer rolled back with the batch");
        assertEq(token1.balanceOf(recipient2), 0);
        _assertErc20Info(address(token1), 1, 0, 0, 0);
    }

    function test_executeWithSessionKey_failWithExceedLimit_overflow() public {
        _allowAllForErc20();
        token1.mint(address(account), 100e6);
        _setErc20Limit(address(token1), 1, 0);

        (bool ok,) = _executeSessionKeyUserOpWithReason(
            account,
            _calls(
                _erc20Transfer(address(token1), recipient1, type(uint256).max),
                _erc20Approve(address(token1), address(account), type(uint256).max)
            ),
            sessionKey1
        );
        assertFalse(ok);
        _assertErc20Info(address(token1), 1, 0, 0, 0);
    }

    function test_executeWithSessionKey_failWithExceedLimit_multipleTokens() public {
        _allowAllForErc20();
        token1.mint(address(account), 100e6);
        token2.mint(address(account), 100e6);
        assertTrue(
            _updateKeyPermissions(
                account,
                sessionKey1.addr,
                _updates(_permErc20Limit(address(token1), 1, 0), _permErc20Limit(address(token2), 1, 0)),
                quorum
            )
        );
        (bool ok,) = _executeSessionKeyUserOpWithReason(
            account,
            _calls(
                _erc20Transfer(address(token1), recipient1, 2),
                _erc20Approve(address(token2), address(account), 2),
                _erc20Transfer(address(token2), recipient2, 1)
            ),
            sessionKey1
        );
        assertFalse(ok);
        _assertErc20Info(address(token1), 1, 0, 0, 0);
        _assertErc20Info(address(token2), 1, 0, 0, 0);
    }

    function test_executeWithSessionKey_refreshInterval_singleTransfer() public {
        vm.warp(TIME0);
        _allowAllForErc20();
        token1.mint(address(account), 100e6);
        _setErc20Limit(address(token1), 1e6, 1 days);

        assertTrue(
            _executeSessionKeyUserOp(account, _calls(_erc20Transfer(address(token1), recipient1, 1)), sessionKey1)
        );
        _assertErc20Info(address(token1), 1e6, 1, 1 days, uint48(TIME0));

        (bool ok,) = _executeSessionKeyUserOpWithReason(
            account, _calls(_erc20Approve(address(token1), recipient1, 1e6)), sessionKey1
        );
        assertFalse(ok);
        _assertErc20Info(address(token1), 1e6, 1, 1 days, uint48(TIME0));

        vm.warp(TIME0 + 1 days);
        assertTrue(
            _executeSessionKeyUserOp(account, _calls(_erc20Transfer(address(token1), recipient1, 1e6)), sessionKey1)
        );
        _assertErc20Info(address(token1), 1e6, 1e6, 1 days, uint48(TIME0 + 1 days));
    }

    function test_executeWithSessionKey_refreshInterval_multipleTransfer() public {
        vm.warp(TIME0);
        _allowAllForErc20();
        token1.mint(address(account), 100e6);
        _setErc20Limit(address(token1), 1e6, 1 days);

        assertTrue(
            _executeSessionKeyUserOp(
                account,
                _calls(_erc20Transfer(address(token1), recipient1, 1), _erc20Transfer(address(token1), recipient1, 1)),
                sessionKey1
            )
        );
        _assertErc20Info(address(token1), 1e6, 2, 1 days, uint48(TIME0));

        (bool ok,) = _executeSessionKeyUserOpWithReason(
            account, _calls(_erc20Transfer(address(token1), recipient1, 1e6)), sessionKey1
        );
        assertFalse(ok);
        _assertErc20Info(address(token1), 1e6, 2, 1 days, uint48(TIME0));

        vm.warp(TIME0 + 1 days);
        assertTrue(
            _executeSessionKeyUserOp(
                account,
                _calls(
                    _erc20Transfer(address(token1), recipient1, 0.5e6),
                    _erc20Transfer(address(token1), recipient1, 0.5e6)
                ),
                sessionKey1
            )
        );
        _assertErc20Info(address(token1), 1e6, 1e6, 1 days, uint48(TIME0 + 1 days));
    }

    function test_executeWithSessionKey_refreshInterval_failWithSomeTokenLimit() public {
        vm.warp(TIME0);
        _allowAllForErc20();
        token1.mint(address(account), 100e6);
        token2.mint(address(account), 100e6);
        assertTrue(
            _updateKeyPermissions(
                account,
                sessionKey1.addr,
                _updates(_permErc20Limit(address(token1), 1e6, 1 days), _permErc20Limit(address(token2), 1e6, 10 days)),
                quorum
            )
        );

        assertTrue(
            _executeSessionKeyUserOp(
                account,
                _calls(
                    _erc20Transfer(address(token1), recipient1, 1e6), _erc20Transfer(address(token2), recipient1, 1e6)
                ),
                sessionKey1
            )
        );

        vm.warp(TIME0 + 1 days);
        (bool ok,) = _executeSessionKeyUserOpWithReason(
            account,
            _calls(_erc20Transfer(address(token1), recipient1, 1), _erc20Transfer(address(token2), recipient1, 1)),
            sessionKey1
        );
        assertFalse(ok, "token2 interval has not rolled over");
        _assertErc20Info(address(token1), 1e6, 1e6, 1 days, uint48(TIME0));
        _assertErc20Info(address(token2), 1e6, 1e6, 10 days, uint48(TIME0));

        vm.warp(TIME0 + 10 days);
        assertTrue(
            _executeSessionKeyUserOp(
                account,
                _calls(
                    _erc20Approve(address(token1), recipient1, 1e6), _erc20Approve(address(token2), recipient1, 1e6)
                ),
                sessionKey1
            )
        );
        _assertErc20Info(address(token1), 1e6, 1e6, 1 days, uint48(TIME0 + 10 days));
        _assertErc20Info(address(token2), 1e6, 1e6, 10 days, uint48(TIME0 + 10 days));
    }

    function test_sessionKeyERC20Limits_refreshInterval_failWithExceedNextLimit() public {
        vm.warp(TIME0);
        _allowAllForErc20();
        token1.mint(address(account), 100e6);
        _setErc20Limit(address(token1), 1e6, 1 days);

        assertTrue(
            _executeSessionKeyUserOp(account, _calls(_erc20Transfer(address(token1), recipient1, 0.5e6)), sessionKey1)
        );
        _assertErc20Info(address(token1), 1e6, 0.5e6, 1 days, uint48(TIME0));

        skip(1 days + 1 minutes);
        (bool ok,) = _executeSessionKeyUserOpWithReason(
            account, _calls(_erc20Transfer(address(token1), recipient1, 1.5e6)), sessionKey1
        );
        assertFalse(ok);
        _assertErc20Info(address(token1), 1e6, 0.5e6, 1 days, uint48(TIME0));
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Native token spend limits (SessionKeyNativeTokenSpendLimits.t.sol)             ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    function _setNativeLimit(uint256 limit, uint48 interval) internal {
        assertTrue(
            _updateKeyPermissions(account, sessionKey1.addr, _updates(_permNativeLimit(limit, interval)), quorum)
        );
    }

    function _nativeInfo() internal view returns (IBufiSessionKeyPlugin.SpendLimitInfo memory) {
        return sessionKeyPlugin.getNativeTokenSpendLimitInfo(address(account), sessionKey1.addr);
    }

    function _assertNativeInfo(uint256 limit, uint256 used, uint48 interval, uint48 lastUsed) internal view {
        IBufiSessionKeyPlugin.SpendLimitInfo memory info = _nativeInfo();
        assertTrue(info.hasLimit);
        assertEq(info.limit, limit, "limit");
        assertEq(info.limitUsed, used, "limitUsed");
        assertEq(info.refreshInterval, interval, "refreshInterval");
        assertEq(info.lastUsedTime, lastUsed, "lastUsedTime");
    }

    function testFuzz_sessionKeyNativeTokenSpendLimits_setLimits(uint256 limit, uint48 interval, uint48 timestamp)
        public
    {
        vm.warp(timestamp);
        _allowAllForErc20();

        IBufiSessionKeyPlugin.SpendLimitInfo memory info = _nativeInfo();
        assertTrue(info.hasLimit, "native limit is enforced (at zero) by default");
        assertEq(info.limit, 0);

        _setNativeLimit(limit, interval);
        info = _nativeInfo();
        if (limit == type(uint256).max) {
            assertFalse(info.hasLimit);
            assertEq(info.limit, 0);
            assertEq(info.refreshInterval, 0);
            assertEq(info.limitUsed, 0);
        } else {
            assertTrue(info.hasLimit);
            assertEq(info.limit, limit);
            assertEq(info.refreshInterval, interval);
            assertEq(info.limitUsed, 0);
            assertEq(info.lastUsedTime, interval == 0 ? 0 : timestamp);
        }
    }

    function test_sessionKeyNativeTokenSpendLimits_enforceLimit_none() public {
        _allowAllForErc20();
        _expectSessionKeyValidationRevert(
            account, _calls(_nativeTransfer(recipient1, 1 wei)), sessionKey1, _aa23PermissionsCheckFailed()
        );
        assertTrue(_executeSessionKeyUserOp(account, _calls(_call(recipient1, 0, "somedata")), sessionKey1));
        assertTrue(
            _executeSessionKeyUserOp(
                account, _calls(_call(recipient1, 0, "somedata1"), _call(recipient2, 0, "somedata2")), sessionKey1
            )
        );
    }

    function test_sessionKeyNativeTokenSpendLimits_basic_single_and_exceed() public {
        _allowAllForErc20();
        _setNativeLimit(1 ether, 0);

        assertTrue(_executeSessionKeyUserOp(account, _calls(_nativeTransfer(recipient1, 1 wei)), sessionKey1));
        assertEq(recipient1.balance, 1 wei);
        _assertNativeInfo(1 ether, 1 wei, 0, 0);

        _expectSessionKeyValidationRevert(
            account, _calls(_nativeTransfer(recipient1, 1 ether)), sessionKey1, _aa23PermissionsCheckFailed()
        );
        _assertNativeInfo(1 ether, 1 wei, 0, 0);
    }

    function test_sessionKeyNativeTokenSpendLimits_overflowState() public {
        _allowAllForErc20();
        _setNativeLimit(1 ether, 0);
        assertTrue(_executeSessionKeyUserOp(account, _calls(_nativeTransfer(recipient1, 1 wei)), sessionKey1));
        _expectSessionKeyValidationRevert(
            account, _calls(_nativeTransfer(recipient1, type(uint256).max)), sessionKey1, _aa23PermissionsCheckFailed()
        );
    }

    function test_sessionKeyNativeTokenSpendLimits_overflowBatch() public {
        _allowAllForErc20();
        _setNativeLimit(1 ether, 0);
        // The in-batch overflow panics inside validation; the EntryPoint reports it as an AA23 revert.
        _expectSessionKeyValidationRevert(
            account,
            _calls(_nativeTransfer(recipient1, 1 wei), _nativeTransfer(recipient1, type(uint256).max)),
            sessionKey1
        );
    }

    function test_sessionKeyNativeTokenSpendLimits_basic_multi_and_exceed() public {
        _allowAllForErc20();
        _setNativeLimit(1 ether, 0);

        assertTrue(
            _executeSessionKeyUserOp(
                account,
                _calls(
                    _nativeTransfer(recipient1, 1 wei),
                    _nativeTransfer(recipient2, 1 wei),
                    _nativeTransfer(recipient3, 1 wei)
                ),
                sessionKey1
            )
        );
        _assertNativeInfo(1 ether, 3 wei, 0, 0);

        _expectSessionKeyValidationRevert(
            account,
            _calls(
                _nativeTransfer(recipient1, 0.5 ether),
                _nativeTransfer(recipient2, 0.5 ether),
                _nativeTransfer(recipient3, 0.5 ether)
            ),
            sessionKey1,
            _aa23PermissionsCheckFailed()
        );
        _assertNativeInfo(1 ether, 3 wei, 0, 0);
    }

    function test_sessionKeyNativeTokenSpendLimits_refreshInterval_single() public {
        vm.warp(TIME0);
        _allowAllForErc20();
        _setNativeLimit(1 ether, 1 days);

        assertTrue(_executeSessionKeyUserOp(account, _calls(_nativeTransfer(recipient1, 1 wei)), sessionKey1));
        _assertNativeInfo(1 ether, 1 wei, 1 days, uint48(TIME0));

        // Fits in the NEXT interval: validation passes with validAfter = lastUsed + interval, so the EntryPoint
        // reports "not due" rather than a permission failure.
        _expectSessionKeyValidationRevert(account, _calls(_nativeTransfer(recipient1, 1 ether)), sessionKey1, _aa22());
        _assertNativeInfo(1 ether, 1 wei, 1 days, uint48(TIME0));

        vm.warp(TIME0 + 1 days);
        assertTrue(_executeSessionKeyUserOp(account, _calls(_nativeTransfer(recipient1, 1 ether)), sessionKey1));
        _assertNativeInfo(1 ether, 1 ether, 1 days, uint48(TIME0 + 1 days));
    }

    function test_sessionKeyNativeTokenSpendLimits_refreshInterval_multi() public {
        vm.warp(TIME0);
        _allowAllForErc20();
        _setNativeLimit(1 ether, 1 days);

        assertTrue(_executeSessionKeyUserOp(account, _calls(_nativeTransfer(recipient1, 1 wei)), sessionKey1));

        Call[] memory calls = _calls(_nativeTransfer(recipient1, 0.5 ether), _nativeTransfer(recipient2, 0.5 ether));
        _expectSessionKeyValidationRevert(account, calls, sessionKey1, _aa22());
        _assertNativeInfo(1 ether, 1 wei, 1 days, uint48(TIME0));

        vm.warp(TIME0 + 1 days);
        assertTrue(_executeSessionKeyUserOp(account, calls, sessionKey1));
        _assertNativeInfo(1 ether, 1 ether, 1 days, uint48(TIME0 + 1 days));
    }

    function test_sessionKeyNativeTokenSpendLimits_refreshInterval_takeMaxStartTime() public {
        vm.warp(TIME0);
        _allowAllForErc20();
        _setNativeLimit(1 ether, 1 days);
        assertTrue(_executeSessionKeyUserOp(account, _calls(_nativeTransfer(recipient1, 1 wei)), sessionKey1));

        PackedUserOperation memory op =
            _prepareSessionKeyUserOp(account, _calls(_nativeTransfer(recipient1, 1 ether)), sessionKey1);
        uint256 result = _validateAsEntryPoint(account, op);
        assertEq(uint48(result >> 208), uint48(TIME0 + 1 days), "spend-limit start time");

        // Key start time later than the spend-limit start time wins.
        assertTrue(
            _updateKeyPermissions(
                account, sessionKey1.addr, _updates(_permTimeRange(uint48(TIME0 + 2 days), 0)), quorum
            )
        );
        result = _validateAsEntryPoint(account, op);
        assertEq(uint48(result >> 208), uint48(TIME0 + 2 days), "key start time");

        // Key start time earlier than the spend-limit start time: the spend limit wins.
        assertTrue(
            _updateKeyPermissions(
                account, sessionKey1.addr, _updates(_permTimeRange(uint48(TIME0 + 12 hours), 0)), quorum
            )
        );
        result = _validateAsEntryPoint(account, op);
        assertEq(uint48(result >> 208), uint48(TIME0 + 1 days), "spend-limit start time again");
    }

    /// @dev Two ops in one bundle each pass validation against the same starting usage; the execution-phase
    ///      re-check makes the second one fail. Only 1 ether leaves the account.
    function test_sessionKeyNativeTokenSpendLimits_multiUserOpBundle_check_noInterval() public {
        _allowAllForErc20();
        _setNativeLimit(1 ether, 0);

        Call[] memory calls = _calls(_nativeTransfer(recipient1, 1 ether));
        PackedUserOperation[] memory ops = new PackedUserOperation[](2);
        ops[0] = _prepareSessionKeyUserOp(account, calls, sessionKey1);
        ops[1] = _buildSessionKeyUserOp(account, calls, sessionKey1.addr);
        ops[1].nonce = ops[0].nonce + 1;
        ops[1].signature = _signSessionKey(ops[1], sessionKey1.key);

        (bool[] memory ok, bytes[] memory reasons) = _runOps(ops);
        assertTrue(ok[0]);
        assertFalse(ok[1]);
        assertEq(
            reasons[1],
            abi.encodeWithSelector(
                IBufiSessionKeyPlugin.NativeTokenSpendLimitExceeded.selector, address(account), sessionKey1.addr
            )
        );
        assertEq(recipient1.balance, 1 ether);
        _assertNativeInfo(1 ether, 1 ether, 0, 0);
    }

    function test_sessionKeyNativeTokenSpendLimits_refreshInterval_exceedNewInterval() public {
        vm.warp(TIME0);
        _allowAllForErc20();
        _setNativeLimit(1 ether, 1 days);
        assertTrue(_executeSessionKeyUserOp(account, _calls(_nativeTransfer(recipient1, 1 wei)), sessionKey1));

        skip(1 days + 1 minutes);
        _expectSessionKeyValidationRevert(
            account, _calls(_nativeTransfer(recipient1, 1.1 ether)), sessionKey1, _aa23PermissionsCheckFailed()
        );
        _assertNativeInfo(1 ether, 1 wei, 1 days, uint48(TIME0));
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Gas spend limits (SessionKeyGasLimits.t.sol) — ERC-4337 v0.7 prefund formula   ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    function _setGasLimit(uint256 limit, uint48 interval) internal {
        assertTrue(_updateKeyPermissions(account, sessionKey1.addr, _updates(_permGasLimit(limit, interval)), quorum));
    }

    function _gasInfo() internal view returns (IBufiSessionKeyPlugin.SpendLimitInfo memory info, bool shouldReset) {
        return sessionKeyPlugin.getGasSpendLimit(address(account), sessionKey1.addr);
    }

    function _assertGasInfo(uint256 limit, uint256 used, uint48 interval, uint48 lastUsed) internal view {
        (IBufiSessionKeyPlugin.SpendLimitInfo memory info,) = _gasInfo();
        assertTrue(info.hasLimit);
        assertEq(info.limit, limit, "limit");
        assertEq(info.limitUsed, used, "limitUsed");
        assertEq(info.refreshInterval, interval, "refreshInterval");
        assertEq(info.lastUsedTime, lastUsed, "lastUsedTime");
    }

    /// @dev A dummy-call session-key op with explicit gas fields, asserting the v0.7 prefund equals `expectedCost`.
    function _gasOp(uint128 verificationGas, uint128 callGas, uint128 maxFee, uint256 expectedCost, uint256 nonce)
        internal
        view
        returns (PackedUserOperation memory op)
    {
        op = _gasOpWithCalls(verificationGas, callGas, maxFee, expectedCost, nonce, _calls(_call(recipient, 0, "")));
    }

    function _gasOpWithCalls(
        uint128 verificationGas,
        uint128 callGas,
        uint128 maxFee,
        uint256 expectedCost,
        uint256 nonce,
        Call[] memory calls
    ) internal view returns (PackedUserOperation memory op) {
        op = _buildSessionKeyUserOpWithGas(account, calls, sessionKey1.addr, verificationGas, callGas, 0, maxFee, 0, "");
        op.nonce = nonce;
        assertEq(_requiredPrefundV07(op), expectedCost, "expected v0.7 max gas cost");
        op.signature = _signSessionKey(op, sessionKey1.key);
    }

    function _runGasOp(uint128 verificationGas, uint128 callGas, uint128 maxFee, uint256 expectedCost)
        internal
        returns (bool ok)
    {
        (ok,) = _runOp(
            _gasOp(verificationGas, callGas, maxFee, expectedCost, _sessionKeyNonce(account, sessionKey1.addr))
        );
    }

    function _expectGasOpRevert(
        uint128 verificationGas,
        uint128 callGas,
        uint128 maxFee,
        uint256 expectedCost,
        bytes memory err
    ) internal {
        _expectHandleOpsRevert(
            _gasOp(verificationGas, callGas, maxFee, expectedCost, _sessionKeyNonce(account, sessionKey1.addr)), err
        );
    }

    function testFuzz_sessionKeyGasLimits_setLimits(uint256 limit, uint48 interval, uint48 timestamp) public {
        vm.warp(timestamp);
        (IBufiSessionKeyPlugin.SpendLimitInfo memory info,) = _gasInfo();
        assertFalse(info.hasLimit);

        _setGasLimit(limit, interval);
        (info,) = _gasInfo();
        if (limit == type(uint256).max) {
            assertFalse(info.hasLimit);
            assertEq(info.limit, 0);
            assertEq(info.refreshInterval, 0);
            assertEq(info.limitUsed, 0);
        } else {
            assertTrue(info.hasLimit);
            assertEq(info.limit, limit);
            assertEq(info.refreshInterval, interval);
            assertEq(info.limitUsed, 0);
            assertEq(info.lastUsedTime, interval == 0 ? 0 : timestamp);
        }
    }

    function test_sessionKeyGasLimits_enforceLimit_none() public {
        assertTrue(_updateKeyPermissions(account, sessionKey1.addr, _permUnrestricted(), quorum));
        _setGasLimit(0, 0);
        _expectGasOpRevert(300_000, 300_000, 1, 600_000 wei, _aa23PermissionsCheckFailed());
    }

    function testFuzz_sessionKeyGasLimits_nolimit(uint256 gasPrice) public {
        gasPrice = bound(gasPrice, 1 wei, 1_000_000_000 gwei);
        assertTrue(_updateKeyPermissions(account, sessionKey1.addr, _permUnrestricted(), quorum));
        uint256 prefund = 1_000_000 * gasPrice;
        vm.deal(address(account), prefund + 1 ether);
        assertTrue(_runGasOp(500_000, 500_000, uint128(gasPrice), prefund));
    }

    function test_sessionKeyGasLimits_enforceLimit_basic_single() public {
        assertTrue(_updateKeyPermissions(account, sessionKey1.addr, _permUnrestricted(), quorum));
        _setGasLimit(1 ether, 0);

        assertTrue(_runGasOp(300_000, 300_000, 1_000 gwei, 0.6 ether));
        _assertGasInfo(1 ether, 0.6 ether, 0, 0);

        _expectGasOpRevert(300_000, 300_000, 1_000 gwei, 0.6 ether, _aa23PermissionsCheckFailed());
    }

    /// @dev v0.7-specific: a paymaster's verification and postOp gas limits are charged against the gas budget.
    function test_sessionKeyGasLimits_paymasterGasIsCharged() public {
        SessionTestPaymaster paymaster = new SessionTestPaymaster(entryPoint);
        paymaster.deposit{value: 50 ether}();
        assertTrue(_updateKeyPermissions(account, sessionKey1.addr, _permUnrestricted(), quorum));
        _setGasLimit(1 ether, 0);

        // (300k + 300k + 150k + 50k) * 1000 gwei = 0.8 ether
        PackedUserOperation memory op = _buildSessionKeyUserOpWithGas(
            account,
            _calls(_call(recipient, 0, "")),
            sessionKey1.addr,
            300_000,
            300_000,
            0,
            1_000 gwei,
            0,
            _paymasterAndData(address(paymaster), 150_000, 50_000)
        );
        assertEq(_requiredPrefundV07(op), 0.8 ether);
        op.signature = _signSessionKey(op, sessionKey1.key);
        (bool ok,) = _runOp(op);
        assertTrue(ok);
        _assertGasInfo(1 ether, 0.8 ether, 0, 0);

        // Another 0.3 ether would exceed the budget: only the paymaster gas limits differ.
        op = _buildSessionKeyUserOpWithGas(
            account,
            _calls(_call(recipient, 0, "")),
            sessionKey1.addr,
            100_000,
            100_000,
            0,
            1_000 gwei,
            0,
            _paymasterAndData(address(paymaster), 50_000, 50_000)
        );
        assertEq(_requiredPrefundV07(op), 0.3 ether);
        op.signature = _signSessionKey(op, sessionKey1.key);
        _expectHandleOpsRevert(op, _aa23PermissionsCheckFailed());
    }

    function testFuzz_sessionKeyGasLimits_requireNonceAsAddress(uint192 nonceKey) public {
        vm.assume(nonceKey != _sessionKeyNonceKey(sessionKey1.addr));
        assertTrue(_updateKeyPermissions(account, sessionKey1.addr, _permUnrestricted(), quorum));
        _setGasLimit(1 ether, 0);

        PackedUserOperation memory op = _gasOp(200_000, 200_000, 1_000 gwei, 0.4 ether, uint256(nonceKey) << 64);
        _expectHandleOpsRevert(op, _aa23PermissionsCheckFailed());
    }

    function test_sessionKeyGasLimits_exceedLimit_single() public {
        assertTrue(_updateKeyPermissions(account, sessionKey1.addr, _permUnrestricted(), quorum));
        _setGasLimit(1 ether, 0);
        _expectGasOpRevert(300_000, 300_000, 2_000 gwei, 1.2 ether, _aa23PermissionsCheckFailed());
    }

    function test_sessionKeyGasLimits_enforceLimit_basic_multipleInBundle() public {
        assertTrue(_updateKeyPermissions(account, sessionKey1.addr, _permUnrestricted(), quorum));
        _setGasLimit(1 ether, 0);

        PackedUserOperation[] memory ops = new PackedUserOperation[](2);
        ops[0] = _gasOp(200_000, 200_000, 1_000 gwei, 0.4 ether, _wrapNonceWithKey(0, sessionKey1.addr));
        ops[1] = _gasOp(200_000, 200_000, 1_000 gwei, 0.4 ether, _wrapNonceWithKey(1, sessionKey1.addr));
        (bool[] memory ok,) = _runOps(ops);
        assertTrue(ok[0] && ok[1]);
        _assertGasInfo(1 ether, 0.8 ether, 0, 0);
    }

    function test_sessionKeyGasLimits_exceedLimit_multipleInBundle() public {
        assertTrue(_updateKeyPermissions(account, sessionKey1.addr, _permUnrestricted(), quorum));
        _setGasLimit(1 ether, 0);

        PackedUserOperation[] memory ops = new PackedUserOperation[](2);
        ops[0] = _gasOp(200_000, 200_000, 2_000 gwei, 0.8 ether, _wrapNonceWithKey(0, sessionKey1.addr));
        ops[1] = _gasOp(200_000, 200_000, 2_000 gwei, 0.8 ether, _wrapNonceWithKey(1, sessionKey1.addr));
        _expectHandleOpsRevert(ops, _aa23PermissionsCheckFailed(1));
        _assertGasInfo(1 ether, 0, 0, 0);
    }

    function test_sessionKeyGasLimits_refreshInterval_inspectValidationData() public {
        vm.warp(TIME0);
        assertTrue(_updateKeyPermissions(account, sessionKey1.addr, _permUnrestricted(), quorum));
        _setGasLimit(1 ether, 1 days);

        assertTrue(_runGasOp(300_000, 300_000, 1_000 gwei, 0.6 ether));
        _assertGasInfo(1 ether, 0.6 ether, 1 days, uint48(TIME0));

        PackedUserOperation memory op =
            _gasOp(300_000, 300_000, 1_000 gwei, 0.6 ether, _sessionKeyNonce(account, sessionKey1.addr));
        uint256 validationData = _validateAsEntryPoint(account, op);
        assertEq(uint48(validationData >> 208), uint48(TIME0 + 1 days));
    }

    function test_sessionKeyGasLimits_refreshInterval_single() public {
        vm.warp(TIME0);
        assertTrue(_updateKeyPermissions(account, sessionKey1.addr, _permUnrestricted(), quorum));
        _setGasLimit(1 ether, 1 days);

        assertTrue(_runGasOp(300_000, 300_000, 1_000 gwei, 0.6 ether));
        _assertGasInfo(1 ether, 0.6 ether, 1 days, uint48(TIME0));

        _expectGasOpRevert(300_000, 300_000, 1_000 gwei, 0.6 ether, _aa22());

        skip(1 days + 1 minutes);
        assertTrue(_runGasOp(300_000, 300_000, 1_000 gwei, 0.6 ether));
        _assertGasInfo(1 ether, 0.6 ether, 1 days, uint48(TIME0 + 1 days + 1 minutes));
    }

    function test_sessionKeyGasLimits_refreshInterval_multipleInBundle() public {
        vm.warp(TIME0);
        assertTrue(_updateKeyPermissions(account, sessionKey1.addr, _permUnrestricted(), quorum));
        _setGasLimit(1 ether, 1 days);
        assertTrue(_runGasOp(300_000, 300_000, 1_000 gwei, 0.6 ether));

        PackedUserOperation[] memory ops = new PackedUserOperation[](2);
        ops[0] = _gasOp(200_000, 200_000, 1_000 gwei, 0.4 ether, _wrapNonceWithKey(1, sessionKey1.addr));
        ops[1] = _gasOp(200_000, 200_000, 1_000 gwei, 0.4 ether, _wrapNonceWithKey(2, sessionKey1.addr));
        _expectHandleOpsRevert(ops, _aa22(1));
        _assertGasInfo(1 ether, 0.6 ether, 1 days, uint48(TIME0));

        skip(1 days + 1 minutes);
        (bool[] memory ok,) = _runOps(ops);
        assertTrue(ok[0] && ok[1]);
        // The first op fits the old interval, the second starts a new one: usage is 0.4, not 1.0.
        _assertGasInfo(1 ether, 0.4 ether, 1 days, uint48(TIME0 + 1 days + 1 minutes));
    }

    function test_sessionKeyGasLimits_refreshInterval_multipleInBundle_tryExceedFails() public {
        vm.warp(TIME0);
        assertTrue(_updateKeyPermissions(account, sessionKey1.addr, _permUnrestricted(), quorum));
        _setGasLimit(1 ether, 1 days);
        assertTrue(_runGasOp(400_000, 400_000, 1_000 gwei, 0.8 ether));

        PackedUserOperation[] memory ops = new PackedUserOperation[](3);
        ops[0] = _gasOp(200_000, 200_000, 1_000 gwei, 0.4 ether, _wrapNonceWithKey(1, sessionKey1.addr));
        ops[1] = _gasOp(200_000, 200_000, 1_000 gwei, 0.4 ether, _wrapNonceWithKey(2, sessionKey1.addr));
        ops[2] = _gasOp(200_000, 200_000, 1_000 gwei, 0.4 ether, _wrapNonceWithKey(3, sessionKey1.addr));
        _expectHandleOpsRevert(ops, _aa22(0));
        _assertGasInfo(1 ether, 0.8 ether, 1 days, uint48(TIME0));

        skip(1 days + 1 minutes);
        // The first op opens a new interval at 0.4, the second reaches 0.8, the third would exceed it.
        _expectHandleOpsRevert(ops, _aa23PermissionsCheckFailed(2));
    }

    function _runResetFlagScenario() internal {
        vm.warp(TIME0);
        assertTrue(_updateKeyPermissions(account, sessionKey1.addr, _permUnrestricted(), quorum));
        _setGasLimit(1 ether, 1 days);
        assertTrue(_runGasOp(300_000, 300_000, 1_000 gwei, 0.6 ether));

        // A call that reverts during execution (this test contract has no fallback) in the NEXT interval leaves
        // the "reset" flag set, because the execution-phase clear is rolled back with the revert.
        Call[] memory calls = _calls(_call(address(this), 0, abi.encodeWithSelector(bytes4(0x11223344))));
        skip(1 days + 1 minutes);
        PackedUserOperation memory op =
            _gasOpWithCalls(300_000, 300_000, 1_000 gwei, 0.6 ether, _wrapNonceWithKey(1, sessionKey1.addr), calls);
        (bool ok,) = _runOp(op);
        assertFalse(ok, "execution reverted");
        (, bool shouldReset) = _gasInfo();
        assertTrue(shouldReset, "session key should report that it needs to be reset");
    }

    function test_sessionKeyGasLimits_refreshInterval_resetFlagTracking() public {
        _runResetFlagScenario();
    }

    function test_sessionKeyGasLimits_refreshInterval_resetFlag_fixWithExtraUO() public {
        _runResetFlagScenario();
        assertTrue(_runGasOp(200_000, 200_000, 1_000 gwei, 0.4 ether));
        (IBufiSessionKeyPlugin.SpendLimitInfo memory info, bool shouldReset) = _gasInfo();
        assertFalse(shouldReset);
        assertEq(info.limitUsed, 1 ether);
        assertEq(info.lastUsedTime, block.timestamp);
    }

    function test_sessionKeyGasLimits_refreshInterval_resetFlag_fixWithOwnerReset() public {
        _runResetFlagScenario();
        _setGasLimit(1 ether, 1 days);
        (IBufiSessionKeyPlugin.SpendLimitInfo memory info, bool shouldReset) = _gasInfo();
        assertFalse(shouldReset);
        assertEq(info.limitUsed, 0.6 ether);
        assertEq(info.lastUsedTime, block.timestamp);
    }

    function test_sessionKeyGasLimits_refreshInterval_resetFlag_fixWithPublicReset() public {
        _runResetFlagScenario();
        sessionKeyPlugin.resetSessionKeyGasLimitTimestamp(address(account), sessionKey1.addr);
        (IBufiSessionKeyPlugin.SpendLimitInfo memory info, bool shouldReset) = _gasInfo();
        assertFalse(shouldReset);
        assertEq(info.limitUsed, 0.6 ether);
        assertEq(info.lastUsedTime, block.timestamp);
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Helpers                                                                        ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    /// @dev Adds `(seed % 16) + 1` unrestricted session keys through owner userOps; returns their private keys.
    function _createSessionKeys(uint8 seed) internal returns (uint256[] memory privateKeys) {
        uint256 count = (seed % 16) + 1;
        privateKeys = new uint256[](count);
        for (uint256 i = 0; i < count; i++) {
            (address key, uint256 privateKey) = makeAddrAndKey(string.concat("fuzzSessionKey", vm.toString(i)));
            privateKeys[i] = privateKey;
            assertTrue(_addSessionKey(account, key, bytes32(0), _permUnrestricted(), quorum));
        }
    }
}
