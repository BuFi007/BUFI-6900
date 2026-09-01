// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {SessionKeyHarness} from "../../../harness/SessionKeyHarness.sol";

import {IBufiSessionKeyPlugin} from "../../../../src/bufi/v0.7/session/IBufiSessionKeyPlugin.sol";
import {SandboxUSDC} from "../../../../src/sandbox/SandboxUSDC.sol";

import {UpgradableMSCA} from "@circle/msca/6900/v0.7/account/UpgradableMSCA.sol";
import {ExecutionHooks, FunctionReference} from "@circle/msca/6900/v0.7/common/Structs.sol";
import {IPluginExecutor} from "@circle/msca/6900/v0.7/interfaces/IPluginExecutor.sol";
import {IStandardExecutor} from "@circle/msca/6900/v0.7/interfaces/IStandardExecutor.sol";

/// @notice Composition of BufiSessionKeyPlugin with Circle's ColdStorageAddressBookPlugin on the SAME account.
///
///         FINDING (proven below, recorded in PORT-NOTES.md "Composition findings"): the AddressBook plugin does
///         NOT gate session-key transfers. Its pre-userOp / pre-runtime validation hooks are registered on the
///         `execute` and `executeBatch` selectors only, and it registers no execution hooks at all — so a
///         session-key userOp (`executeWithSessionKey` selector, executed through `executeFromPluginExternal`)
///         never touches it. Recipient enforcement for an agent key is therefore ONLY the key's own access list,
///         which sees `Call.target` + selector, not the recipient encoded inside ERC-20 calldata:
///           - native-value transfers ARE gateable (target == recipient) → the AND-gate holds;
///           - ERC-20 transfers are NOT gateable per recipient with the stock permission model.
contract SessionKeyWithAddressBookTest is SessionKeyHarness {
    UpgradableMSCA internal account;
    Signer[] internal quorum;
    Signer internal agent;

    SandboxUSDC internal usdc;
    address internal allowed;
    address internal stranger;

    function setUp() public {
        _deployCircleCanonicalStack();
        _deploySessionKeyPlugin();

        Signer[] memory owners = _makeSigners("owner", 3);
        account = _createWeightedMsca(owners, _uniformWeights(3, 1), 2, bytes32(uint256(21)));
        quorum.push(owners[0]);
        quorum.push(owners[2]);

        allowed = makeAddr("allowed-recipient");
        stranger = makeAddr("stranger");
        address[] memory recipients = new address[](1);
        recipients[0] = allowed;
        assertTrue(_installAddressBook(account, recipients, quorum), "address book install");
        assertTrue(_installSessionKeyPlugin(account, quorum), "session key plugin install");

        agent = _signerFrom("agent");
        usdc = new SandboxUSDC();
        usdc.mint(address(account), 1_000e6);
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Do the AddressBook hooks fire for executeWithSessionKey? (No.)                 ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    function test_addressBookHooksAreBoundToExecuteSelectorsOnly() public view {
        (FunctionReference[] memory userOpHooks, FunctionReference[] memory runtimeHooks) =
            account.getPreValidationHooks(IStandardExecutor.execute.selector);
        assertEq(userOpHooks.length, 1, "execute: AddressBook pre-userOp hook");
        assertEq(userOpHooks[0].plugin, address(addressBookPlugin));
        assertEq(runtimeHooks.length, 1, "execute: AddressBook pre-runtime hook");

        (userOpHooks, runtimeHooks) = account.getPreValidationHooks(IStandardExecutor.executeBatch.selector);
        assertEq(userOpHooks.length, 1, "executeBatch: AddressBook pre-userOp hook");
        assertEq(userOpHooks[0].plugin, address(addressBookPlugin));

        (userOpHooks, runtimeHooks) =
            account.getPreValidationHooks(IBufiSessionKeyPlugin.executeWithSessionKey.selector);
        assertEq(userOpHooks.length, 0, "executeWithSessionKey: NO pre-userOp hook");
        assertEq(runtimeHooks.length, 1, "executeWithSessionKey: only the plugin's own always-deny runtime hook");
        assertTrue(runtimeHooks[0].plugin != address(addressBookPlugin));

        ExecutionHooks[] memory execHooks =
            account.getExecutionHooks(IPluginExecutor.executeFromPluginExternal.selector);
        assertEq(execHooks.length, 0, "executeFromPluginExternal: NO execution hooks");
    }

    function test_addressBookDoesNotGateSessionKeyTransfers() public {
        // The owners are gated: `execute` to a stranger is rejected by the AddressBook hook.
        _expectValidationRevert(
            account, _executeCalldata(address(usdc), 0, abi.encodeCall(usdc.transfer, (stranger, 1e6))), quorum
        );

        // An unrestricted session key is NOT: the same transfer, through executeWithSessionKey, goes through.
        assertTrue(_addSessionKey(account, agent.addr, bytes32(0), _permUnrestricted(), quorum));
        assertTrue(_executeSessionKeyUserOp(account, _calls(_erc20Transfer(address(usdc), stranger, 1e6)), agent));
        assertEq(usdc.balanceOf(stranger), 1e6, "AddressBook did not fire for the session key");

        // Same for native value.
        assertTrue(_executeSessionKeyUserOp(account, _calls(_nativeTransfer(stranger, 1 ether)), agent));
        assertEq(stranger.balance, 1 ether);
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  The intended AND-gate: key access list = AddressBook recipients                ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    /// @dev Mirrors the on-chain AddressBook set into the key's allowlist as address entries.
    function _recipientAllowlist() internal view returns (bytes[] memory updates) {
        address[] memory recipients = addressBookPlugin.getAllowedRecipients(address(account));
        updates = new bytes[](recipients.length + 1);
        for (uint256 i = 0; i < recipients.length; i++) {
            updates[i] = _permAddressEntry(recipients[i], true, false);
        }
        updates[recipients.length] = _permNativeLimit(10 ether, 0);
    }

    function test_andGate_nativeRecipients_strangerRejected() public {
        assertTrue(_addSessionKey(account, agent.addr, bytes32("agent"), _recipientAllowlist(), quorum));

        assertTrue(_executeSessionKeyUserOp(account, _calls(_nativeTransfer(allowed, 1 ether)), agent));
        assertEq(allowed.balance, 1 ether);

        _expectSessionKeyValidationRevert(
            account, _calls(_nativeTransfer(stranger, 1 ether)), agent, _aa23PermissionsCheckFailed()
        );
        assertEq(stranger.balance, 0);

        // A batch that mixes an allowed and a stranger recipient is rejected as a whole.
        _expectSessionKeyValidationRevert(
            account,
            _calls(_nativeTransfer(allowed, 1 ether), _nativeTransfer(stranger, 1 ether)),
            agent,
            _aa23PermissionsCheckFailed()
        );
        assertEq(allowed.balance, 1 ether);
    }

    /// @dev Owners extend the AddressBook (userOp path) and the key's list is re-synced — a stranger promoted to
    ///      a recipient becomes reachable only after BOTH updates.
    function test_andGate_followsAddressBookUpdates() public {
        assertTrue(_addSessionKey(account, agent.addr, bytes32("agent"), _recipientAllowlist(), quorum));
        _expectSessionKeyValidationRevert(
            account, _calls(_nativeTransfer(stranger, 1 ether)), agent, _aa23PermissionsCheckFailed()
        );

        address[] memory add = new address[](1);
        add[0] = stranger;
        assertTrue(_executeUserOp(account, abi.encodeWithSignature("addAllowedRecipients(address[])", add), quorum));
        assertEq(addressBookPlugin.getAllowedRecipients(address(account)).length, 2);

        // AddressBook updated, key list not yet: still rejected.
        _expectSessionKeyValidationRevert(
            account, _calls(_nativeTransfer(stranger, 1 ether)), agent, _aa23PermissionsCheckFailed()
        );

        assertTrue(_updateKeyPermissions(account, agent.addr, _recipientAllowlist(), quorum));
        assertTrue(_executeSessionKeyUserOp(account, _calls(_nativeTransfer(stranger, 1 ether)), agent));
        assertEq(stranger.balance, 1 ether);
    }

    /// @dev The ERC-20 half of the AND-gate is NOT achievable with the key's access list: restricting the key to
    ///      `USDC.transfer` still lets it pick ANY recipient, because the recipient is inside calldata the access
    ///      list never decodes. This test pins the actual behaviour so the gap is visible, not assumed.
    function test_erc20RecipientIsNotGatedBySessionKeyAccessList() public {
        assertTrue(
            _addSessionKey(
                account,
                agent.addr,
                bytes32("agent"),
                _updates(
                    _permAddressEntry(address(usdc), true, true),
                    _permFunctionEntry(address(usdc), usdc.transfer.selector, true),
                    _permErc20Limit(address(usdc), 100e6, 0)
                ),
                quorum
            )
        );

        assertTrue(_executeSessionKeyUserOp(account, _calls(_erc20Transfer(address(usdc), allowed, 10e6)), agent));
        assertEq(usdc.balanceOf(allowed), 10e6);

        // Not on the AddressBook, not in any key list — and still paid.
        assertTrue(_executeSessionKeyUserOp(account, _calls(_erc20Transfer(address(usdc), stranger, 10e6)), agent));
        assertEq(usdc.balanceOf(stranger), 10e6, "ERC-20 recipient is not gated (documented gap)");

        // What the key's list DOES enforce on the ERC-20 path: the token contract and the selector.
        _expectSessionKeyValidationRevert(
            account, _calls(_erc20Approve(address(usdc), stranger, 10e6)), agent, _aa23PermissionsCheckFailed()
        );
        SandboxUSDC otherToken = new SandboxUSDC();
        otherToken.mint(address(account), 100e6);
        _expectSessionKeyValidationRevert(
            account, _calls(_erc20Transfer(address(otherToken), allowed, 1e6)), agent, _aa23PermissionsCheckFailed()
        );
    }
}
