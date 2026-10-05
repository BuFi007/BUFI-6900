// SPDX-License-Identifier: GPL-3.0-or-later
//
// BUFI-6900 — new, unaudited BUFI code. NOT Circle code. Copyright 2026 BUFI. This program is free software: you can
// redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any later version. It is distributed
// WITHOUT ANY WARRANTY; see <https://www.gnu.org/licenses/>.
pragma solidity 0.8.24;

import {GatewayIntentGuardCore} from "./GatewayIntentGuardCore.sol";
import {GatewayGuardInit, IGatewayIntentGuard} from "./IGatewayIntentGuard.sol";

import {NotImplemented} from "@circle/msca/6900/shared/common/Errors.sol";
import {
    ManifestAssociatedFunction,
    ManifestAssociatedFunctionType,
    ManifestFunction,
    PluginManifest,
    PluginMetadata
} from "@circle/msca/6900/v0.7/common/PluginManifest.sol";
import {IAccountLoupe} from "@circle/msca/6900/v0.7/interfaces/IAccountLoupe.sol";
import {IPlugin} from "@circle/msca/6900/v0.7/interfaces/IPlugin.sol";
import {BasePlugin} from "@circle/msca/6900/v0.7/plugins/BasePlugin.sol";
import {IAddressBookPlugin} from "@circle/msca/6900/v0.7/plugins/v1_0_0/addressbook/IAddressBookPlugin.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ERC165Checker} from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";

/// @title GatewayIntentGuardPlugin
/// @author BUFI
/// @notice ERC-6900 **v0.7** packaging of the GatewayTreasury policy for a Circle weighted-multisig MSCA: when Circle
///         Gateway (or USDC, for an ERC-3009 deposit) asks the account `isValidSignature(hash, signature)`, this
///         plugin's pre-runtime-validation hook decodes the BurnIntent / ReceiveWithAuthorization carried in the
///         signature, re-derives its EIP-712 digest, requires it to equal `hash`, and enforces the account's
///         allowlists, caps and expiry window. The owner quorum is NOT re-implemented: the account then routes the
///         same call to `WeightedWebauthnMultisigPlugin.isValidSignature`, which checks the weighted signatures.
///
/// @dev **Integration point.** In Circle's v0.7 account, `isValidSignature` is an *execution function* installed by
///      the weighted multisig plugin (runtime validation = ALWAYS_ALLOW). ERC-6900 v0.7 lets one plugin own a
///      selector, but ANY plugin may attach a `preRuntimeValidationHook` to it, and Circle's `BaseMSCA.fallback`
///      runs those hooks for every non-EntryPoint caller BEFORE dispatching to the owning plugin (the hooks run
///      even when the validation function is ALWAYS_ALLOW). The hook receives `msg.sender` (Gateway / USDC) and the
///      full calldata `isValidSignature(hash, signature)`. A v0.7 hook cannot change the return value, so a policy
///      violation REVERTS; every ERC-1271 caller (USDC's `SignatureChecker`, Gateway's simulation) treats a revert
///      as an invalid signature. The hook is `view` and the account reaches it with a zero-value CALL, which is
///      legal inside the STATICCALL that ERC-1271 callers use.
///
///      **Signature wire format.** `signature = multisigSig ‖ envelope ‖ uint256(envelope.length) ‖
/// ENVELOPE_MAGIC`,
///      where `envelope = abi.encode(uint8 kind, bytes payload)` with the same `kind`/`payload` as GatewayTreasury
///      (0 = `abi.encode(BurnIntent)`, 1 = `abi.encode(from, to, value, validAfter, validBefore, nonce)`), and
///      `multisigSig` is the unchanged Circle multisig signature over
///      `WeightedWebauthnMultisigPlugin.getReplaySafeMessageHash(account, hash)`. Circle's `checkNSignatures`
///      stops reading once the threshold weight is reached and only follows dynamic offsets it was given, so the
///      appended trailer is invisible to it. The trailer itself is NOT signed by the owners; it does not need to be,
///      because the digest re-derived from it must equal the `hash` the owners did sign.
///
///      **What this changes for the account.** Every ERC-1271 call now needs a valid envelope: the account's
///      `isValidSignature` becomes Gateway-only. Install it only on an account whose ERC-1271 is dedicated to
///      Gateway. A pass-through for "other" hashes would defeat the guard (the quorum could sign a burn intent and
///      present it without an envelope), so there is none.
///
///      **Admin.** The setters are execution functions on the account; their userOp validation is the owners'
///      (dependency slot 1 → weighted multisig owner validation, function id 0) and their runtime validation is
///      dependency slot 0 (the production fail-closed id 1), exactly the guarding Circle's AddressBook plugin uses.
///      There is no timelock: the same quorum that signs intents reconfigures, and can also uninstall the plugin,
///      which re-opens the account's ERC-1271 path to anything the quorum signs. GatewayTreasury's timelocked
///      admin queue has no v0.7-plugin equivalent without a separate timelock plugin.
contract GatewayIntentGuardPlugin is BasePlugin, GatewayIntentGuardCore {
    string internal constant _NAME = "BUFI Gateway Intent Guard Plugin";
    string internal constant _VERSION = "0.1.0";
    string internal constant _AUTHOR = "BUFI";

    /// @notice Last word of a guarded signature.
    bytes32 public constant ENVELOPE_MAGIC = keccak256("BUFI.GatewayIntentGuard.envelope.v1");

    /// @dev Dependency slots, same arrangement as Circle's ColdStorageAddressBookPlugin.
    uint256 internal constant _OWNER_RUNTIME_VALIDATION_DEPENDENCY_INDEX = 0;
    uint256 internal constant _OWNER_USER_OP_VALIDATION_DEPENDENCY_INDEX = 1;

    enum FunctionId {
        PRE_RUNTIME_VALIDATION_HOOK_IS_VALID_SIGNATURE
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Lifecycle                                                                      ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    /// @inheritdoc BasePlugin
    /// @dev `data` = `abi.encode(GatewayGuardInit)`.
    function onInstall(bytes calldata data) external override {
        _install(msg.sender, abi.decode(data, (GatewayGuardInit)));
    }

    /// @inheritdoc BasePlugin
    function onUninstall(bytes calldata) external override {
        _uninstall(msg.sender);
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Hook                                                                           ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    /// @inheritdoc BasePlugin
    /// @dev `data` is the account-level calldata `isValidSignature(bytes32 hash, bytes signature)`; `sender` is the
    ///      ERC-1271 caller (Gateway, or the token for kind 1); `msg.sender` is the account.
    function preRuntimeValidationHook(uint8 functionId, address sender, uint256, bytes calldata data)
        external
        view
        override
    {
        if (functionId != uint8(FunctionId.PRE_RUNTIME_VALIDATION_HOOK_IS_VALID_SIGNATURE)) {
            revert NotImplemented(msg.sig, functionId);
        }
        if (data.length < 4 || bytes4(data[0:4]) != IERC1271.isValidSignature.selector) {
            revert NotImplemented(msg.sig, functionId);
        }
        (bytes32 hash, bytes memory signature) = abi.decode(data[4:], (bytes32, bytes));
        (uint8 kind, bytes memory payload) = _decodeEnvelope(_trailerEnvelope(signature));
        _checkIntent(msg.sender, sender, hash, kind, payload);
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Manifest / metadata                                                            ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    /// @inheritdoc BasePlugin
    function pluginManifest() external pure override returns (PluginManifest memory manifest) {
        manifest.executionFunctions = new bytes4[](7);
        manifest.executionFunctions[0] = this.setGatewayRecipient.selector;
        manifest.executionFunctions[1] = this.setGatewayDestinationDomain.selector;
        manifest.executionFunctions[2] = this.setGatewayToken.selector;
        manifest.executionFunctions[3] = this.setGatewayDestinationToken.selector;
        manifest.executionFunctions[4] = this.setGatewayLimits.selector;
        manifest.executionFunctions[5] = this.setGatewayDestinationMinter.selector;
        manifest.executionFunctions[6] = this.setGatewayDestinationCaller.selector;

        manifest.dependencyInterfaceIds = new bytes4[](2);
        manifest.dependencyInterfaceIds[_OWNER_RUNTIME_VALIDATION_DEPENDENCY_INDEX] = type(IPlugin).interfaceId;
        manifest.dependencyInterfaceIds[_OWNER_USER_OP_VALIDATION_DEPENDENCY_INDEX] = type(IPlugin).interfaceId;

        ManifestFunction memory ownerUserOp = ManifestFunction({
            functionType: ManifestAssociatedFunctionType.DEPENDENCY,
            functionId: 0, // unused for dependency
            dependencyIndex: _OWNER_USER_OP_VALIDATION_DEPENDENCY_INDEX
        });
        ManifestFunction memory ownerRuntime = ManifestFunction({
            functionType: ManifestAssociatedFunctionType.DEPENDENCY,
            functionId: 0, // unused for dependency
            dependencyIndex: _OWNER_RUNTIME_VALIDATION_DEPENDENCY_INDEX
        });
        manifest.userOpValidationFunctions = new ManifestAssociatedFunction[](7);
        manifest.runtimeValidationFunctions = new ManifestAssociatedFunction[](7);
        for (uint256 i = 0; i < 7; i++) {
            manifest.userOpValidationFunctions[i] = ManifestAssociatedFunction({
                executionSelector: manifest.executionFunctions[i], associatedFunction: ownerUserOp
            });
            manifest.runtimeValidationFunctions[i] = ManifestAssociatedFunction({
                executionSelector: manifest.executionFunctions[i], associatedFunction: ownerRuntime
            });
        }

        manifest.preRuntimeValidationHooks = new ManifestAssociatedFunction[](1);
        manifest.preRuntimeValidationHooks[0] = ManifestAssociatedFunction({
            executionSelector: IERC1271.isValidSignature.selector,
            associatedFunction: ManifestFunction({
                functionType: ManifestAssociatedFunctionType.SELF,
                functionId: uint8(FunctionId.PRE_RUNTIME_VALIDATION_HOOK_IS_VALID_SIGNATURE),
                dependencyIndex: 0 // unused for SELF
            })
        });

        manifest.interfaceIds = new bytes4[](1);
        manifest.interfaceIds[0] = type(IGatewayIntentGuard).interfaceId;
        manifest.permitAnyExternalAddress = false;
        manifest.canSpendNativeToken = false;
    }

    /// @inheritdoc BasePlugin
    function pluginMetadata() external pure override returns (PluginMetadata memory metadata) {
        metadata.name = _NAME;
        metadata.version = _VERSION;
        metadata.author = _AUTHOR;
    }

    /// @inheritdoc BasePlugin
    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == type(IGatewayIntentGuard).interfaceId || super.supportsInterface(interfaceId);
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Internals                                                                      ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    function _isInitialized(address account) internal view override returns (bool) {
        return _limits[account].gatewayWallet != address(0);
    }

    /// @dev v0.7: the address book must declare `IAddressBookPlugin` and be installed on the account.
    function _validateAddressBook(address account, address addressBook) internal view override {
        if (
            addressBook.code.length == 0
                || !ERC165Checker.supportsInterface(addressBook, type(IAddressBookPlugin).interfaceId)
        ) revert InvalidAddressBook(addressBook);
        address[] memory installed = IAccountLoupe(account).getInstalledPlugins();
        for (uint256 i = 0; i < installed.length; i++) {
            if (installed[i] == addressBook) return;
        }
        revert AddressBookNotInstalled(account, addressBook);
    }

    /// @dev Reads the trailer `envelope ‖ uint256(len) ‖ ENVELOPE_MAGIC` from the end of `sig`. Every bound is
    ///      checked before reading.
    function _trailerEnvelope(bytes memory sig) internal pure returns (bytes memory env) {
        uint256 len = sig.length;
        if (len < 64) revert MissingIntentEnvelope();
        bytes32 magic;
        uint256 envLen;
        assembly ("memory-safe") {
            magic := mload(add(sig, len)) // last word: sig + 0x20 + len - 0x20
            envLen := mload(add(sig, sub(len, 0x20)))
        }
        if (magic != ENVELOPE_MAGIC || envLen > len - 64) revert MissingIntentEnvelope();
        env = new bytes(envLen);
        uint256 start = len - 64 - envLen;
        for (uint256 j = 0; j < envLen; j += 32) {
            assembly ("memory-safe") {
                mstore(add(add(env, 0x20), j), mload(add(add(sig, 0x20), add(start, j))))
            }
        }
        assembly ("memory-safe") {
            mstore(add(add(env, 0x20), envLen), 0)
        }
    }
}
