// SPDX-License-Identifier: GPL-3.0-or-later
//
// BUFI-6900 — new, unaudited BUFI code. This is NOT part of the audited Alchemy session-key port and NOT Circle
// code. Copyright 2026 BUFI. This program is free software: you can redistribute it and/or modify it under the
// terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version. It is distributed WITHOUT ANY WARRANTY; see
// <https://www.gnu.org/licenses/>.
pragma solidity 0.8.24;

import {IBufiSessionKeyPlugin} from "../session/IBufiSessionKeyPlugin.sol";
import {IBufiSessionRecipientHookPlugin} from "./IBufiSessionRecipientHookPlugin.sol";

import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {SIG_VALIDATION_SUCCEEDED} from "@circle/common/Constants.sol";
import {RecipientAddressLib} from "@circle/libs/RecipientAddressLib.sol";
import {NotImplemented} from "@circle/msca/6900/shared/common/Errors.sol";
import {
    ManifestAssociatedFunction,
    ManifestAssociatedFunctionType,
    ManifestFunction,
    PluginManifest,
    PluginMetadata
} from "@circle/msca/6900/v0.7/common/PluginManifest.sol";
import {Call} from "@circle/msca/6900/v0.7/common/Structs.sol";
import {IAccountLoupe} from "@circle/msca/6900/v0.7/interfaces/IAccountLoupe.sol";
import {BasePlugin} from "@circle/msca/6900/v0.7/plugins/BasePlugin.sol";
import {IAddressBookPlugin} from "@circle/msca/6900/v0.7/plugins/v1_0_0/addressbook/IAddressBookPlugin.sol";
import {ERC165Checker} from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";

/// @title BufiSessionRecipientHookPlugin
/// @author BUFI
/// @notice Pre-validation hook that closes the ERC-20 recipient gap of agent session keys on a Circle ERC-6900
///         v0.7 account: every `Call` inside `BufiSessionKeyPlugin.executeWithSessionKey(calls, sessionKey)` must
///         name a recipient that is in the account's `ColdStorageAddressBookPlugin` set, exactly as the owners'
///         own `execute` / `executeBatch` are gated.
///
/// @dev **Status: new, unaudited BUFI code.** Purpose and mechanism:
///
///      Circle's AddressBook registers its pre-userOp / pre-runtime validation hooks on `execute` and
///      `executeBatch` only (hooks are keyed by selector). `executeWithSessionKey` is the session-key plugin's own
///      selector, so an agent key scoped to `USDC.transfer` may name ANY recipient — the key's access list sees
///      `Call.target` + selector, never the recipient inside ERC-20 calldata. This plugin registers a
///      `preUserOpValidationHook` (and the matching `preRuntimeValidationHook`) on that selector, decodes
///      `(Call[] calls, address sessionKey)` from the userOp calldata, resolves each call's recipient with logic
///      identical to `ColdStorageAddressBookPlugin._getTargetOrRecipient` (same `RecipientAddressLib`, same
///      errors, same fail-closed branches) and requires it to be in
///      `IAddressBookPlugin(addressBook).getAllowedRecipients(account)`.
///
///      **The AddressBook set is the single source of truth for BOTH paths.** The owners' `execute` path and the
///      agent path read the same on-chain set; there is no mirrored per-key list to re-sync. An owner-side
///      `addAllowedRecipients` is visible to the agent in the next op; `removeAllowedRecipients` closes it in the
///      next op.
///
///      **Install.** Install data is `abi.encode(address addressBookPlugin)`. The address must be non-zero, have
///      code, declare `IAddressBookPlugin` through ERC-165 and be an installed plugin of the installing account
///      (read through `IAccountLoupe.getInstalledPlugins` — install runs in the execution phase, so the loupe
///      call is unconstrained). Binding the hook to a plugin the account itself installed is what makes "same set
///      as the owners" a checked property rather than a convention. Hooks resolve with an empty dependency list
///      in Circle's `PluginManager.install`, so the hook is `SELF`-typed and declares no dependencies: it can be
///      installed before or after the session-key plugin (a pre-hook on a selector that has no execution function
///      yet is simply stored), and neither plugin's uninstall is blocked by the other.
///
///      **ERC-4337 / ERC-7562 validation constraints** (the hook runs inside `validateUserOp`):
///        - Storage: this plugin reads only `_addressBookOf[account]`, a mapping keyed by the account
///          (account-associated storage, [STO-021]), and the AddressBook's `AssociatedLinkedListSet`, which is
///          also keyed by the account. No plugin-global storage is touched.
///        - No `TIMESTAMP` / `NUMBER` / `BALANCE` / `GASPRICE`, no state writes, no value transfers.
///        - External calls: one `STATICCALL` into the AddressBook plugin (`getAllowedRecipients`) and one
///          `EXTCODESIZE` per zero-value call (`target.code.length`). Calling into another deployed contract is
///          the same class of access every plugin call already is — the account itself calls the AddressBook's
///          hook on `execute` — but a strict bundler tracer may still surface the cross-contract view; document
///          it in the bundler allowlist if one is used. `EXTCODESIZE` on an address WITHOUT code is itself an
///          [OP-041] violation; that branch reverts `InvalidTargetCodeLength` regardless, so the op is rejected
///          either way, only the reported reason differs.
///        - Membership is a linear scan over the array `getAllowedRecipients` returns: O(calls × n) memory
///          compares after an O(n) storage walk. Circle's set has an O(1) `contains`, but it is `internal` to
///          `AssociatedLinkedListSetLib` and the plugin exposes no single-recipient view. If Circle exposes one,
///          replace `_contains` with it; nothing else changes.
///        - The hook runs BEFORE the session-key plugin's own signature check (Circle's account runs every
///          pre-userOp hook first), so its cost is paid on simulation for any op naming the selector, bounded by
///          the set size.
///
///      **Fail-closed by construction.** Undecodable calldata reverts (Solidity's ABI decoder); a recipient that
///      cannot be decoded resolves to `address(0)`, which is never in the set; an AddressBook that is uninstalled
///      clears its set on the way out (`onUninstall`, sets under 5000 entries), so the agent path closes with it
///      while the owners' `execute` path opens. For a set of 5000+ entries Circle's `onUninstall` leaves the set
///      in place (`AllowedAddressesNotRemoved`): the hook then keeps enforcing that frozen set — it never widens.
///      Empty `calls` pass this hook (nothing moves); the session-key plugin's own validation still rejects a
///      zero-call op (audited upstream rule), so nothing changes at the account level. An unknown `functionId`
///      reverts `NotImplemented`.
contract BufiSessionRecipientHookPlugin is BasePlugin, IBufiSessionRecipientHookPlugin {
    using RecipientAddressLib for bytes;

    string internal constant _NAME = "BUFI Session Recipient Hook Plugin";
    string internal constant _VERSION = "0.1.0";
    string internal constant _AUTHOR = "BUFI";

    /// @dev Function ids of the two hooks this plugin implements (both `SELF`-typed in the manifest).
    enum FunctionId {
        PRE_USER_OP_VALIDATION_HOOK_EXECUTE_WITH_SESSION_KEY,
        PRE_RUNTIME_VALIDATION_HOOK_EXECUTE_WITH_SESSION_KEY
    }

    /// @dev Account-associated storage (ERC-7562 [STO-021]): the AddressBook plugin each account bound at install.
    mapping(address account => address addressBook) internal _addressBookOf;

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Views                                                                          ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    /// @inheritdoc IBufiSessionRecipientHookPlugin
    function addressBookOf(address account) external view override returns (address) {
        return _addressBookOf[account];
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Plugin lifecycle                                                               ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    /// @inheritdoc BasePlugin
    /// @dev `data` = `abi.encode(address addressBookPlugin)`. Reverts (and so fails the whole `installPlugin`,
    ///      wrapped in `FailToCallOnInstall`) unless the address has code, declares `IAddressBookPlugin` and is
    ///      installed on the calling account.
    function onInstall(bytes calldata data) external override isNotInitialized(msg.sender) {
        address addressBook = abi.decode(data, (address));
        if (
            addressBook == address(0) || addressBook.code.length == 0
                || !ERC165Checker.supportsInterface(addressBook, type(IAddressBookPlugin).interfaceId)
        ) {
            revert InvalidAddressBook(addressBook);
        }
        if (!_isInstalledOn(msg.sender, addressBook)) {
            revert AddressBookNotInstalled(msg.sender, addressBook);
        }
        _addressBookOf[msg.sender] = addressBook;
        emit AddressBookBound(msg.sender, addressBook);
    }

    /// @inheritdoc BasePlugin
    function onUninstall(bytes calldata) external override isInitialized(msg.sender) {
        address addressBook = _addressBookOf[msg.sender];
        delete _addressBookOf[msg.sender];
        emit AddressBookUnbound(msg.sender, addressBook);
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Hooks                                                                          ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    /// @inheritdoc BasePlugin
    /// @dev Only compatible with `IBufiSessionKeyPlugin.executeWithSessionKey` calldata, as the manifest binds it.
    ///      Returns `SIG_VALIDATION_SUCCEEDED` (no time bounds) when every recipient is allowed; reverts otherwise.
    function preUserOpValidationHook(uint8 functionId, PackedUserOperation calldata userOp, bytes32)
        external
        view
        override
        returns (uint256)
    {
        if (functionId != uint8(FunctionId.PRE_USER_OP_VALIDATION_HOOK_EXECUTE_WITH_SESSION_KEY)) {
            revert NotImplemented(msg.sig, functionId);
        }
        _verifyRecipients(userOp.callData);
        return SIG_VALIDATION_SUCCEEDED;
    }

    /// @inheritdoc BasePlugin
    /// @dev Circle's account already rejects the runtime path to `executeWithSessionKey` (no runtime validation
    ///      function → `InvalidValidationFunctionId`) before any pre-runtime hook runs. Registered anyway so the
    ///      recipient invariant holds if that ever changes.
    function preRuntimeValidationHook(uint8 functionId, address, uint256, bytes calldata data) external view override {
        if (functionId != uint8(FunctionId.PRE_RUNTIME_VALIDATION_HOOK_EXECUTE_WITH_SESSION_KEY)) {
            revert NotImplemented(msg.sig, functionId);
        }
        _verifyRecipients(data);
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Manifest / metadata                                                            ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    /// @inheritdoc BasePlugin
    /// @dev Hooks only. No execution functions, no dependencies (`PluginManager` resolves hooks with an empty
    ///      dependency list, so `SELF` is the only admissible type), no external-call permission, cannot spend
    ///      native tokens.
    function pluginManifest() external pure override returns (PluginManifest memory manifest) {
        manifest.preUserOpValidationHooks = new ManifestAssociatedFunction[](1);
        manifest.preUserOpValidationHooks[0] = ManifestAssociatedFunction({
            executionSelector: IBufiSessionKeyPlugin.executeWithSessionKey.selector,
            associatedFunction: ManifestFunction({
                functionType: ManifestAssociatedFunctionType.SELF,
                functionId: uint8(FunctionId.PRE_USER_OP_VALIDATION_HOOK_EXECUTE_WITH_SESSION_KEY),
                dependencyIndex: 0 // unused for SELF
            })
        });

        manifest.preRuntimeValidationHooks = new ManifestAssociatedFunction[](1);
        manifest.preRuntimeValidationHooks[0] = ManifestAssociatedFunction({
            executionSelector: IBufiSessionKeyPlugin.executeWithSessionKey.selector,
            associatedFunction: ManifestFunction({
                functionType: ManifestAssociatedFunctionType.SELF,
                functionId: uint8(FunctionId.PRE_RUNTIME_VALIDATION_HOOK_EXECUTE_WITH_SESSION_KEY),
                dependencyIndex: 0 // unused for SELF
            })
        });

        manifest.interfaceIds = new bytes4[](1);
        manifest.interfaceIds[0] = type(IBufiSessionRecipientHookPlugin).interfaceId;

        // Defaults kept explicit: the hook never calls out through the account and never spends native tokens.
        manifest.permitAnyExternalAddress = false;
        manifest.canSpendNativeToken = false;
        return manifest;
    }

    /// @inheritdoc BasePlugin
    function pluginMetadata() external pure override returns (PluginMetadata memory metadata) {
        metadata.name = _NAME;
        metadata.version = _VERSION;
        metadata.author = _AUTHOR;
        // No execution functions → no permission descriptors.
        return metadata;
    }

    /// @inheritdoc BasePlugin
    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == type(IBufiSessionRecipientHookPlugin).interfaceId || super.supportsInterface(interfaceId);
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Internals                                                                      ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    /// @inheritdoc BasePlugin
    /// @notice Whether `account` has installed this hook, i.e. bound an AddressBook to it.
    /// @param account The account to check.
    /// @return True when a non-zero AddressBook is bound for `account`.
    function _isInitialized(address account) internal view override returns (bool) {
        return _addressBookOf[account] != address(0);
    }

    /// @dev `callData` is the account-level calldata `executeWithSessionKey(Call[] calls, address sessionKey)`;
    ///      Circle's `BaseMSCA` guarantees at least 4 bytes before any hook runs, and the slice / decoder revert on
    ///      anything shorter or malformed (fail-closed). Reverts unless EVERY call's recipient is in the bound
    ///      AddressBook's set for `msg.sender` (the account).
    function _verifyRecipients(bytes calldata callData) internal view {
        address addressBook = _addressBookOf[msg.sender];
        if (addressBook == address(0)) {
            revert NotInitialized();
        }
        (Call[] memory calls,) = abi.decode(callData[4:], (Call[], address));
        uint256 length = calls.length;
        if (length == 0) {
            return; // nothing moves
        }
        address[] memory allowed = IAddressBookPlugin(addressBook).getAllowedRecipients(msg.sender);
        for (uint256 i = 0; i < length; ++i) {
            address recipient = _getTargetOrRecipient(calls[i].target, calls[i].value, calls[i].data);
            if (!_contains(allowed, recipient)) {
                revert UnauthorizedRecipient(msg.sender, recipient);
            }
        }
    }

    /// @dev Byte-for-byte the semantics of `ColdStorageAddressBookPlugin._getTargetOrRecipient`: a native transfer
    ///      must carry no calldata and no zero target (recipient = target); a zero-value call must target code and
    ///      carry an ERC-20, then ERC-1155, then ERC-721 selector the library can decode (recipient = the decoded
    ///      address); everything else reverts.
    function _getTargetOrRecipient(address target, uint256 value, bytes memory data) internal view returns (address) {
        if (value != 0) {
            if (data.length != 0) {
                revert CallDataIsNotEmpty(msg.sender, target, value, data);
            }
            if (target == address(0)) {
                revert UnauthorizedRecipient(msg.sender, target);
            }
            return target;
        }
        if (target.code.length == 0) {
            revert InvalidTargetCodeLength(msg.sender, target, value, data);
        }
        address recipient = data.getERC20TokenRecipient();
        if (recipient == address(0)) {
            recipient = data.getERC1155TokenRecipient();
        }
        if (recipient == address(0)) {
            recipient = data.getERC721TokenRecipient();
        }
        // DELIBERATE DIVERGENCE from `ColdStorageAddressBookPlugin`, which reverts here.
        //
        // Circle's plugin guards the owners' `execute` path, where every call is expected to be a transfer, so
        // "no decodable recipient" can safely mean "reject". An agent face is not like that: a session key's whole
        // purpose is calling business contracts — `createJob` / `setBudget` / `fund` on an ERC-8183 escrow,
        // `giveFeedback` on a reputation registry — whose calldata carries no token recipient at all. Reverting
        // here made the hook and the agentic rails mutually exclusive: with the hook installed, an agent could
        // only ever move tokens, never do work (proved on an Arc fork before this branch existed).
        //
        // So for a zero-value call whose calldata is not a recognised token transfer, the CALL TARGET itself must
        // be on the AddressBook. That is still fail-closed — an unlisted contract is rejected — and it is the same
        // trust statement the list already makes: "this account may send value to this address". What it does not
        // do is turn the AddressBook into a firewall against a contract the owners allowlisted; that contract may
        // interpret its own calldata however it likes (adversarial findings F-02 / F-03).
        //
        // Note the asymmetry that keeps token policy intact: a *decodable* transfer is always judged by its
        // recipient, never by its target. `USDC.transfer(stranger, …)` is rejected even though USDC has code, and
        // is rejected whether or not USDC is on the list.
        return recipient == address(0) ? target : recipient;
    }

    /// @dev Linear membership scan (see the contract NatSpec for the cost note).
    function _contains(address[] memory set, address value) internal pure returns (bool) {
        uint256 length = set.length;
        for (uint256 i = 0; i < length; ++i) {
            if (set[i] == value) {
                return true;
            }
        }
        return false;
    }

    /// @dev Execution-phase only (called from `onInstall`): is `plugin` in the account's installed-plugin list?
    function _isInstalledOn(address account, address plugin) internal view returns (bool) {
        address[] memory installed = IAccountLoupe(account).getInstalledPlugins();
        return _contains(installed, plugin);
    }
}
