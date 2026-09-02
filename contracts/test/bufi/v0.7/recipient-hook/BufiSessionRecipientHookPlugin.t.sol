// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {SessionKeyHarness} from "../../../harness/SessionKeyHarness.sol";

import {
    BufiSessionRecipientHookPlugin
} from "../../../../src/bufi/v0.7/recipient-hook/BufiSessionRecipientHookPlugin.sol";
import {
    IBufiSessionRecipientHookPlugin
} from "../../../../src/bufi/v0.7/recipient-hook/IBufiSessionRecipientHookPlugin.sol";
import {IBufiSessionKeyPlugin} from "../../../../src/bufi/v0.7/session/IBufiSessionKeyPlugin.sol";
import {SandboxUSDC} from "../../../../src/sandbox/SandboxUSDC.sol";

import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {NotImplemented} from "@circle/msca/6900/shared/common/Errors.sol";
import {UpgradableMSCA} from "@circle/msca/6900/v0.7/account/UpgradableMSCA.sol";
import {PluginManifest, PluginMetadata} from "@circle/msca/6900/v0.7/common/PluginManifest.sol";
import {Call, FunctionReference} from "@circle/msca/6900/v0.7/common/Structs.sol";
import {IPlugin} from "@circle/msca/6900/v0.7/interfaces/IPlugin.sol";
import {IPluginManager} from "@circle/msca/6900/v0.7/interfaces/IPluginManager.sol";
import {IStandardExecutor} from "@circle/msca/6900/v0.7/interfaces/IStandardExecutor.sol";
import {PluginManager} from "@circle/msca/6900/v0.7/managers/PluginManager.sol";
import {BasePlugin} from "@circle/msca/6900/v0.7/plugins/BasePlugin.sol";
import {IAddressBookPlugin} from "@circle/msca/6900/v0.7/plugins/v1_0_0/addressbook/IAddressBookPlugin.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Vm} from "forge-std/src/Vm.sol";

/// @notice `BufiSessionRecipientHookPlugin` on Circle's production stack (canonical bytecode for the account,
///         `WeightedWebauthnMultisigPlugin` and `ColdStorageAddressBookPlugin`) composed with `BufiSessionKeyPlugin`.
///
///         The gap it closes is pinned by `SessionKeyWithAddressBook.t.sol`
///         (`test_erc20RecipientIsNotGatedBySessionKeyAccessList`): a key scoped to `USDC.transfer` could name ANY
///         recipient. With the hook installed, the SAME grant is gated by the SAME AddressBook set the owners'
///         `execute` path is gated by — no mirrored list, no re-sync.
contract BufiSessionRecipientHookPluginTest is SessionKeyHarness {
    BufiSessionRecipientHookPlugin internal hook;
    SandboxUSDC internal usdc;

    UpgradableMSCA internal account;
    Signer[] internal quorum;
    Signer internal agent;

    address internal allowed;
    address internal stranger;

    uint256 internal constant AGENT_BUDGET = 100e6;
    /// Informational bound for the hook's validation-phase overhead with a 5-entry allowlist.
    uint256 internal constant HOOK_GAS_BOUND = 60_000;

    function setUp() public {
        _deployCircleCanonicalStack();
        _deploySessionKeyPlugin();
        hook = new BufiSessionRecipientHookPlugin();
        vm.label(address(hook), "BufiSessionRecipientHookPlugin");
        usdc = new SandboxUSDC();

        allowed = makeAddr("allowed-recipient");
        stranger = makeAddr("stranger");
        agent = _signerFrom("agent");

        (UpgradableMSCA msca, Signer[] memory q) = _newAccount("owner", bytes32(uint256(41)), _one(allowed), true);
        account = msca;
        quorum.push(q[0]);
        quorum.push(q[1]);
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Helpers                                                                        ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    /// @dev 2-of-3 weighted account with AddressBook(recipients) → SessionKey → [Hook], funded with 1000 USDC.
    function _newAccount(string memory prefix, bytes32 salt, address[] memory recipients, bool withHook)
        internal
        returns (UpgradableMSCA msca, Signer[] memory q)
    {
        Signer[] memory owners = _makeSigners(prefix, 3);
        msca = _createWeightedMsca(owners, _uniformWeights(3, 1), 2, salt);
        q = new Signer[](2);
        q[0] = owners[0];
        q[1] = owners[1];
        assertTrue(_installAddressBook(msca, recipients, q), "address book install");
        assertTrue(_installSessionKeyPlugin(msca, q), "session key plugin install");
        if (withHook) {
            assertTrue(_installHook(msca, q), "hook install");
        }
        usdc.mint(address(msca), 1_000e6);
    }

    function _noDeps() internal pure returns (FunctionReference[] memory) {
        return new FunctionReference[](0);
    }

    function _installHook(UpgradableMSCA msca, Signer[] memory signers) internal returns (bool) {
        return _installPlugin(msca, address(hook), abi.encode(address(addressBookPlugin)), _noDeps(), signers);
    }

    function _uninstallPluginCalldata(address plugin) internal pure returns (bytes memory) {
        return abi.encodeCall(IPluginManager.uninstallPlugin, (plugin, "", ""));
    }

    function _addRecipients(UpgradableMSCA msca, address[] memory recipients, Signer[] memory signers)
        internal
        returns (bool)
    {
        return _executeUserOp(msca, abi.encodeCall(IAddressBookPlugin.addAllowedRecipients, (recipients)), signers);
    }

    function _removeRecipients(UpgradableMSCA msca, address[] memory recipients, Signer[] memory signers)
        internal
        returns (bool)
    {
        return _executeUserOp(msca, abi.encodeCall(IAddressBookPlugin.removeAllowedRecipients, (recipients)), signers);
    }

    /// @dev The grant of the documented gap: scope = `USDC.transfer` only, budget = 100 USDC (no refresh).
    function _transferOnlyGrant() internal view returns (bytes[] memory) {
        return _updates(
            _permAddressEntry(address(usdc), true, true),
            _permFunctionEntry(address(usdc), usdc.transfer.selector, true),
            _permErc20Limit(address(usdc), AGENT_BUDGET, 0)
        );
    }

    function _one(address a) internal pure returns (address[] memory out) {
        out = new address[](1);
        out[0] = a;
    }

    function _aa23UnauthorizedRecipient(address acct, address recipient) internal pure returns (bytes memory) {
        return
            _aa23(
                abi.encodeWithSelector(IBufiSessionRecipientHookPlugin.UnauthorizedRecipient.selector, acct, recipient)
            );
    }

    function _stripSelector(bytes memory data) internal pure returns (bytes memory out) {
        out = new bytes(data.length - 4);
        for (uint256 i = 0; i < out.length; i++) {
            out[i] = data[i + 4];
        }
    }

    /// @dev Session-key op → (execution succeeded, `actualGasUsed` from the EntryPoint event).
    function _sessionKeyOpGas(UpgradableMSCA msca, Call[] memory calls, Signer memory key)
        internal
        returns (bool success, uint256 gasUsed)
    {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = _prepareSessionKeyUserOp(msca, calls, key);
        vm.recordLogs();
        entryPoint.handleOps(ops, beneficiary);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == IEntryPoint.UserOperationEvent.selector) {
                (, success,, gasUsed) = abi.decode(logs[i].data, (uint256, bool, uint256, uint256));
            }
        }
    }

    function _userOpHooksOnSessionKeySelector(UpgradableMSCA msca) internal view returns (FunctionReference[] memory) {
        (FunctionReference[] memory userOpHooks,) =
            msca.getPreValidationHooks(IBufiSessionKeyPlugin.executeWithSessionKey.selector);
        return userOpHooks;
    }

    function _assertHookListedOn(UpgradableMSCA msca) internal view {
        FunctionReference[] memory userOpHooks = _userOpHooksOnSessionKeySelector(msca);
        assertEq(userOpHooks.length, 1, "one pre-userOp hook on executeWithSessionKey");
        assertEq(userOpHooks[0].plugin, address(hook), "the hook plugin");
        assertEq(
            userOpHooks[0].functionId,
            uint8(BufiSessionRecipientHookPlugin.FunctionId.PRE_USER_OP_VALIDATION_HOOK_EXECUTE_WITH_SESSION_KEY)
        );
        (, FunctionReference[] memory runtimeHooks) =
            msca.getPreValidationHooks(IBufiSessionKeyPlugin.executeWithSessionKey.selector);
        bool found;
        for (uint256 i = 0; i < runtimeHooks.length; i++) {
            found = found || runtimeHooks[i].plugin == address(hook);
        }
        assertTrue(found, "pre-runtime hook registered next to the session-key plugin's always-deny");
        assertEq(hook.addressBookOf(address(msca)), address(addressBookPlugin), "bound to the canonical AddressBook");
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  1. Install matrix                                                              ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    function test_install_addressBook_sessionKey_hook_loupeListsTheHook() public view {
        _assertHookListedOn(account);
        assertTrue(account.supportsInterface(type(IBufiSessionRecipientHookPlugin).interfaceId));

        // The owners' selectors keep exactly the AddressBook hook: the new plugin does not touch them.
        (FunctionReference[] memory userOpHooks,) = account.getPreValidationHooks(IStandardExecutor.execute.selector);
        assertEq(userOpHooks.length, 1);
        assertEq(userOpHooks[0].plugin, address(addressBookPlugin));
        (userOpHooks,) = account.getPreValidationHooks(IStandardExecutor.executeBatch.selector);
        assertEq(userOpHooks.length, 1);
        assertEq(userOpHooks[0].plugin, address(addressBookPlugin));
    }

    /// @dev A pre-hook on a selector with no execution function yet is simply stored by Circle's PluginManager;
    ///      the session-key plugin then installs on top of it without conflict.
    function test_install_hookBeforeSessionKey() public {
        Signer[] memory owners = _makeSigners("early", 3);
        UpgradableMSCA msca = _createWeightedMsca(owners, _uniformWeights(3, 1), 2, bytes32(uint256(42)));
        Signer[] memory q = new Signer[](2);
        q[0] = owners[0];
        q[1] = owners[1];
        assertTrue(_installAddressBook(msca, _one(allowed), q), "address book install");
        assertTrue(_installHook(msca, q), "hook install BEFORE the session-key plugin");
        assertEq(_userOpHooksOnSessionKeySelector(msca).length, 1, "hook stored on a selector nobody owns yet");
        assertTrue(_installSessionKeyPlugin(msca, q), "session key plugin install AFTER the hook");
        _assertHookListedOn(msca);

        usdc.mint(address(msca), 1_000e6);
        Signer memory key = _signerFrom("early-agent");
        assertTrue(_addSessionKey(msca, key.addr, bytes32("agent"), _transferOnlyGrant(), q));
        assertTrue(_executeSessionKeyUserOp(msca, _calls(_erc20Transfer(address(usdc), allowed, 1e6)), key));
        _expectSessionKeyValidationRevert(
            msca,
            _calls(_erc20Transfer(address(usdc), stranger, 1e6)),
            key,
            _aa23UnauthorizedRecipient(address(msca), stranger)
        );
    }

    /// @dev `onInstall` binds only to an AddressBook the account itself installed; anything else fails the whole
    ///      `installPlugin` userOp (execution phase, `FailToCallOnInstall`).
    function test_install_rejectsAnythingButTheInstalledAddressBook() public {
        Signer[] memory owners = _makeSigners("bare", 3);
        UpgradableMSCA msca = _createWeightedMsca(owners, _uniformWeights(3, 1), 2, bytes32(uint256(43)));
        Signer[] memory q = new Signer[](2);
        q[0] = owners[0];
        q[1] = owners[1];

        // Canonical AddressBook, but NOT installed on this account.
        (bool ok, bytes memory reason) = _executeOwnerUserOpWithReason(
            msca, _installPluginCalldata(address(hook), abi.encode(address(addressBookPlugin)), _noDeps()), q
        );
        assertFalse(ok, "install must fail when the AddressBook is not installed here");
        assertEq(bytes4(reason), PluginManager.FailToCallOnInstall.selector);
        (address failing, bytes memory inner) = abi.decode(_stripSelector(reason), (address, bytes));
        assertEq(failing, address(hook));
        assertEq(
            inner,
            abi.encodeWithSelector(
                IBufiSessionRecipientHookPlugin.AddressBookNotInstalled.selector,
                address(msca),
                address(addressBookPlugin)
            )
        );
        assertFalse(_isInstalled(msca, address(hook)));

        // Zero address, an EOA, and a contract that is not an AddressBook (no ERC-165) → InvalidAddressBook.
        address[3] memory bad = [address(0), stranger, address(usdc)];
        for (uint256 i = 0; i < bad.length; i++) {
            (ok, reason) = _executeOwnerUserOpWithReason(
                msca, _installPluginCalldata(address(hook), abi.encode(bad[i]), _noDeps()), q
            );
            assertFalse(ok);
            (, inner) = abi.decode(_stripSelector(reason), (address, bytes));
            assertEq(inner, abi.encodeWithSelector(IBufiSessionRecipientHookPlugin.InvalidAddressBook.selector, bad[i]));
        }
        assertFalse(_isInstalled(msca, address(hook)));
        assertEq(hook.addressBookOf(address(msca)), address(0));
    }

    /// @dev Neither plugin depends on the other: the session-key plugin can be uninstalled under the hook (its
    ///      hook entries stay on the selector, harmlessly) and the hook can be uninstalled afterwards.
    function test_uninstall_sessionKeyFirst_thenHook() public {
        assertTrue(_uninstallSessionKeyPlugin(account, quorum), "session key plugin uninstall under the hook");
        assertEq(_userOpHooksOnSessionKeySelector(account).length, 1, "hook entry survives");
        assertTrue(_executeUserOp(account, _uninstallPluginCalldata(address(hook)), quorum), "hook uninstall");
        assertEq(_userOpHooksOnSessionKeySelector(account).length, 0, "hook entry removed");
        assertEq(hook.addressBookOf(address(account)), address(0));
        assertFalse(account.supportsInterface(type(IBufiSessionRecipientHookPlugin).interfaceId));
    }

    function test_manifest_hooksOnly() public view {
        PluginManifest memory m = hook.pluginManifest();
        assertEq(m.executionFunctions.length, 0, "no execution functions");
        assertEq(m.dependencyInterfaceIds.length, 0, "no dependencies");
        assertEq(m.userOpValidationFunctions.length, 0);
        assertEq(m.runtimeValidationFunctions.length, 0);
        assertEq(m.executionHooks.length, 0);
        assertFalse(m.permitAnyExternalAddress);
        assertFalse(m.canSpendNativeToken);
        assertEq(m.preUserOpValidationHooks.length, 1);
        assertEq(m.preUserOpValidationHooks[0].executionSelector, IBufiSessionKeyPlugin.executeWithSessionKey.selector);
        assertEq(m.preRuntimeValidationHooks.length, 1);
        assertEq(m.preRuntimeValidationHooks[0].executionSelector, IBufiSessionKeyPlugin.executeWithSessionKey.selector);
        assertEq(m.interfaceIds.length, 1);
        assertEq(m.interfaceIds[0], type(IBufiSessionRecipientHookPlugin).interfaceId);

        assertTrue(hook.supportsInterface(type(IPlugin).interfaceId));
        assertTrue(hook.supportsInterface(type(IBufiSessionRecipientHookPlugin).interfaceId));
        PluginMetadata memory meta = hook.pluginMetadata();
        assertEq(meta.name, "BUFI Session Recipient Hook Plugin");
        assertEq(meta.permissionDescriptors.length, 0);
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  2. The gap is closed                                                           ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    /// @dev The exact grant of `test_erc20RecipientIsNotGatedBySessionKeyAccessList`, now gated: the stranger is
    ///      rejected at validation (AA23 with the hook's reason), the allowed recipient is paid, and the key's own
    ///      budget still applies on top (execution-phase, upstream design).
    function test_gapClosed_transferScopedKey() public {
        assertTrue(_addSessionKey(account, agent.addr, bytes32("agent"), _transferOnlyGrant(), quorum));

        assertTrue(_executeSessionKeyUserOp(account, _calls(_erc20Transfer(address(usdc), allowed, 10e6)), agent));
        assertEq(usdc.balanceOf(allowed), 10e6);

        _expectSessionKeyValidationRevert(
            account,
            _calls(_erc20Transfer(address(usdc), stranger, 10e6)),
            agent,
            _aa23UnauthorizedRecipient(address(account), stranger)
        );
        assertEq(usdc.balanceOf(stranger), 0, "ERC-20 recipient IS gated now");

        // The AddressBook gate composes with the key's budget: within scope and allowlisted, but over budget.
        (bool ok, bytes memory reason) =
            _executeSessionKeyUserOpWithReason(account, _calls(_erc20Transfer(address(usdc), allowed, 200e6)), agent);
        assertFalse(ok);
        assertEq(bytes4(reason), IBufiSessionKeyPlugin.ERC20SpendLimitExceeded.selector);
        assertEq(usdc.balanceOf(allowed), 10e6);
    }

    /// @dev An UNRESTRICTED key (allow-all access list, unlimited native) is now bounded by the AddressBook alone:
    ///      ERC-20 and native transfers to a stranger are rejected, and a mixed batch is rejected as a whole.
    function test_gapClosed_unrestrictedKey_native_erc20_batch() public {
        assertTrue(_addSessionKey(account, agent.addr, bytes32("agent"), _permUnrestricted(), quorum));

        assertTrue(_executeSessionKeyUserOp(account, _calls(_nativeTransfer(allowed, 1 ether)), agent));
        assertEq(allowed.balance, 1 ether);

        _expectSessionKeyValidationRevert(
            account,
            _calls(_nativeTransfer(stranger, 1 ether)),
            agent,
            _aa23UnauthorizedRecipient(address(account), stranger)
        );
        _expectSessionKeyValidationRevert(
            account,
            _calls(_erc20Transfer(address(usdc), stranger, 1e6)),
            agent,
            _aa23UnauthorizedRecipient(address(account), stranger)
        );
        assertEq(stranger.balance, 0);
        assertEq(usdc.balanceOf(stranger), 0);

        // Mixed batch: rejected whole, the allowed leg does not execute either.
        _expectSessionKeyValidationRevert(
            account,
            _calls(_erc20Transfer(address(usdc), allowed, 1e6), _nativeTransfer(stranger, 1 ether)),
            agent,
            _aa23UnauthorizedRecipient(address(account), stranger)
        );
        assertEq(usdc.balanceOf(allowed), 0);

        // All-allowed batch goes through.
        assertTrue(
            _executeSessionKeyUserOp(
                account, _calls(_erc20Transfer(address(usdc), allowed, 1e6), _nativeTransfer(allowed, 1 ether)), agent
            )
        );
        assertEq(usdc.balanceOf(allowed), 1e6);
        assertEq(allowed.balance, 2 ether);
    }

    /// @dev AND-gate: a key whose OWN access list names the stranger still cannot pay them — the AddressBook set is
    ///      not something a grant can widen.
    function test_andGate_keyAccessListCannotOverrideTheAddressBook() public {
        assertTrue(
            _addSessionKey(
                account,
                agent.addr,
                bytes32("agent"),
                _updates(_permAddressEntry(stranger, true, false), _permNativeLimit(10 ether, 0)),
                quorum
            )
        );
        _expectSessionKeyValidationRevert(
            account,
            _calls(_nativeTransfer(stranger, 1 ether)),
            agent,
            _aa23UnauthorizedRecipient(address(account), stranger)
        );
        assertEq(stranger.balance, 0);
    }

    /// @dev Circle's `RecipientAddressLib` treats the ERC-20 `approve` spender and the `transferFrom` `to` as the
    ///      recipient (`from` is never inspected). Pinned here so nobody assumes `approve` is ungated.
    function test_approveSpender_and_transferFromTo_areTheRecipient() public {
        assertTrue(_addSessionKey(account, agent.addr, bytes32("agent"), _permUnrestricted(), quorum));

        _expectSessionKeyValidationRevert(
            account,
            _calls(_erc20Approve(address(usdc), stranger, 5e6)),
            agent,
            _aa23UnauthorizedRecipient(address(account), stranger)
        );
        assertTrue(_executeSessionKeyUserOp(account, _calls(_erc20Approve(address(usdc), allowed, 5e6)), agent));
        assertEq(usdc.allowance(address(account), allowed), 5e6, "approve(allowed) passes the hook");

        _expectSessionKeyValidationRevert(
            account,
            _calls(_call(address(usdc), 0, abi.encodeCall(IERC20.transferFrom, (address(account), stranger, 1e6)))),
            agent,
            _aa23UnauthorizedRecipient(address(account), stranger)
        );
        // `to` allowed → the hook passes; the token then rejects at execution (no allowance from `from`).
        (bool ok,) = _executeSessionKeyUserOpWithReason(
            account,
            _calls(_call(address(usdc), 0, abi.encodeCall(IERC20.transferFrom, (stranger, allowed, 1e6)))),
            agent
        );
        assertFalse(ok, "validation passed (recipient = `to`), execution failed on allowance");
        assertEq(usdc.balanceOf(allowed), 0);
    }

    /// @dev Every branch that cannot produce an allowed recipient rejects; nothing falls through to "allow".
    function test_failsClosed_onUndecodableOrUnsupportedCalls() public {
        assertTrue(_addSessionKey(account, agent.addr, bytes32("agent"), _permUnrestricted(), quorum));

        // Token call with a selector the library does not decode → recipient address(0) → rejected.
        _expectSessionKeyValidationRevert(
            account,
            _calls(_call(address(usdc), 0, abi.encodeCall(usdc.decimals, ()))),
            agent,
            _aa23UnauthorizedRecipient(address(account), address(0))
        );
        // `transfer` selector with truncated arguments (36 bytes < 68) → address(0) → rejected.
        _expectSessionKeyValidationRevert(
            account,
            _calls(
                _call(address(usdc), 0, abi.encodePacked(IERC20.transfer.selector, bytes32(uint256(uint160(allowed)))))
            ),
            agent,
            _aa23UnauthorizedRecipient(address(account), address(0))
        );
        // Zero-value call with EMPTY calldata to a contract → selector 0 → rejected.
        _expectSessionKeyValidationRevert(
            account,
            _calls(_call(address(usdc), 0, "")),
            agent,
            _aa23UnauthorizedRecipient(address(account), address(0))
        );
        // Native value AND calldata → CallDataIsNotEmpty (a payable contract call can never pass).
        bytes memory transferData = abi.encodeCall(IERC20.transfer, (allowed, 1e6));
        _expectSessionKeyValidationRevert(
            account,
            _calls(_call(address(usdc), 1 ether, transferData)),
            agent,
            _aa23(
                abi.encodeWithSelector(
                    IBufiSessionRecipientHookPlugin.CallDataIsNotEmpty.selector,
                    address(account),
                    address(usdc),
                    1 ether,
                    transferData
                )
            )
        );
        // Zero-value call with calldata to an EOA → InvalidTargetCodeLength (even an allowlisted EOA).
        bytes memory junk = hex"deadbeef";
        _expectSessionKeyValidationRevert(
            account,
            _calls(_call(allowed, 0, junk)),
            agent,
            _aa23(
                abi.encodeWithSelector(
                    IBufiSessionRecipientHookPlugin.InvalidTargetCodeLength.selector, address(account), allowed, 0, junk
                )
            )
        );
        // Native transfer to address(0) → rejected.
        _expectSessionKeyValidationRevert(
            account,
            _calls(_nativeTransfer(address(0), 1 ether)),
            agent,
            _aa23UnauthorizedRecipient(address(account), address(0))
        );
        // Empty batch: the hook lets it through (nothing moves — pinned at the direct-call level below), but the
        // audited session-key plugin rejects a zero-call op on its own (`_checkUserOpPermissions`: "only return
        // validation success when there is at least one call"), so at the account level it is still rejected.
        _expectSessionKeyValidationRevert(account, new Call[](0), agent, _aa23PermissionsCheckFailed());
        PackedUserOperation memory emptyOp = _buildSessionKeyUserOp(account, new Call[](0), agent.addr);
        vm.prank(address(account));
        assertEq(
            hook.preUserOpValidationHook(
                uint8(BufiSessionRecipientHookPlugin.FunctionId.PRE_USER_OP_VALIDATION_HOOK_EXECUTE_WITH_SESSION_KEY),
                emptyOp,
                bytes32(0)
            ),
            0,
            "hook alone allows an empty batch"
        );
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  3. Single source of truth — no re-sync                                          ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    function test_ownersAddThenRemoveRecipient_agentFollowsImmediately() public {
        assertTrue(_addSessionKey(account, agent.addr, bytes32("agent"), _transferOnlyGrant(), quorum));
        _expectSessionKeyValidationRevert(
            account,
            _calls(_erc20Transfer(address(usdc), stranger, 5e6)),
            agent,
            _aa23UnauthorizedRecipient(address(account), stranger)
        );

        // Owners promote the stranger through the AddressBook's own userOp path. No key update, no re-sync.
        assertTrue(_addRecipients(account, _one(stranger), quorum));
        assertEq(addressBookPlugin.getAllowedRecipients(address(account)).length, 2);
        assertTrue(_executeSessionKeyUserOp(account, _calls(_erc20Transfer(address(usdc), stranger, 5e6)), agent));
        assertEq(usdc.balanceOf(stranger), 5e6, "paid immediately after the owners' add");

        // Owners demote them again: the very next agent op is rejected.
        assertTrue(_removeRecipients(account, _one(stranger), quorum));
        _expectSessionKeyValidationRevert(
            account,
            _calls(_erc20Transfer(address(usdc), stranger, 5e6)),
            agent,
            _aa23UnauthorizedRecipient(address(account), stranger)
        );
        assertEq(usdc.balanceOf(stranger), 5e6);
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  4. The owners' path is untouched                                               ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    function test_ownersExecutePath_stillWorksAndIsStillAddressBookGated() public {
        assertTrue(
            _executeUserOp(
                account, _executeCalldata(address(usdc), 0, abi.encodeCall(IERC20.transfer, (allowed, 1e6))), quorum
            )
        );
        assertEq(usdc.balanceOf(allowed), 1e6);
        _expectValidationRevert(
            account, _executeCalldata(address(usdc), 0, abi.encodeCall(IERC20.transfer, (stranger, 1e6))), quorum
        );
        assertTrue(
            _executeUserOp(
                account,
                abi.encodeCall(IStandardExecutor.executeBatch, (_calls(_nativeTransfer(allowed, 1 ether)))),
                quorum
            )
        );
        assertEq(allowed.balance, 1 ether);
        assertEq(usdc.balanceOf(stranger), 0);
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  5. Uninstall semantics                                                          ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    /// @dev What the hook adds, shown by removing it: the same key pays the same stranger again.
    function test_uninstallHook_reopensTheGap() public {
        assertTrue(_addSessionKey(account, agent.addr, bytes32("agent"), _transferOnlyGrant(), quorum));
        _expectSessionKeyValidationRevert(
            account,
            _calls(_erc20Transfer(address(usdc), stranger, 1e6)),
            agent,
            _aa23UnauthorizedRecipient(address(account), stranger)
        );

        assertTrue(_executeUserOp(account, _uninstallPluginCalldata(address(hook)), quorum), "hook uninstall");
        assertEq(_userOpHooksOnSessionKeySelector(account).length, 0);
        assertEq(hook.addressBookOf(address(account)), address(0));

        assertTrue(_executeSessionKeyUserOp(account, _calls(_erc20Transfer(address(usdc), stranger, 1e6)), agent));
        assertEq(usdc.balanceOf(stranger), 1e6, "the documented gap, back");
    }

    /// @dev Hooks are not dependencies, so the owners CAN uninstall the AddressBook under the hook. Its set is
    ///      cleared on the way out, so the agent path closes completely while the owners' `execute` opens —
    ///      the hook never fails open. Reinstalling the AddressBook reopens the agent path with the new set.
    function test_uninstallAddressBook_hookFailsClosed() public {
        assertTrue(_addSessionKey(account, agent.addr, bytes32("agent"), _transferOnlyGrant(), quorum));
        assertTrue(_executeSessionKeyUserOp(account, _calls(_erc20Transfer(address(usdc), allowed, 1e6)), agent));

        assertTrue(
            _executeUserOp(account, _uninstallPluginCalldata(address(addressBookPlugin)), quorum),
            "AddressBook uninstall is not blocked by the hook"
        );
        assertFalse(_isInstalled(account, address(addressBookPlugin)));
        assertEq(addressBookPlugin.getAllowedRecipients(address(account)).length, 0, "set cleared on uninstall");
        assertEq(hook.addressBookOf(address(account)), address(addressBookPlugin), "binding kept");

        // Even the previously allowed recipient is now rejected: empty set, fail-closed.
        _expectSessionKeyValidationRevert(
            account,
            _calls(_erc20Transfer(address(usdc), allowed, 1e6)),
            agent,
            _aa23UnauthorizedRecipient(address(account), allowed)
        );
        // …while the owners, no longer AddressBook-gated, can pay anyone through `execute`.
        assertTrue(
            _executeUserOp(
                account, _executeCalldata(address(usdc), 0, abi.encodeCall(IERC20.transfer, (stranger, 1e6))), quorum
            )
        );
        assertEq(usdc.balanceOf(stranger), 1e6);

        // Reinstall with a fresh set: the agent path reopens for exactly that set.
        assertTrue(_installAddressBook(account, _one(allowed), quorum), "AddressBook reinstall");
        assertTrue(_executeSessionKeyUserOp(account, _calls(_erc20Transfer(address(usdc), allowed, 1e6)), agent));
        assertEq(usdc.balanceOf(allowed), 2e6);
        _expectSessionKeyValidationRevert(
            account,
            _calls(_erc20Transfer(address(usdc), stranger, 1e6)),
            agent,
            _aa23UnauthorizedRecipient(address(account), stranger)
        );
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  6. Isolation                                                                    ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    /// @dev One hook plugin, one AddressBook plugin, two accounts: each agent sees only its own account's set.
    function test_isolation_twoAccountsDifferentSets() public {
        address otherAllowed = makeAddr("other-allowed");
        (UpgradableMSCA other, Signer[] memory otherQuorum) =
            _newAccount("other", bytes32(uint256(44)), _one(otherAllowed), true);
        Signer memory otherAgent = _signerFrom("other-agent");

        assertTrue(_addSessionKey(account, agent.addr, bytes32("agent"), _transferOnlyGrant(), quorum));
        assertTrue(_addSessionKey(other, otherAgent.addr, bytes32("agent"), _transferOnlyGrant(), otherQuorum));
        assertEq(hook.addressBookOf(address(other)), address(addressBookPlugin));

        assertTrue(_executeSessionKeyUserOp(account, _calls(_erc20Transfer(address(usdc), allowed, 1e6)), agent));
        _expectSessionKeyValidationRevert(
            account,
            _calls(_erc20Transfer(address(usdc), otherAllowed, 1e6)),
            agent,
            _aa23UnauthorizedRecipient(address(account), otherAllowed)
        );

        assertTrue(
            _executeSessionKeyUserOp(other, _calls(_erc20Transfer(address(usdc), otherAllowed, 1e6)), otherAgent)
        );
        _expectSessionKeyValidationRevert(
            other,
            _calls(_erc20Transfer(address(usdc), allowed, 1e6)),
            otherAgent,
            _aa23UnauthorizedRecipient(address(other), allowed)
        );
        assertEq(usdc.balanceOf(allowed), 1e6);
        assertEq(usdc.balanceOf(otherAllowed), 1e6);
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  7. Gas                                                                          ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    /// @dev Same grant, same op, same 5-entry AddressBook on two accounts — one hooked, one not. Both are warmed
    ///      with one op first so nonce / balance slots are already non-zero; the second op is measured.
    function test_gas_hookedVsUnhooked_fiveRecipients() public {
        address[] memory five = new address[](5);
        five[0] = makeAddr("r1");
        five[1] = makeAddr("r2");
        five[2] = makeAddr("r3");
        five[3] = makeAddr("r4");
        five[4] = allowed;
        (UpgradableMSCA hooked, Signer[] memory hq) = _newAccount("hooked", bytes32(uint256(45)), five, true);
        (UpgradableMSCA unhooked, Signer[] memory uq) = _newAccount("unhooked", bytes32(uint256(46)), five, false);
        Signer memory hookedAgent = _signerFrom("hooked-agent");
        Signer memory unhookedAgent = _signerFrom("unhooked-agent");
        assertTrue(_addSessionKey(hooked, hookedAgent.addr, bytes32("agent"), _transferOnlyGrant(), hq));
        assertTrue(_addSessionKey(unhooked, unhookedAgent.addr, bytes32("agent"), _transferOnlyGrant(), uq));

        Call[] memory pay = _calls(_erc20Transfer(address(usdc), allowed, 1e6));
        (bool ok,) = _sessionKeyOpGas(hooked, pay, hookedAgent);
        assertTrue(ok);
        (ok,) = _sessionKeyOpGas(unhooked, pay, unhookedAgent);
        assertTrue(ok);

        uint256 gasHooked;
        uint256 gasUnhooked;
        (ok, gasHooked) = _sessionKeyOpGas(hooked, pay, hookedAgent);
        assertTrue(ok);
        (ok, gasUnhooked) = _sessionKeyOpGas(unhooked, pay, unhookedAgent);
        assertTrue(ok);

        emit log_named_uint("session-key USDC transfer, unhooked (actualGasUsed)", gasUnhooked);
        emit log_named_uint("session-key USDC transfer, hooked, 5-entry allowlist (actualGasUsed)", gasHooked);
        emit log_named_uint("hook overhead", gasHooked - gasUnhooked);
        assertGt(gasHooked, gasUnhooked);
        assertLt(gasHooked - gasUnhooked, HOOK_GAS_BOUND, "hook overhead within the informational bound");
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  8. Direct-call surface                                                          ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    function test_runtimePath_stillRejectedAtTheAccount() public {
        assertTrue(_addSessionKey(account, agent.addr, bytes32("agent"), _permUnrestricted(), quorum));
        vm.prank(agent.addr);
        (bool ok,) = address(account)
            .call(_executeWithSessionKeyCalldata(_calls(_erc20Transfer(address(usdc), allowed, 1e6)), agent.addr));
        assertFalse(ok, "runtime executeWithSessionKey is rejected before any hook runs");
        assertEq(usdc.balanceOf(allowed), 0);
    }

    function test_directCalls_unknownFunctionId_and_unboundAccount() public {
        PackedUserOperation memory op =
            _buildSessionKeyUserOp(account, _calls(_erc20Transfer(address(usdc), allowed, 1e6)), agent.addr);

        vm.expectRevert(abi.encodeWithSelector(NotImplemented.selector, hook.preUserOpValidationHook.selector, 7));
        hook.preUserOpValidationHook(7, op, bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(NotImplemented.selector, hook.preRuntimeValidationHook.selector, 7));
        hook.preRuntimeValidationHook(7, agent.addr, 0, op.callData);

        // An account that never bound an AddressBook cannot pass the hook (fail-closed, not fail-open).
        vm.prank(stranger);
        vm.expectRevert(BasePlugin.NotInitialized.selector);
        hook.preUserOpValidationHook(
            uint8(BufiSessionRecipientHookPlugin.FunctionId.PRE_USER_OP_VALIDATION_HOOK_EXECUTE_WITH_SESSION_KEY),
            op,
            bytes32(0)
        );

        // The runtime hook applies the same recipient rule when called with the account as sender.
        vm.prank(address(account));
        hook.preRuntimeValidationHook(
            uint8(BufiSessionRecipientHookPlugin.FunctionId.PRE_RUNTIME_VALIDATION_HOOK_EXECUTE_WITH_SESSION_KEY),
            agent.addr,
            0,
            op.callData
        );
        bytes memory toStranger =
            _executeWithSessionKeyCalldata(_calls(_erc20Transfer(address(usdc), stranger, 1e6)), agent.addr);
        vm.prank(address(account));
        vm.expectRevert(
            abi.encodeWithSelector(
                IBufiSessionRecipientHookPlugin.UnauthorizedRecipient.selector, address(account), stranger
            )
        );
        hook.preRuntimeValidationHook(
            uint8(BufiSessionRecipientHookPlugin.FunctionId.PRE_RUNTIME_VALIDATION_HOOK_EXECUTE_WITH_SESSION_KEY),
            agent.addr,
            0,
            toStranger
        );
    }
}
