// SPDX-License-Identifier: GPL-3.0-or-later
//
// BUFI-6900 — new, unaudited BUFI code. NOT Circle code. Copyright 2026 BUFI. GPL-3.0-or-later; see
// <https://www.gnu.org/licenses/>.
pragma solidity 0.8.24;

import {GatewayIntentGuardCore, IAccountAddressBook} from "./GatewayIntentGuardCore.sol";
import {GatewayGuardInit, IGatewayIntentGuard} from "./IGatewayIntentGuard.sol";

import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {IModule} from "@erc6900/reference-implementation/interfaces/IModule.sol";
import {IValidationHookModule} from "@erc6900/reference-implementation/interfaces/IValidationHookModule.sol";
import {IERC165} from "@openzeppelin/contracts/interfaces/IERC165.sol";
import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";

/// @title GatewayIntentGuardModule
/// @author BUFI
/// @notice ERC-6900 **v0.8** packaging of the GatewayTreasury policy: a VALIDATION HOOK attached to a Circle
///         `WeightedMultisigValidationModule` validation entity. When Gateway (or USDC, for an ERC-3009 deposit) asks
///         the account `isValidSignature(hash, signature)`, Circle's v0.8 `BaseMSCA` runs
///         `preSignatureValidationHook(entityId, msg.sender, hash, hookSegment)` for every hook of the selected
///         validation BEFORE calling `WeightedMultisigValidationModule.validateSignature` with the final segment.
///         This module decodes its segment as the envelope `abi.encode(uint8 kind, bytes payload)`, re-derives the
///         EIP-712 digest and requires it to equal `hash`, then enforces the account's allowlists, caps and expiry.
///         The quorum stays the multisig module's job.
///
/// @dev **Why this is the faithful v0.8 integration point.** v0.8 gives signature validation its own hook, with its
///      own per-hook signature segment (`[ModuleEntity][index ‖ len ‖ segment]…[0xff][validation sig]`), the
/// hash,
///      and the ERC-1271 caller. No trailer tricks (as in v0.7) and no selector-level hooks are needed: the payload
///      reaches only the guard, the owners' signature reaches only the multisig module, and a missing segment
///      reaches the guard as empty bytes (rejected).
///
///      **Scope of the guard.** A validation hook runs for every use of the validation it is attached to. The
///      userOp and runtime hooks here are no-ops (they return success), so the owners' ordinary operations are
///      unaffected; only ERC-1271 through this validation requires an envelope. The guard binds only the
///      validation(s) it is attached to: any OTHER validation of the account with `isSignatureValidation` set is an
///      unguarded ERC-1271 path. Attach the hook to every signature-capable validation (or clear that flag on the
///      others) for the policy to hold. Circle's v0.8 account cannot remove a single hook; detaching it means
///      uninstalling the whole validation (the owners can, through their quorum).
///
///      **Admin.** Setters are called by the account itself (`execute(module, 0, setGateway…(…))`), so they are
///      gated by the account's own validation (the owners' quorum); writes are keyed by `msg.sender`.
contract GatewayIntentGuardModule is IValidationHookModule, ERC165, GatewayIntentGuardCore {
    string internal constant _MODULE_ID = "bufi.gateway-intent-guard.0.1.0";

    /// @inheritdoc IModule
    /// @dev `data` = `abi.encode(GatewayGuardInit)`. Called by the account when the hook is attached with data.
    function onInstall(bytes calldata data) external override {
        _install(msg.sender, abi.decode(data, (GatewayGuardInit)));
    }

    /// @inheritdoc IModule
    function onUninstall(bytes calldata) external override {
        _uninstall(msg.sender);
    }

    /// @inheritdoc IModule
    function moduleId() external pure override returns (string memory) {
        return _MODULE_ID;
    }

    /// @inheritdoc IValidationHookModule
    /// @dev No-op: the guard constrains ERC-1271 only; userOps of the owners' validation pass through.
    function preUserOpValidationHook(uint32, PackedUserOperation calldata, bytes32)
        external
        pure
        override
        returns (uint256)
    {
        return 0;
    }

    /// @inheritdoc IValidationHookModule
    /// @dev No-op, same reason as `preUserOpValidationHook`.
    function preRuntimeValidationHook(uint32, address, uint256, bytes calldata, bytes calldata)
        external
        pure
        override
    {}

    /// @inheritdoc IValidationHookModule
    /// @dev `msg.sender` is the account, `sender` the ERC-1271 caller, `signature` this hook's segment only.
    function preSignatureValidationHook(uint32, address sender, bytes32 hash, bytes calldata signature)
        external
        view
        override
    {
        (uint8 kind, bytes memory payload) = _decodeEnvelope(signature);
        _checkIntent(msg.sender, sender, hash, kind, payload);
    }

    /// @inheritdoc ERC165
    function supportsInterface(bytes4 interfaceId) public view override(ERC165, IERC165) returns (bool) {
        return interfaceId == type(IValidationHookModule).interfaceId || interfaceId == type(IModule).interfaceId
            || interfaceId == type(IGatewayIntentGuard).interfaceId || super.supportsInterface(interfaceId);
    }

    /// @dev v0.8: the account's view of installed modules is per validation/selector, so "installed on the account"
    ///      is not a cheap check. Require code and a working account-keyed `getAllowedRecipients` view; the address
    ///      is chosen by the owners' quorum (install data is part of the quorum-signed `installValidation`).
    function _validateAddressBook(address account, address addressBook) internal view override {
        if (addressBook.code.length == 0) revert InvalidAddressBook(addressBook);
        try IAccountAddressBook(addressBook).getAllowedRecipients(account) returns (address[] memory) {}
        catch {
            revert InvalidAddressBook(addressBook);
        }
    }
}
