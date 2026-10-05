// SPDX-License-Identifier: GPL-3.0-or-later
//
// BUFI-6900 — new, unaudited BUFI code. NOT Circle code. Copyright 2026 BUFI. GPL-3.0-or-later; see
// <https://www.gnu.org/licenses/>.
pragma solidity 0.8.24;

import {BurnIntent, GatewayIntentPolicy, IntentLimits} from "./GatewayIntentPolicy.sol";
import {GatewayGuardInit, IGatewayIntentGuard} from "./IGatewayIntentGuard.sol";

/// @dev Both Circle address books (v0.7 `ColdStorageAddressBookPlugin`, v0.8 `ColdStorageAddressBookModule`) expose
///      this account-keyed view.
interface IAccountAddressBook {
    function getAllowedRecipients(address account) external view returns (address[] memory);
}

/// @title GatewayIntentGuardCore
/// @author BUFI
/// @notice Per-account configuration and policy evaluation shared by the v0.7 plugin and the v0.8 module. Every
///         write is keyed by `msg.sender` (the account), so a write for an account can only originate from that
///         account, i.e. it went through the account's own validation (the owners' quorum).
/// @dev New, unaudited BUFI code.
abstract contract GatewayIntentGuardCore is IGatewayIntentGuard {
    struct Limits {
        address gatewayWallet;
        uint256 perIntentCap;
        uint256 maxFeeCap;
        uint256 maxExpiryBlocks;
        address addressBook;
        uint32 sourceDomain;
    }

    struct TokenInfo {
        string name;
        string version;
    }

    mapping(address account => Limits) internal _limits;
    /// @dev Bumped on uninstall so a reinstall never inherits stale set entries.
    mapping(address account => uint256) internal _epoch;
    mapping(bytes32 ns => mapping(bytes32 recipient => bool)) internal _recipients;
    mapping(bytes32 ns => uint256) internal _recipientCount;
    mapping(bytes32 ns => mapping(uint32 domain => bool)) internal _domains;
    mapping(bytes32 ns => mapping(address token => TokenInfo)) internal _tokens;
    mapping(bytes32 ns => mapping(bytes32 token => bool)) internal _destTokens;
    mapping(bytes32 ns => mapping(uint32 domain => bytes32 minter)) internal _minters;
    mapping(bytes32 ns => mapping(bytes32 caller => bool)) internal _callers;

    modifier onlyInstalled() {
        if (_limits[msg.sender].gatewayWallet == address(0)) revert GuardNotInstalled(msg.sender);
        _;
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Lifecycle (called from the packaging's onInstall / onUninstall)                ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    function _install(address account, GatewayGuardInit memory init) internal {
        if (_limits[account].gatewayWallet != address(0)) revert GuardAlreadyInstalled(account);
        if (init.gatewayWallet == address(0)) revert InvalidGatewayWallet();
        if (init.perIntentCap == 0 || init.maxExpiryBlocks == 0) revert InvalidLimits();
        if (init.tokens.length != init.tokenNames.length || init.tokens.length != init.tokenVersions.length) {
            revert InvalidTokenConfig();
        }
        if (init.destinationMinters.length != init.destinationDomains.length) revert InvalidDestinationConfig();
        if (init.addressBook != address(0)) _validateAddressBook(account, init.addressBook);

        bytes32 ns = _ns(account);
        _limits[account] = Limits({
            gatewayWallet: init.gatewayWallet,
            perIntentCap: init.perIntentCap,
            maxFeeCap: init.maxFeeCap,
            maxExpiryBlocks: init.maxExpiryBlocks,
            addressBook: init.addressBook,
            sourceDomain: init.sourceDomain
        });
        for (uint256 i = 0; i < init.recipients.length; i++) {
            if (!_recipients[ns][init.recipients[i]]) {
                _recipients[ns][init.recipients[i]] = true;
                _recipientCount[ns]++;
            }
        }
        if (_recipientCount[ns] == 0 && init.addressBook == address(0)) revert EmptyRecipientAllowlist();
        for (uint256 i = 0; i < init.destinationDomains.length; i++) {
            if (init.destinationMinters[i] == bytes32(0)) revert InvalidDestinationConfig();
            _domains[ns][init.destinationDomains[i]] = true;
            _minters[ns][init.destinationDomains[i]] = init.destinationMinters[i];
        }
        for (uint256 i = 0; i < init.destinationCallers.length; i++) {
            _callers[ns][init.destinationCallers[i]] = true;
        }
        for (uint256 i = 0; i < init.tokens.length; i++) {
            if (init.tokens[i] == address(0) || bytes(init.tokenNames[i]).length == 0) revert InvalidTokenConfig();
            _tokens[ns][init.tokens[i]] = TokenInfo(init.tokenNames[i], init.tokenVersions[i]);
        }
        for (uint256 i = 0; i < init.destinationTokens.length; i++) {
            _destTokens[ns][init.destinationTokens[i]] = true;
        }
        emit GatewayGuardInstalled(account, init.gatewayWallet, init.addressBook);
    }

    function _uninstall(address account) internal {
        if (_limits[account].gatewayWallet == address(0)) revert GuardNotInstalled(account);
        delete _limits[account];
        _epoch[account]++;
        emit GatewayGuardUninstalled(account);
    }

    /// @dev Packaging-specific: prove `addressBook` is a real address book for `account`; revert otherwise.
    function _validateAddressBook(address account, address addressBook) internal view virtual;

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Setters (msg.sender is the account)                                            ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    /// @inheritdoc IGatewayIntentGuard
    function setGatewayRecipient(bytes32 recipient, bool allowed) external override onlyInstalled {
        bytes32 ns = _ns(msg.sender);
        if (_recipients[ns][recipient] == allowed) return;
        if (allowed) {
            _recipientCount[ns]++;
        } else {
            if (_recipientCount[ns] <= 1 && _limits[msg.sender].addressBook == address(0)) {
                revert EmptyRecipientAllowlist();
            }
            _recipientCount[ns]--;
        }
        _recipients[ns][recipient] = allowed;
        emit GatewayRecipientUpdated(msg.sender, recipient, allowed);
    }

    /// @inheritdoc IGatewayIntentGuard
    function setGatewayDestinationDomain(uint32 domain, bool allowed) external override onlyInstalled {
        _domains[_ns(msg.sender)][domain] = allowed;
        emit GatewayDestinationDomainUpdated(msg.sender, domain, allowed);
    }

    /// @inheritdoc IGatewayIntentGuard
    function setGatewayToken(address token, string calldata eip712Name, string calldata eip712Version, bool allowed)
        external
        override
        onlyInstalled
    {
        bytes32 ns = _ns(msg.sender);
        if (allowed) {
            if (token == address(0) || bytes(eip712Name).length == 0) revert InvalidTokenConfig();
            _tokens[ns][token] = TokenInfo(eip712Name, eip712Version);
        } else {
            delete _tokens[ns][token];
        }
        emit GatewayTokenUpdated(msg.sender, token, allowed);
    }

    /// @inheritdoc IGatewayIntentGuard
    function setGatewayDestinationToken(bytes32 token, bool allowed) external override onlyInstalled {
        _destTokens[_ns(msg.sender)][token] = allowed;
        emit GatewayDestinationTokenUpdated(msg.sender, token, allowed);
    }

    /// @inheritdoc IGatewayIntentGuard
    function setGatewayLimits(uint256 perIntentCap, uint256 maxFeeCap, uint256 maxExpiryBlocks)
        external
        override
        onlyInstalled
    {
        if (perIntentCap == 0 || maxExpiryBlocks == 0) revert InvalidLimits();
        Limits storage l = _limits[msg.sender];
        l.perIntentCap = perIntentCap;
        l.maxFeeCap = maxFeeCap;
        l.maxExpiryBlocks = maxExpiryBlocks;
        emit GatewayLimitsUpdated(msg.sender, perIntentCap, maxFeeCap, maxExpiryBlocks);
    }

    /// @inheritdoc IGatewayIntentGuard
    function setGatewayDestinationMinter(uint32 domain, bytes32 minter) external override onlyInstalled {
        _minters[_ns(msg.sender)][domain] = minter;
        emit GatewayDestinationMinterUpdated(msg.sender, domain, minter);
    }

    /// @inheritdoc IGatewayIntentGuard
    function setGatewayDestinationCaller(bytes32 caller, bool allowed) external override onlyInstalled {
        _callers[_ns(msg.sender)][caller] = allowed;
        emit GatewayDestinationCallerUpdated(msg.sender, caller, allowed);
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Views                                                                          ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    function gatewayLimits(address account)
        external
        view
        override
        returns (
            address gatewayWallet,
            uint256 perIntentCap,
            uint256 maxFeeCap,
            uint256 maxExpiryBlocks,
            address addressBook
        )
    {
        Limits storage l = _limits[account];
        return (l.gatewayWallet, l.perIntentCap, l.maxFeeCap, l.maxExpiryBlocks, l.addressBook);
    }

    function isGatewayRecipientAllowed(address account, bytes32 recipient) external view override returns (bool) {
        return _recipients[_ns(account)][recipient];
    }

    function isGatewayDestinationDomainAllowed(address account, uint32 domain) external view override returns (bool) {
        return _domains[_ns(account)][domain];
    }

    function gatewayToken(address account, address token)
        external
        view
        override
        returns (string memory name, string memory version)
    {
        TokenInfo storage t = _tokens[_ns(account)][token];
        return (t.name, t.version);
    }

    function isGatewayDestinationTokenAllowed(address account, bytes32 token) external view override returns (bool) {
        return _destTokens[_ns(account)][token];
    }

    function gatewayRecipientCount(address account) external view override returns (uint256) {
        return _recipientCount[_ns(account)];
    }

    function gatewaySourceDomain(address account) external view override returns (uint32) {
        return _limits[account].sourceDomain;
    }

    function gatewayDestinationMinter(address account, uint32 domain) external view override returns (bytes32) {
        return _minters[_ns(account)][domain];
    }

    function isGatewayDestinationCallerAllowed(address account, bytes32 caller) external view override returns (bool) {
        return _callers[_ns(account)][caller];
    }

    /// @inheritdoc IGatewayIntentGuard
    function checkIntent(address account, address caller, bytes32 hash, uint8 kind, bytes calldata payload)
        external
        view
        override
    {
        _checkIntent(account, caller, hash, kind, payload);
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Policy                                                                         ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    function _ns(address account) internal view returns (bytes32) {
        return keccak256(abi.encode(account, _epoch[account]));
    }

    /// @dev Reverts with a specific error on any violation.
    function _checkIntent(address account, address caller, bytes32 hash, uint8 kind, bytes memory payload)
        internal
        view
    {
        Limits memory l = _limits[account];
        if (l.gatewayWallet == address(0)) revert GuardNotInstalled(account);
        bytes32 ns = _ns(account);
        if (kind == 0) {
            _checkBurnIntent(account, l, ns, hash, payload);
        } else if (kind == 1) {
            _checkReceiveWithAuthorization(account, l, ns, caller, hash, payload);
        } else {
            revert UnknownIntentKind(kind);
        }
    }

    /// @dev Decodes an envelope `abi.encode(uint8 kind, bytes payload)`. A malformed envelope reverts inside the
    ///      ABI decoder: fail-closed.
    function _decodeEnvelope(bytes memory envelope) internal pure returns (uint8 kind, bytes memory payload) {
        if (envelope.length < 96) revert MissingIntentEnvelope();
        (kind, payload) = abi.decode(envelope, (uint8, bytes));
    }

    function _checkBurnIntent(address account, Limits memory l, bytes32 ns, bytes32 hash, bytes memory payload)
        internal
        view
    {
        BurnIntent memory intent = abi.decode(payload, (BurnIntent));
        bytes32 derived = GatewayIntentPolicy.burnIntentDigest(intent);
        if (derived != hash) revert DigestMismatch(hash, derived);

        (bool ok, address sourceToken) = GatewayIntentPolicy.checkIntentShape(
            intent,
            IntentLimits({
                gatewayWallet: l.gatewayWallet,
                sourceDomain: l.sourceDomain,
                depositor: account,
                maxExpiryBlocks: l.maxExpiryBlocks,
                perIntentCap: l.perIntentCap,
                maxFeeCap: l.maxFeeCap
            })
        );
        if (!ok) revert IntentShapeRejected();
        if (bytes(_tokens[ns][sourceToken].name).length == 0) revert SourceTokenNotAllowed(sourceToken);
        uint32 domain = intent.spec.destinationDomain;
        // Every destination word must have its domain's address shape: one flat set holds both EVM addresses and
        // Solana keys, and either one on the other kind of domain mints to an account nobody controls.
        if (
            !_destTokens[ns][intent.spec.destinationToken]
                || !GatewayIntentPolicy.matchesDomainShape(domain, intent.spec.destinationToken)
        ) revert DestinationTokenNotAllowed(intent.spec.destinationToken);
        if (!_domains[ns][domain]) revert DestinationDomainNotAllowed(domain);
        if (!_recipientAllowed(account, l, ns, domain, intent.spec.destinationRecipient)) {
            revert RecipientNotAllowed(intent.spec.destinationRecipient);
        }
        bytes32 caller = intent.spec.destinationCaller;
        if (caller != bytes32(0) && (!_callers[ns][caller] || !GatewayIntentPolicy.matchesDomainShape(domain, caller))) revert DestinationCallerNotAllowed(caller);
        bytes32 minter = _minters[ns][domain];
        if (minter == bytes32(0) || intent.spec.destinationContract != minter) {
            revert DestinationContractNotAllowed(intent.spec.destinationContract);
        }
    }

    function _checkReceiveWithAuthorization(
        address account,
        Limits memory l,
        bytes32 ns,
        address caller,
        bytes32 hash,
        bytes memory payload
    ) internal view {
        TokenInfo storage ti = _tokens[ns][caller];
        if (bytes(ti.name).length == 0) revert AuthorizationRejected();
        (address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce) =
            abi.decode(payload, (address, address, uint256, uint256, uint256, bytes32));
        bytes32 derived = GatewayIntentPolicy.receiveWithAuthorizationDigest(
            ti.name, ti.version, caller, from, to, value, validAfter, validBefore, nonce
        );
        if (derived != hash) revert DigestMismatch(hash, derived);
        if (from != account || to != l.gatewayWallet) revert AuthorizationRejected();
    }

    /// @dev The recipient must have the destination domain's address shape. Then: explicit per-account set; then,
    ///      ONLY for an EVM destination domain and if an address book is bound, an address in the account's address
    ///      book. NOTE: the address book is a SOURCE-chain set; trusting it for a destination EVM chain assumes the
    ///      same address is controlled by the same party there (true for EOAs, not guaranteed for contracts deployed
    ///      per chain). It is never consulted for a non-EVM domain (a left-padded EVM address there is no one's).
    function _recipientAllowed(address account, Limits memory l, bytes32 ns, uint32 domain, bytes32 recipient)
        internal
        view
        returns (bool)
    {
        if (!GatewayIntentPolicy.matchesDomainShape(domain, recipient)) return false;
        if (_recipients[ns][recipient]) return true;
        if (l.addressBook == address(0) || !GatewayIntentPolicy.isEvmDomain(domain)) return false;
        address r = address(uint160(uint256(recipient)));
        if (r == address(0)) return false;
        address[] memory book = IAccountAddressBook(l.addressBook).getAllowedRecipients(account);
        for (uint256 i = 0; i < book.length; i++) {
            if (book[i] == r) return true;
        }
        return false;
    }
}
