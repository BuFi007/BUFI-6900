// SPDX-License-Identifier: GPL-3.0-or-later
//
// BUFI-6900 — new, unaudited BUFI code (not Circle code).
pragma solidity 0.8.24;

/// @notice Install-time configuration of the Gateway intent guard for one account.
struct GatewayGuardInit {
    /// The GatewayWallet the account's intents must burn from (TransferSpec.sourceContract) and the only allowed
    /// `to` of an ERC-3009 ReceiveWithAuthorization.
    address gatewayWallet;
    uint256 perIntentCap;
    uint256 maxFeeCap;
    uint256 maxExpiryBlocks;
    bytes32[] recipients;
    uint32[] destinationDomains;
    address[] tokens;
    string[] tokenNames;
    string[] tokenVersions;
    bytes32[] destinationTokens;
    /// This chain's Gateway domain; every burn intent must name it as TransferSpec.sourceDomain.
    uint32 sourceDomain;
    /// GatewayMinter (bytes32) for each entry of `destinationDomains`, same order; TransferSpec.destinationContract
    /// must equal the minter of the intent's destination domain.
    bytes32[] destinationMinters;
    /// Destination callers (relayers) allowed on an intent. A separate set from recipients: a relayer is not a payee.
    bytes32[] destinationCallers;
    /// Optional ColdStorageAddressBookPlugin installed on the account (address(0) for none). When non-zero, an
    /// EVM-shaped destinationRecipient that is in the account's address book is also allowed.
    address addressBook;
}

/// @title IGatewayIntentGuard
/// @author BUFI
/// @notice ABI shared by the two ERC-6900 packagings of the Circle Gateway intent policy (the one GatewayTreasury
///         enforces in its own `isValidSignature`): `GatewayIntentGuardPlugin` (v0.7, Circle's production MSCA) and
///         `GatewayIntentGuardModule` (v0.8). Both keep per-account configuration keyed by `msg.sender`; writes are
///         only reachable through the account itself, i.e. through the owners' validation.
interface IGatewayIntentGuard {
    event GatewayGuardInstalled(address indexed account, address indexed gatewayWallet, address indexed addressBook);
    event GatewayGuardUninstalled(address indexed account);
    event GatewayRecipientUpdated(address indexed account, bytes32 indexed recipient, bool allowed);
    event GatewayDestinationDomainUpdated(address indexed account, uint32 indexed domain, bool allowed);
    event GatewayTokenUpdated(address indexed account, address indexed token, bool allowed);
    event GatewayDestinationTokenUpdated(address indexed account, bytes32 indexed token, bool allowed);
    event GatewayDestinationMinterUpdated(address indexed account, uint32 indexed domain, bytes32 minter);
    event GatewayDestinationCallerUpdated(address indexed account, bytes32 indexed caller, bool allowed);
    event GatewayLimitsUpdated(
        address indexed account, uint256 perIntentCap, uint256 maxFeeCap, uint256 maxExpiryBlocks
    );

    // ── Install errors
    // ──────────────────────────────────────────────────────
    error GuardNotInstalled(address account);
    error GuardAlreadyInstalled(address account);
    error InvalidGatewayWallet();
    error InvalidLimits();
    error InvalidTokenConfig();
    error InvalidDestinationConfig();
    error EmptyRecipientAllowlist();
    error InvalidAddressBook(address addressBook);
    error AddressBookNotInstalled(address account, address addressBook);

    // ── Rejections (surface as the account's `PreRuntimeValidationHookFailed`) ──
    /// @notice The ERC-1271 signature does not carry a well-formed guard envelope.
    error MissingIntentEnvelope();
    /// @notice The envelope's `kind` is neither 0 (BurnIntent) nor 1 (ReceiveWithAuthorization).
    error UnknownIntentKind(uint8 kind);
    /// @notice The digest re-derived from the carried payload is not the hash being validated.
    error DigestMismatch(bytes32 expected, bytes32 derived);
    /// @notice A scalar rule failed: version, source domain, source contract, depositor/signer, expiry, canonical
    ///         token, hook data, value cap or fee cap.
    error IntentShapeRejected();
    error SourceTokenNotAllowed(address token);
    error DestinationTokenNotAllowed(bytes32 token);
    error DestinationDomainNotAllowed(uint32 domain);
    error RecipientNotAllowed(bytes32 recipient);
    error DestinationCallerNotAllowed(bytes32 caller);
    /// @notice TransferSpec.destinationContract is not the configured GatewayMinter of the destination domain.
    error DestinationContractNotAllowed(bytes32 destinationContract);
    /// @notice ReceiveWithAuthorization was presented by a caller that is not an allowed token, or names a `from`
    ///         other than the account or a `to` other than the GatewayWallet.
    error AuthorizationRejected();

    // ── Setters: execution functions on the account, gated by the owners' userOp validation ──
    function setGatewayRecipient(bytes32 recipient, bool allowed) external;
    function setGatewayDestinationDomain(uint32 domain, bool allowed) external;
    function setGatewayToken(address token, string calldata eip712Name, string calldata eip712Version, bool allowed)
        external;
    function setGatewayDestinationToken(bytes32 token, bool allowed) external;
    function setGatewayLimits(uint256 perIntentCap, uint256 maxFeeCap, uint256 maxExpiryBlocks) external;
    function setGatewayDestinationMinter(uint32 domain, bytes32 minter) external;
    function setGatewayDestinationCaller(bytes32 caller, bool allowed) external;

    // ── Views (plugin-direct, keyed by account)
    // ─────────────────────────────
    function gatewayLimits(address account)
        external
        view
        returns (
            address gatewayWallet,
            uint256 perIntentCap,
            uint256 maxFeeCap,
            uint256 maxExpiryBlocks,
            address addressBook
        );
    function isGatewayRecipientAllowed(address account, bytes32 recipient) external view returns (bool);
    function isGatewayDestinationDomainAllowed(address account, uint32 domain) external view returns (bool);
    function gatewayToken(address account, address token)
        external
        view
        returns (string memory name, string memory version);
    function isGatewayDestinationTokenAllowed(address account, bytes32 token) external view returns (bool);
    function gatewayRecipientCount(address account) external view returns (uint256);
    function gatewaySourceDomain(address account) external view returns (uint32);
    function gatewayDestinationMinter(address account, uint32 domain) external view returns (bytes32);
    function isGatewayDestinationCallerAllowed(address account, bytes32 caller) external view returns (bool);

    /// @notice Runs the policy exactly as the hook does for `account`, asked by `caller` (Gateway, or the token for
    ///         kind 1), on an already-extracted envelope `(kind, payload)`. Reverts with the hook's error on any
    ///         violation; returns normally when the policy holds. The owner quorum is NOT checked here (that is the
    ///         weighted multisig's job).
    function checkIntent(address account, address caller, bytes32 hash, uint8 kind, bytes calldata payload)
        external
        view;
}
