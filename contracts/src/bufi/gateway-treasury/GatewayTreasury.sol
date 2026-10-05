// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
}

interface IGatewayWallet {
    function deposit(address token, uint256 value) external;
    function depositWithAuthorization(
        address token,
        address from,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external;
    function initiateWithdrawal(address token, uint256 value) external;
    function withdraw(address token) external;
}

/// @notice Signer set + gateway for the constructor (first half).
struct SignerParams {
    address[] owners;
    uint16[] weights;
    uint256 thresholdWeight;
    address gatewayWallet;
}

/// @notice Allowlist, token, and cap configuration (second half).
struct PolicyParams {
    bytes32[] allowedRecipients;
    uint32[] allowedDestinationDomains;
    address[] tokenAddresses;
    string[] tokenNames;
    string[] tokenVersions;
    bytes32[] allowedDestinationTokens;
    uint256 perIntentCap;
    uint256 maxFeeCap;
    uint32 adminTimelock;
    /// @notice Furthest a burn intent's maxBlockHeight may sit above the current block. Gateway enforces a
    /// ~7-day MINIMUM (Arc testnet 1,209,599 blocks), so this is set just above that floor. A signed intent is
    /// a bearer withdrawal until it expires; an unbounded one never does.
    uint256 maxExpiryBlocks;
}

/// @notice Convenience wrapper used by the deploy script.
struct ConstructorParams {
    SignerParams signers;
    PolicyParams policy;
}

/// @dev Circle Gateway TransferSpec (EIP-712 typed struct).
struct TransferSpec {
    uint32 version;
    uint32 sourceDomain;
    uint32 destinationDomain;
    bytes32 sourceContract;
    bytes32 destinationContract;
    bytes32 sourceToken;
    bytes32 destinationToken;
    bytes32 sourceDepositor;
    bytes32 destinationRecipient;
    bytes32 sourceSigner;
    bytes32 destinationCaller;
    uint256 value;
    bytes32 salt;
    bytes hookData;
}

/// @dev Circle Gateway BurnIntent (EIP-712 typed struct).
struct BurnIntent {
    uint256 maxBlockHeight;
    uint256 maxFee;
    TransferSpec spec;
}

contract GatewayTreasury {
    // ============================================================
    // Constants
    // ============================================================

    bytes32 private constant TRANSFER_SPEC_TYPEHASH = keccak256(
        "TransferSpec(uint32 version,uint32 sourceDomain,uint32 destinationDomain,bytes32 sourceContract,bytes32 destinationContract,bytes32 sourceToken,bytes32 destinationToken,bytes32 sourceDepositor,bytes32 destinationRecipient,bytes32 sourceSigner,bytes32 destinationCaller,uint256 value,bytes32 salt,bytes hookData)"
    );

    bytes32 private constant BURN_INTENT_TYPEHASH = keccak256(
        "BurnIntent(uint256 maxBlockHeight,uint256 maxFee,TransferSpec spec)TransferSpec(uint32 version,uint32 sourceDomain,uint32 destinationDomain,bytes32 sourceContract,bytes32 destinationContract,bytes32 sourceToken,bytes32 destinationToken,bytes32 sourceDepositor,bytes32 destinationRecipient,bytes32 sourceSigner,bytes32 destinationCaller,uint256 value,bytes32 salt,bytes hookData)"
    );

    bytes32 private constant EIP712_DOMAIN_TYPEHASH_NOCHAIN = keccak256("EIP712Domain(string name,string version)");

    bytes32 private constant EIP712_DOMAIN_TYPEHASH_FULL =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    bytes32 private constant RWA_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    bytes32 private constant ADMIN_OP_TYPEHASH = keccak256("AdminOp(bytes32 callHash,uint256 nonce)");
    bytes32 private constant CANCEL_ADMIN_OP_TYPEHASH = keccak256("CancelAdminOp(uint256 nonce)");

    bytes4 private constant ERC1271_MAGICVALUE = 0x1626ba7e;
    bytes4 private constant ERC1271_INVALID = 0xffffffff;

    uint256 private constant SECP256K1N_DIV_2 =
        0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    bytes4 private constant SEL_SET_OWNERS = bytes4(keccak256("setOwners(address[],uint16[],uint256)"));
    bytes4 private constant SEL_SET_RECIPIENT = bytes4(keccak256("setAllowedRecipient(bytes32,bool)"));
    bytes4 private constant SEL_SET_DOMAIN = bytes4(keccak256("setAllowedDestinationDomain(uint32,bool)"));
    bytes4 private constant SEL_SET_TOKEN = bytes4(keccak256("setAllowedToken(address,string,string,bool)"));
    bytes4 private constant SEL_SET_DEST_TOKEN = bytes4(keccak256("setAllowedDestinationToken(bytes32,bool)"));
    bytes4 private constant SEL_SET_PER_INTENT_CAP = bytes4(keccak256("setPerIntentCap(uint256)"));
    bytes4 private constant SEL_SET_MAX_FEE_CAP = bytes4(keccak256("setMaxFeeCap(uint256)"));
    bytes4 private constant SEL_SET_TIMELOCK = bytes4(keccak256("setAdminTimelock(uint32)"));
    bytes4 private constant SEL_GW_INITIATE_WITHDRAWAL =
        bytes4(keccak256("gatewayInitiateWithdrawal(address,uint256)"));
    bytes4 private constant SEL_GW_WITHDRAW = bytes4(keccak256("gatewayWithdraw(address)"));
    bytes4 private constant SEL_SET_MAX_EXPIRY = bytes4(keccak256("setMaxExpiryBlocks(uint256)"));
    bytes4 private constant SEL_TRANSFER_RECIPIENT =
        bytes4(keccak256("transferToRecipient(address,bytes32,uint256)"));

    // ============================================================
    // Storage
    // ============================================================

    // Owners and weights
    address[] public owners;
    mapping(address => uint16) public weights;
    uint256 public thresholdWeight;

    // Gateway
    address public immutable gatewayWallet;

    // Allowlists
    uint256 private _recipientCount;
    mapping(bytes32 => bool) public allowedRecipients;
    mapping(uint32 => bool) public allowedDestinationDomains;

    struct TokenInfo {
        string eip712Name;
        string eip712Version;
    }

    mapping(address => TokenInfo) public allowedTokens;
    mapping(bytes32 => bool) public allowedDestinationTokens;

    // Caps
    uint256 public perIntentCap;
    uint256 public maxFeeCap;

    // Admin timelock
    uint32 public adminTimelock;

    // Expiry ceiling for burn intents, in source-chain blocks above the current block
    uint256 public maxExpiryBlocks;

    // Admin queue
    struct AdminOp {
        bytes32 callHash;
        uint256 eta;
        bool executed;
        bool cancelled;
    }

    mapping(uint256 => AdminOp) public adminOps;
    mapping(uint256 => bool) public usedNonces;

    // Domain separators
    bytes32 private immutable _gatewayDomainSep;
    bytes32 private immutable _adminDomainSep;

    // ============================================================
    // Events
    // ============================================================

    event Swept(address indexed token, uint256 amount);
    event AdminQueued(uint256 indexed nonce, bytes32 indexed callHash, uint256 eta);
    event AdminExecuted(uint256 indexed nonce);
    event AdminCancelled(uint256 indexed nonce);
    event OwnersUpdated(address[] owners, uint16[] weights, uint256 threshold);
    event RecipientUpdated(bytes32 indexed recipient, bool allowed);
    event DomainUpdated(uint32 indexed domain, bool allowed);
    event TokenUpdated(address indexed token, bool allowed);
    event DestinationTokenUpdated(bytes32 indexed token, bool allowed);
    event PerIntentCapUpdated(uint256 cap);
    event MaxFeeCapUpdated(uint256 cap);
    event TimelockUpdated(uint32 secs);
    event MaxExpiryBlocksUpdated(uint256 blocks_);
    event GatewayWithdrawalInitiated(address indexed token, uint256 value);
    event GatewayWithdrawn(address indexed token);
    event TransferredToRecipient(address indexed token, bytes32 indexed recipient, uint256 amount);

    // ============================================================
    // Errors
    // ============================================================

    error InvalidOwnerSet();
    error InvalidThreshold();
    error InvalidWeights();
    error DuplicateOwner();
    error InvalidGatewayWallet();
    error EmptyRecipientAllowlist();
    error InvalidCap();
    error NonceAlreadyUsed();
    error TimelockNotExpired();
    error OpNotFound();
    error OpAlreadyExecuted();
    error OpAlreadyCancelled();
    error InvalidCallTarget();
    error TransferFailed();
    error ZeroBalance();
    error TokenNotAllowed();
    error WouldEmptyAllowlist();
    error SelfCallFailed(bytes reason);
    error QuorumNotReached();
    error RecipientNotAllowed();
    error ZeroRecipient();
    error InvalidTokenConfig();

    // ============================================================
    // Modifiers
    // ============================================================

    modifier onlySelf() {
        require(msg.sender == address(this), "only self");
        _;
    }

    // ============================================================
    // Constructor
    // ============================================================

    /// @notice Two-struct constructor to stay within EVM/Yul stack-depth limits.
    /// @param s Signer configuration (owners, weights, threshold, gatewayWallet).
    /// @param pol Policy configuration (allowlists, tokens, caps, timelock).
    constructor(SignerParams memory s, PolicyParams memory pol) {
        // Scalar validations
        if (s.gatewayWallet == address(0)) revert InvalidGatewayWallet();
        if (pol.allowedRecipients.length < 1) revert EmptyRecipientAllowlist();
        if (pol.perIntentCap == 0 || pol.maxExpiryBlocks == 0) revert InvalidCap();
        if (pol.tokenAddresses.length != pol.tokenNames.length || pol.tokenAddresses.length != pol.tokenVersions.length) {
            revert InvalidTokenConfig();
        }

        // Owner/weight validation + storage (extracted to reduce stack depth)
        _initOwners(s.owners, s.weights, s.thresholdWeight);

        gatewayWallet = s.gatewayWallet;

        // Recipients
        for (uint256 i = 0; i < pol.allowedRecipients.length; i++) {
            bytes32 recipient = pol.allowedRecipients[i];
            if (!allowedRecipients[recipient]) {
                allowedRecipients[recipient] = true;
                _recipientCount++;
            }
        }
        if (_recipientCount == 0) revert EmptyRecipientAllowlist();

        // Destination domains
        for (uint256 i = 0; i < pol.allowedDestinationDomains.length; i++) {
            allowedDestinationDomains[pol.allowedDestinationDomains[i]] = true;
        }

        // Source tokens (must have non-empty EIP-712 name)
        for (uint256 i = 0; i < pol.tokenAddresses.length; i++) {
            address token = pol.tokenAddresses[i];
            string memory name = pol.tokenNames[i];
            if (token == address(0) || bytes(name).length == 0) revert InvalidTokenConfig();
            allowedTokens[token] = TokenInfo({eip712Name: name, eip712Version: pol.tokenVersions[i]});
        }

        // Destination tokens
        for (uint256 i = 0; i < pol.allowedDestinationTokens.length; i++) {
            allowedDestinationTokens[pol.allowedDestinationTokens[i]] = true;
        }

        perIntentCap = pol.perIntentCap;
        maxFeeCap = pol.maxFeeCap;
        adminTimelock = pol.adminTimelock;
        maxExpiryBlocks = pol.maxExpiryBlocks;

        // Gateway domain separator: name="GatewayWallet", version="1", no chainId, no verifyingContract
        _gatewayDomainSep = keccak256(
            abi.encode(EIP712_DOMAIN_TYPEHASH_NOCHAIN, keccak256(bytes("GatewayWallet")), keccak256(bytes("1")))
        );

        // Admin domain separator: name="GatewayTreasury", version="1", with chainId + verifyingContract
        _adminDomainSep = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH_FULL,
                keccak256(bytes("GatewayTreasury")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    /// @dev Validates and sets owners/weights/threshold. Isolated to reduce constructor stack depth.
    function _initOwners(address[] memory _owners, uint16[] memory _weights, uint256 _thresholdWeight) private {
        if (_owners.length < 1 || _owners.length > 20 || _owners.length != _weights.length) revert InvalidOwnerSet();

        uint256 totalWeight;
        for (uint256 i = 0; i < _owners.length; i++) {
            address owner = _owners[i];
            if (owner == address(0)) revert InvalidOwnerSet();

            uint16 weight = _weights[i];
            if (weight < 1) revert InvalidWeights(); // uint16: weights are 1..65,535

            // Uniqueness check (O(n^2), n <= 20)
            for (uint256 j = 0; j < i; j++) {
                if (_owners[j] == owner) revert DuplicateOwner();
            }

            owners.push(owner);
            weights[owner] = weight;
            totalWeight += weight;
        }

        if (_thresholdWeight < 1 || _thresholdWeight > totalWeight) revert InvalidThreshold();
        thresholdWeight = _thresholdWeight;
    }

    // ============================================================
    // ERC-1271
    // ============================================================

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        if (signature.length < 33) return ERC1271_INVALID;

        address caller = msg.sender;
        (bool ok, bytes memory result) = address(this).staticcall(
            abi.encodeWithSelector(this._validateSignatureInternal.selector, hash, signature, caller)
        );

        if (!ok || result.length < 32) return ERC1271_INVALID;

        bool valid = abi.decode(result, (bool));
        return valid ? ERC1271_MAGICVALUE : ERC1271_INVALID;
    }

    function _validateSignatureInternal(bytes32 hash, bytes calldata signature, address originalCaller)
        external
        view
        returns (bool)
    {
        (uint8 kind, bytes memory payload, bytes memory ownerSigs) = abi.decode(signature, (uint8, bytes, bytes));

        if (kind == 0) return _validateBurnIntent(hash, payload, ownerSigs);
        if (kind == 1) return _validateReceiveWithAuth(hash, payload, ownerSigs, originalCaller);
        return false;
    }

    function _validateBurnIntent(bytes32 hash, bytes memory payload, bytes memory ownerSigs) internal view returns (bool) {
        BurnIntent memory intent = abi.decode(payload, (BurnIntent));

        bytes32 specHash = keccak256(
            abi.encode(
                TRANSFER_SPEC_TYPEHASH,
                intent.spec.version,
                intent.spec.sourceDomain,
                intent.spec.destinationDomain,
                intent.spec.sourceContract,
                intent.spec.destinationContract,
                intent.spec.sourceToken,
                intent.spec.destinationToken,
                intent.spec.sourceDepositor,
                intent.spec.destinationRecipient,
                intent.spec.sourceSigner,
                intent.spec.destinationCaller,
                intent.spec.value,
                intent.spec.salt,
                keccak256(intent.spec.hookData)
            )
        );

        bytes32 intentHash = keccak256(abi.encode(BURN_INTENT_TYPEHASH, intent.maxBlockHeight, intent.maxFee, specHash));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _gatewayDomainSep, intentHash));

        if (digest != hash) return false;

        if (intent.spec.version != 1) return false;
        if (intent.spec.sourceContract != _toBytes32Address(gatewayWallet)) return false;
        if (intent.spec.sourceDepositor != _toBytes32Address(address(this))) return false;
        if (intent.spec.sourceSigner != _toBytes32Address(address(this))) return false;

        // Bounded expiry: refuse intents that stay valid longer than the configured window.
        if (intent.maxBlockHeight > block.number + maxExpiryBlocks) return false;

        // The token must be a canonical left-padded address: dirty upper bytes would truncate to an allowed token.
        if (uint256(intent.spec.sourceToken) >> 160 != 0) return false;
        address sourceTokenAddress = address(uint160(uint256(intent.spec.sourceToken)));
        if (bytes(allowedTokens[sourceTokenAddress].eip712Name).length == 0) return false;

        if (!allowedDestinationTokens[intent.spec.destinationToken]) return false;
        if (!allowedDestinationDomains[intent.spec.destinationDomain]) return false;
        if (!allowedRecipients[intent.spec.destinationRecipient]) return false;

        if (intent.spec.destinationCaller != bytes32(0) && !allowedRecipients[intent.spec.destinationCaller]) return false;

        if (intent.spec.hookData.length != 0) return false;
        if (intent.spec.value == 0 || intent.spec.value > perIntentCap) return false;
        if (intent.maxFee > maxFeeCap) return false;

        return _checkWeightedSigs(hash, ownerSigs);
    }

    function _validateReceiveWithAuth(bytes32 hash, bytes memory payload, bytes memory ownerSigs, address caller)
        internal
        view
        returns (bool)
    {
        if (bytes(allowedTokens[caller].eip712Name).length == 0) return false;

        (address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce) =
            abi.decode(payload, (address, address, uint256, uint256, uint256, bytes32));

        TokenInfo storage ti = allowedTokens[caller];
        bytes32 domainSep = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH_FULL,
                keccak256(bytes(ti.eip712Name)),
                keccak256(bytes(ti.eip712Version)),
                block.chainid,
                caller
            )
        );

        bytes32 structHash = keccak256(abi.encode(RWA_TYPEHASH, from, to, value, validAfter, validBefore, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSep, structHash));

        if (digest != hash) return false;
        if (from != address(this)) return false;
        if (to != gatewayWallet) return false;

        return _checkWeightedSigs(hash, ownerSigs);
    }

    function _checkWeightedSigs(bytes32 hash, bytes memory ownerSigs) internal view returns (bool) {
        if (ownerSigs.length == 0 || ownerSigs.length % 65 != 0) return false;

        uint256 numSigs = ownerSigs.length / 65;
        address prevSigner = address(0);
        uint256 totalWeight;

        for (uint256 i = 0; i < numSigs; i++) {
            bytes32 r;
            bytes32 s;
            uint8 v;

            // Reads only from ownerSigs (already allocated memory) — safe.
            assembly ("memory-safe") {
                let base := add(add(ownerSigs, 0x20), mul(i, 65))
                r := mload(base)
                s := mload(add(base, 0x20))
                v := byte(0, mload(add(base, 0x40)))
            }

            if (uint256(s) > SECP256K1N_DIV_2) return false;

            (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, v, r, s);
            if (err != ECDSA.RecoverError.NoError) return false;

            if (recovered <= prevSigner) return false;

            uint16 w = weights[recovered];
            if (w == 0) return false;

            totalWeight += w;
            prevSigner = recovered;
        }

        return totalWeight >= thresholdWeight;
    }

    // ============================================================
    // External operations
    // ============================================================

    function sweepToGateway(address token) external {
        if (bytes(allowedTokens[token].eip712Name).length == 0) revert TokenNotAllowed();

        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal == 0) revert ZeroBalance();

        // Check approve return value — reverts on soft-fail tokens.
        bool approveOk = IERC20(token).approve(gatewayWallet, bal);
        if (!approveOk) revert TransferFailed();

        IGatewayWallet(gatewayWallet).deposit(token, bal);

        // Reset residual allowance to zero in case the gateway consumed less than bal.
        IERC20(token).approve(gatewayWallet, 0);

        emit Swept(token, bal);
    }

    function queueAdmin(bytes calldata call, uint256 nonce, bytes calldata ownerSigs) external {
        if (usedNonces[nonce]) revert NonceAlreadyUsed();

        bytes32 callHash = keccak256(call);
        bytes32 structHash = keccak256(abi.encode(ADMIN_OP_TYPEHASH, callHash, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _adminDomainSep, structHash));

        if (!_checkWeightedSigs(digest, ownerSigs)) revert QuorumNotReached();

        usedNonces[nonce] = true;
        uint256 eta = block.timestamp + adminTimelock;

        adminOps[nonce] = AdminOp({callHash: callHash, eta: eta, executed: false, cancelled: false});

        emit AdminQueued(nonce, callHash, eta);
    }

    function executeAdmin(bytes calldata call, uint256 nonce) external {
        AdminOp storage op = adminOps[nonce];

        if (op.callHash == bytes32(0)) revert OpNotFound();
        if (op.executed) revert OpAlreadyExecuted();
        if (op.cancelled) revert OpAlreadyCancelled();
        if (block.timestamp < op.eta) revert TimelockNotExpired();
        if (keccak256(call) != op.callHash) revert OpNotFound();
        if (call.length < 4) revert InvalidCallTarget();

        bytes4 sel;
        assembly ("memory-safe") {
            sel := calldataload(call.offset)
        }

        if (!_isAllowedAdminSelector(sel)) revert InvalidCallTarget();

        op.executed = true;

        (bool ok, bytes memory ret) = address(this).call(call);
        if (!ok) revert SelfCallFailed(ret);

        emit AdminExecuted(nonce);
    }

    function cancelAdmin(uint256 nonce, bytes calldata ownerSigs) external {
        AdminOp storage op = adminOps[nonce];

        if (op.callHash == bytes32(0)) revert OpNotFound();
        if (op.executed) revert OpAlreadyExecuted();
        if (op.cancelled) revert OpAlreadyCancelled();

        bytes32 structHash = keccak256(abi.encode(CANCEL_ADMIN_OP_TYPEHASH, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _adminDomainSep, structHash));

        if (!_checkWeightedSigs(digest, ownerSigs)) revert QuorumNotReached();

        op.cancelled = true;

        emit AdminCancelled(nonce);
    }

    // ============================================================
    // Self-administered setters
    // ============================================================

    function setOwners(address[] calldata newOwners, uint16[] calldata newWeights, uint256 newThreshold) external onlySelf {
        if (newOwners.length < 1 || newOwners.length > 20 || newOwners.length != newWeights.length) {
            revert InvalidOwnerSet();
        }

        uint256 totalWeight;

        for (uint256 i = 0; i < newOwners.length; i++) {
            address owner = newOwners[i];
            if (owner == address(0)) revert InvalidOwnerSet();

            uint16 weight = newWeights[i];
            if (weight < 1) revert InvalidWeights(); // uint16: weights are 1..65,535

            for (uint256 j = 0; j < i; j++) {
                if (newOwners[j] == owner) revert DuplicateOwner();
            }

            totalWeight += weight;
        }

        if (newThreshold < 1 || newThreshold > totalWeight) revert InvalidThreshold();

        for (uint256 i = 0; i < owners.length; i++) {
            delete weights[owners[i]];
        }

        delete owners;

        for (uint256 i = 0; i < newOwners.length; i++) {
            owners.push(newOwners[i]);
            weights[newOwners[i]] = newWeights[i];
        }

        thresholdWeight = newThreshold;

        emit OwnersUpdated(newOwners, newWeights, newThreshold);
    }

    function setAllowedRecipient(bytes32 recipient, bool allowed) external onlySelf {
        bool current = allowedRecipients[recipient];
        if (current == allowed) return;

        if (!allowed) {
            if (_recipientCount <= 1) revert WouldEmptyAllowlist();
            _recipientCount--;
        } else {
            _recipientCount++;
        }

        allowedRecipients[recipient] = allowed;

        emit RecipientUpdated(recipient, allowed);
    }

    function setAllowedDestinationDomain(uint32 domain, bool allowed) external onlySelf {
        allowedDestinationDomains[domain] = allowed;
        emit DomainUpdated(domain, allowed);
    }

    function setAllowedToken(address token, string calldata name, string calldata version, bool allowed) external onlySelf {
        if (allowed) {
            if (token == address(0) || bytes(name).length == 0) revert InvalidTokenConfig();
            allowedTokens[token] = TokenInfo({eip712Name: name, eip712Version: version});
        } else {
            delete allowedTokens[token];
        }

        emit TokenUpdated(token, allowed);
    }

    function setAllowedDestinationToken(bytes32 tok, bool allowed) external onlySelf {
        allowedDestinationTokens[tok] = allowed;
        emit DestinationTokenUpdated(tok, allowed);
    }

    function setPerIntentCap(uint256 cap) external onlySelf {
        if (cap == 0) revert InvalidCap();
        perIntentCap = cap;
        emit PerIntentCapUpdated(cap);
    }

    function setMaxFeeCap(uint256 cap) external onlySelf {
        maxFeeCap = cap;
        emit MaxFeeCapUpdated(cap);
    }

    function setMaxExpiryBlocks(uint256 blocks_) external onlySelf {
        if (blocks_ == 0) revert InvalidCap();
        maxExpiryBlocks = blocks_;
        emit MaxExpiryBlocksUpdated(blocks_);
    }

    function setAdminTimelock(uint32 secs) external onlySelf {
        adminTimelock = secs;
        emit TimelockUpdated(secs);
    }

    function gatewayInitiateWithdrawal(address token, uint256 value) external onlySelf {
        if (bytes(allowedTokens[token].eip712Name).length == 0) revert TokenNotAllowed();
        IGatewayWallet(gatewayWallet).initiateWithdrawal(token, value);
        emit GatewayWithdrawalInitiated(token, value);
    }

    function gatewayWithdraw(address token) external onlySelf {
        if (bytes(allowedTokens[token].eip712Name).length == 0) revert TokenNotAllowed();
        IGatewayWallet(gatewayWallet).withdraw(token);
        emit GatewayWithdrawn(token);
    }

    function transferToRecipient(address token, bytes32 recipient, uint256 amount) external onlySelf {
        if (!allowedRecipients[recipient]) revert RecipientNotAllowed();
        // Only EVM-shaped recipients: a Solana key (or any value with upper bytes set) would truncate to an
        // address nobody controls.
        if (uint256(recipient) >> 160 != 0) revert RecipientNotAllowed();

        address to = address(uint160(uint256(recipient)));
        if (to == address(0)) revert ZeroRecipient();

        bool ok = IERC20(token).transfer(to, amount);
        if (!ok) revert TransferFailed();

        emit TransferredToRecipient(token, recipient, amount);
    }

    // ============================================================
    // Views
    // ============================================================

    function getOwners() external view returns (address[] memory) {
        return owners;
    }

    function ownerCount() external view returns (uint256) {
        return owners.length;
    }

    function recipientCount() external view returns (uint256) {
        return _recipientCount;
    }

    // ============================================================
    // Internal helpers
    // ============================================================

    function _isAllowedAdminSelector(bytes4 sel) internal pure returns (bool) {
        return sel == SEL_SET_OWNERS || sel == SEL_SET_RECIPIENT || sel == SEL_SET_DOMAIN || sel == SEL_SET_TOKEN
            || sel == SEL_SET_DEST_TOKEN || sel == SEL_SET_PER_INTENT_CAP || sel == SEL_SET_MAX_FEE_CAP
            || sel == SEL_SET_TIMELOCK || sel == SEL_GW_INITIATE_WITHDRAWAL || sel == SEL_GW_WITHDRAW
            || sel == SEL_TRANSFER_RECIPIENT || sel == SEL_SET_MAX_EXPIRY;
    }

    function _toBytes32Address(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }
}
