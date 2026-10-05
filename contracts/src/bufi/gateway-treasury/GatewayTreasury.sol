// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "../gateway-guard/GatewayIntentPolicy.sol";

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
    /// @notice This chain's Gateway domain; every burn intent must name it as sourceDomain.
    uint32 localDomain;
    /// @notice GatewayMinter (as bytes32) for each entry of `allowedDestinationDomains`, same order. A burn intent's
    /// destinationContract must equal the minter of its destination domain.
    bytes32[] destinationMinters;
    /// @notice Destination callers (relayers) allowed to mint. Kept apart from recipients: a relayer is not a payee.
    bytes32[] allowedDestinationCallers;
}

/// @notice Convenience wrapper used by the deploy script.
struct ConstructorParams {
    SignerParams signers;
    PolicyParams policy;
}

contract GatewayTreasury {
    // ============================================================
    // Constants
    // ============================================================

    bytes32 private constant EIP712_DOMAIN_TYPEHASH_FULL =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    /// @dev `deadline` bounds how long a collected-but-unsubmitted signature set stays usable; `epoch` binds it to
    ///      the owner set / timelock it was signed under (see `adminEpoch`).
    bytes32 private constant ADMIN_OP_TYPEHASH =
        keccak256("AdminOp(bytes32 callHash,uint256 nonce,uint256 deadline,uint256 epoch)");
    bytes32 private constant CANCEL_ADMIN_OP_TYPEHASH = keccak256("CancelAdminOp(uint256 nonce)");
    bytes32 private constant REVOKE_INTENT_TYPEHASH = keccak256("RevokeIntent(bytes32 digest)");
    bytes32 private constant PAUSE_TYPEHASH = keccak256("Pause(uint256 nonce)");

    /// @notice A queued admin op must execute within this long after its eta, or it is dead (re-queue it). Stops a
    ///         failed op (e.g. a transfer that lacked balance, a removal that would empty the allowlist) from staying
    ///         live indefinitely and firing, permissionlessly, once conditions change.
    uint256 public constant ADMIN_OP_GRACE = 7 days;

    bytes4 private constant ERC1271_MAGICVALUE = 0x1626ba7e;
    bytes4 private constant ERC1271_INVALID = 0xffffffff;

    /// @dev Gas forwarded to a contract owner's own `isValidSignature`. Sized for a Circle MSCA or Safe whose
    ///      owners include P-256 passkeys verified in Solidity (no RIP-7212 precompile): ~300k per passkey. A call
    ///      that needs more reads as invalid; it never reverts the treasury.
    uint256 private constant NESTED_SIG_GAS = 1_000_000;

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
    bytes4 private constant SEL_SET_DEST_MINTER = bytes4(keccak256("setDestinationMinter(uint32,bytes32)"));
    bytes4 private constant SEL_SET_DEST_CALLER = bytes4(keccak256("setAllowedDestinationCaller(bytes32,bool)"));
    bytes4 private constant SEL_SET_PAUSED = bytes4(keccak256("setPaused(bool)"));

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
    /// @notice Destination callers allowed on a burn intent (bytes32(0) = anyone may mint, always allowed).
    mapping(bytes32 => bool) public allowedDestinationCallers;
    /// @notice GatewayMinter for each destination domain; zero = no burn intent to that domain validates.
    mapping(uint32 => bytes32) public destinationMinters;
    /// @notice This chain's Gateway domain (TransferSpec.sourceDomain).
    uint32 public immutable localDomain;

    // Emergency stops (no timelock): a quorum can refuse all burn intents, or one signed intent, immediately.
    bool public paused;
    mapping(bytes32 => bool) public revokedIntents;

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
        uint256 epoch;
    }

    mapping(uint256 => AdminOp) public adminOps;
    mapping(uint256 => bool) public usedNonces;

    /// @notice Bumped by every owner-set or timelock change. Admin signatures and queued ops carry the epoch they
    ///         were made under and are dead in any other: a rotation (or a timelock change) never inherits pending
    ///         ops or uncollected signatures from the previous configuration.
    uint256 public adminEpoch;

    // Domain separator for admin ops (Gateway's own is GatewayIntentPolicy.GATEWAY_DOMAIN_SEPARATOR)
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
    event DestinationMinterUpdated(uint32 indexed domain, bytes32 minter);
    event DestinationCallerUpdated(bytes32 indexed caller, bool allowed);
    event IntentRevoked(bytes32 indexed digest);
    event PausedSet(bool paused);

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
    error InvalidDestinationConfig();
    error SignatureExpired();
    error OpExpired();
    error OpStale();

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
        if (pol.destinationMinters.length != pol.allowedDestinationDomains.length) revert InvalidDestinationConfig();

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

        // Destination domains, each with its GatewayMinter
        for (uint256 i = 0; i < pol.allowedDestinationDomains.length; i++) {
            if (pol.destinationMinters[i] == bytes32(0)) revert InvalidDestinationConfig();
            allowedDestinationDomains[pol.allowedDestinationDomains[i]] = true;
            destinationMinters[pol.allowedDestinationDomains[i]] = pol.destinationMinters[i];
        }

        // Destination callers (relayers), a set separate from payees
        for (uint256 i = 0; i < pol.allowedDestinationCallers.length; i++) {
            allowedDestinationCallers[pol.allowedDestinationCallers[i]] = true;
        }
        localDomain = pol.localDomain;

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
            if (owner == address(0) || owner == address(this)) revert InvalidOwnerSet();

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
        // Emergency stops first. NOTE: Gateway evaluates this view off-chain against a block that may lag by up to
        // ~5 minutes, so a pause / revocation takes effect for Gateway only after that lag. Moving funds to the
        // Gateway withdrawing balance does NOT protect them: Gateway burns from withdrawing balance too.
        if (paused || revokedIntents[hash]) return false;

        BurnIntent memory intent = abi.decode(payload, (BurnIntent));

        if (GatewayIntentPolicy.burnIntentDigest(intent) != hash) return false;

        (bool shapeOk, address sourceTokenAddress) = GatewayIntentPolicy.checkIntentShape(
            intent,
            IntentLimits({
                gatewayWallet: gatewayWallet,
                sourceDomain: localDomain,
                depositor: address(this),
                maxExpiryBlocks: maxExpiryBlocks,
                perIntentCap: perIntentCap,
                maxFeeCap: maxFeeCap
            })
        );
        if (!shapeOk) return false;

        if (bytes(allowedTokens[sourceTokenAddress].eip712Name).length == 0) return false;
        if (!_destinationAllowed(intent.spec)) return false;

        return _checkWeightedSigs(hash, ownerSigs);
    }

    /// @dev Set membership plus domain binding: every destination word must have its domain's address shape (an
    ///      allowlisted Solana key is not a valid Base recipient and vice versa), and the intent must name the
    ///      domain's own GatewayMinter.
    function _destinationAllowed(TransferSpec memory spec) internal view returns (bool) {
        uint32 domain = spec.destinationDomain;
        if (!allowedDestinationDomains[domain]) return false;
        bytes32 minter = destinationMinters[domain];
        if (minter == bytes32(0) || spec.destinationContract != minter) return false;
        if (!allowedDestinationTokens[spec.destinationToken]) return false;
        if (!GatewayIntentPolicy.matchesDomainShape(domain, spec.destinationToken)) return false;
        if (!allowedRecipients[spec.destinationRecipient]) return false;
        if (!GatewayIntentPolicy.matchesDomainShape(domain, spec.destinationRecipient)) return false;
        if (spec.destinationCaller != bytes32(0)) {
            if (!allowedDestinationCallers[spec.destinationCaller]) return false;
            if (!GatewayIntentPolicy.matchesDomainShape(domain, spec.destinationCaller)) return false;
        }
        return true;
    }

    function _validateReceiveWithAuth(bytes32 hash, bytes memory payload, bytes memory ownerSigs, address caller)
        internal
        view
        returns (bool)
    {
        TokenInfo storage ti = allowedTokens[caller];
        if (bytes(ti.eip712Name).length == 0) return false;

        (address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce) =
            abi.decode(payload, (address, address, uint256, uint256, uint256, bytes32));

        bytes32 digest = GatewayIntentPolicy.receiveWithAuthorizationDigest(
            ti.eip712Name, ti.eip712Version, caller, from, to, value, validAfter, validBefore, nonce
        );

        if (digest != hash) return false;
        if (from != address(this)) return false;
        if (to != gatewayWallet) return false;

        return _checkWeightedSigs(hash, ownerSigs);
    }

    /// @dev Weighted quorum over `ownerSigs`, a Safe-style signature blob:
    ///
    ///      static part: k slots of 65 bytes, ordered by STRICTLY ascending owner address across both kinds:
    ///        - EOA owner:      `r ‖ s ‖ v` with v in {27, 28} and low-s, recovered over `hash`;
    ///        - contract owner: `r ‖ s ‖ v` with v = 0, r = owner address (left-padded, upper 96 bits zero) and
    ///                          s = byte offset (from the start of `ownerSigs`) of that owner's dynamic signature.
    ///      dynamic part: for each contract owner, at its offset, a 32-byte big-endian length L followed by L bytes,
    ///        passed verbatim to `IERC1271(owner).isValidSignature(hash, sig)`.
    ///
    ///      The static part ends exactly at the lowest dynamic offset (or at the end of the blob when every owner
    ///      is an EOA, which keeps the pre-existing "length % 65 == 0" rule). Any offset that points into the
    ///      static part, a length word or body that runs past the end, an offset that leaves a partial slot, a
    ///      contract owner equal to this treasury, or a nested call that reverts / runs out of its gas cap / does
    ///      not return exactly the magic word, makes the whole blob invalid. Nothing here reverts.
    function _checkWeightedSigs(bytes32 hash, bytes memory ownerSigs) internal view returns (bool) {
        uint256 len = ownerSigs.length;
        if (len == 0) return false;

        uint256 staticEnd = len;
        uint256 i;
        address prevSigner = address(0);
        uint256 totalWeight;

        while ((i + 1) * 65 <= staticEnd) {
            bytes32 r;
            bytes32 s;
            uint8 v;

            // Reads only inside ownerSigs: (i + 1) * 65 <= staticEnd <= len.
            assembly ("memory-safe") {
                let base := add(add(ownerSigs, 0x20), mul(i, 65))
                r := mload(base)
                s := mload(add(base, 0x20))
                v := byte(0, mload(add(base, 0x40)))
            }

            address signer;
            if (v == 0) {
                // Contract owner (ERC-1271), Safe encoding.
                if (!GatewayIntentPolicy.isCanonicalAddress(r)) return false;
                signer = address(uint160(uint256(r)));
                // No recursion into ourselves (also refused at configuration time).
                if (signer == address(this)) return false;

                uint256 offset = uint256(s);
                // The dynamic part must start after this slot, and its length word must be in bounds
                // (len >= 65 here, so len - 32 cannot underflow).
                if (offset < (i + 1) * 65 || offset > len - 32) return false;
                uint256 dynLen;
                assembly ("memory-safe") {
                    dynLen := mload(add(add(ownerSigs, 0x20), offset))
                }
                if (dynLen > len - offset - 32) return false;
                if (offset < staticEnd) staticEnd = offset;

                if (signer <= prevSigner) return false;
                if (weights[signer] == 0) return false;

                bytes memory nestedSig = _slice(ownerSigs, offset + 32, dynLen);
                if (!GatewayIntentPolicy.isValidERC1271(signer, hash, nestedSig, NESTED_SIG_GAS)) return false;
            } else {
                if (uint256(s) > SECP256K1N_DIV_2) return false;

                (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, v, r, s);
                if (err != ECDSA.RecoverError.NoError) return false;
                signer = recovered;

                if (signer <= prevSigner) return false;
                if (weights[signer] == 0) return false;
            }

            totalWeight += weights[signer];
            prevSigner = signer;
            unchecked {
                ++i;
            }
        }

        // The static part must be whole slots and end exactly where the first dynamic part starts.
        if (i == 0 || i * 65 != staticEnd) return false;

        return totalWeight >= thresholdWeight;
    }

    /// @dev Copies `ownerSigs[start : start + length]` into a fresh `bytes`. Caller guarantees the range is in bounds.
    function _slice(bytes memory data, uint256 start, uint256 length) private pure returns (bytes memory out) {
        out = new bytes(length);
        for (uint256 j = 0; j < length; j += 32) {
            assembly ("memory-safe") {
                mstore(add(add(out, 0x20), j), mload(add(add(data, 0x20), add(start, j))))
            }
        }
        // The last word may have copied bytes past `length` into out's tail padding; zero them so the ABI
        // encoding of `out` is canonical.
        assembly ("memory-safe") {
            let end := add(add(out, 0x20), length)
            mstore(end, 0)
        }
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

    /// @param deadline Last timestamp at which these signatures may be submitted (part of the signed struct).
    function queueAdmin(bytes calldata call, uint256 nonce, uint256 deadline, bytes calldata ownerSigs) external {
        if (usedNonces[nonce]) revert NonceAlreadyUsed();
        if (block.timestamp > deadline) revert SignatureExpired();

        bytes32 callHash = keccak256(call);
        uint256 epoch = adminEpoch;
        bytes32 digest = _adminDigest(keccak256(abi.encode(ADMIN_OP_TYPEHASH, callHash, nonce, deadline, epoch)));

        if (!_checkWeightedSigs(digest, ownerSigs)) revert QuorumNotReached();

        usedNonces[nonce] = true;
        uint256 eta = block.timestamp + adminTimelock;

        adminOps[nonce] = AdminOp({callHash: callHash, eta: eta, executed: false, cancelled: false, epoch: epoch});

        emit AdminQueued(nonce, callHash, eta);
    }

    function executeAdmin(bytes calldata call, uint256 nonce) external {
        AdminOp storage op = adminOps[nonce];

        if (op.callHash == bytes32(0)) revert OpNotFound();
        if (op.executed) revert OpAlreadyExecuted();
        if (op.cancelled) revert OpAlreadyCancelled();
        if (op.epoch != adminEpoch) revert OpStale();
        if (block.timestamp < op.eta) revert TimelockNotExpired();
        if (block.timestamp > op.eta + ADMIN_OP_GRACE) revert OpExpired();
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

    /// @notice Cancels a queued op, OR burns a nonce that was never queued so that admin signatures collected for
    ///         it (and never submitted) can no longer be queued by whoever holds them.
    function cancelAdmin(uint256 nonce, bytes calldata ownerSigs) external {
        AdminOp storage op = adminOps[nonce];

        if (op.callHash == bytes32(0)) {
            if (usedNonces[nonce]) revert OpNotFound();
        } else {
            if (op.executed) revert OpAlreadyExecuted();
            if (op.cancelled) revert OpAlreadyCancelled();
        }

        bytes32 digest = _adminDigest(keccak256(abi.encode(CANCEL_ADMIN_OP_TYPEHASH, nonce)));

        if (!_checkWeightedSigs(digest, ownerSigs)) revert QuorumNotReached();

        usedNonces[nonce] = true;
        op.cancelled = true;

        emit AdminCancelled(nonce);
    }

    /// @notice Immediately (no timelock) refuses one burn intent by its EIP-712 digest. Quorum-signed; replaying the
    ///         signature only re-revokes. Gateway sees it after its block lag (up to ~5 minutes).
    function revokeIntent(bytes32 digest, bytes calldata ownerSigs) external {
        if (!_checkWeightedSigs(_adminDigest(keccak256(abi.encode(REVOKE_INTENT_TYPEHASH, digest))), ownerSigs)) {
            revert QuorumNotReached();
        }
        revokedIntents[digest] = true;
        emit IntentRevoked(digest);
    }

    /// @notice Immediately (no timelock) refuses every burn intent. Quorum-signed over a nonce from the admin nonce
    ///         space, so an old pause signature cannot be replayed after an unpause. Unpause is the timelocked
    ///         `setPaused(false)` admin op.
    function pause(uint256 nonce, bytes calldata ownerSigs) external {
        if (usedNonces[nonce]) revert NonceAlreadyUsed();
        if (!_checkWeightedSigs(_adminDigest(keccak256(abi.encode(PAUSE_TYPEHASH, nonce))), ownerSigs)) {
            revert QuorumNotReached();
        }
        usedNonces[nonce] = true;
        paused = true;
        emit PausedSet(true);
    }

    function _adminDigest(bytes32 structHash) private view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", _adminDomainSep, structHash));
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
            if (owner == address(0) || owner == address(this)) revert InvalidOwnerSet();

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
        adminEpoch++;

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

    function setDestinationMinter(uint32 domain, bytes32 minter) external onlySelf {
        destinationMinters[domain] = minter;
        emit DestinationMinterUpdated(domain, minter);
    }

    function setAllowedDestinationCaller(bytes32 caller, bool allowed) external onlySelf {
        allowedDestinationCallers[caller] = allowed;
        emit DestinationCallerUpdated(caller, allowed);
    }

    function setPaused(bool paused_) external onlySelf {
        paused = paused_;
        emit PausedSet(paused_);
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
        adminEpoch++;
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

    /// @notice The most one approved burn intent can debit from the Gateway balance: Gateway charges the fee ON TOP
    ///         of the value, so this is `perIntentCap + maxFeeCap`, not `perIntentCap`.
    function maxDebitPerIntent() external view returns (uint256) {
        return perIntentCap + maxFeeCap;
    }

    // ============================================================
    // Internal helpers
    // ============================================================

    function _isAllowedAdminSelector(bytes4 sel) internal pure returns (bool) {
        return sel == SEL_SET_OWNERS || sel == SEL_SET_RECIPIENT || sel == SEL_SET_DOMAIN || sel == SEL_SET_TOKEN
            || sel == SEL_SET_DEST_TOKEN || sel == SEL_SET_PER_INTENT_CAP || sel == SEL_SET_MAX_FEE_CAP
            || sel == SEL_SET_TIMELOCK || sel == SEL_GW_INITIATE_WITHDRAWAL || sel == SEL_GW_WITHDRAW
            || sel == SEL_TRANSFER_RECIPIENT || sel == SEL_SET_MAX_EXPIRY || sel == SEL_SET_DEST_MINTER
            || sel == SEL_SET_DEST_CALLER || sel == SEL_SET_PAUSED;
    }
}
