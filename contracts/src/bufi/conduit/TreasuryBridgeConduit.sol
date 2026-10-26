// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IFiatTokenV2} from "./interfaces/IFiatTokenV2.sol";

/// @notice Circle CCTP V2 `TokenMessengerV2`, the one entry point this conduit
/// calls. Selector `0x8e0250ee`, present in the live implementation behind
/// `0x28b5a0e9c621a5badaa536219b3a228c8168cf5d` on Arc (5042) and Avalanche
/// (43114), read 2026-10-15.
interface ITokenMessengerV2 {
    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external;
}

/// @notice Circle CCTPx `CrossChainTokenService` (CCTS), the minimal surface
/// Circle's own SDK uses. Pinned from `crossChainTokenServiceAbi` in the npm
/// package circle-fin/adapter-viem-v2 v1.19.0, the encoder behind the
/// `cctpx.crossChainTransfer` action of circle-fin/provider-cctpx v1.0.2.
/// Selector `0x780c5acf`, present in the live implementation behind proxy
/// `0x431871229103b780868f8C6BB820cd16ECf942BC` on Arc and Avalanche, read
/// 2026-10-15.
interface ICrossChainTokenService {
    /// `IFeeManager.QuoteClaim`: an IRIS-signed fee quote plus where any
    /// unused native fee is refunded.
    struct QuoteClaim {
        bytes signedQuote;
        address payable refundAddress;
    }

    function crossChainTransfer(
        bytes32 tokenId,
        uint256 amount,
        uint32 destinationDomain,
        bytes calldata destinationAddress,
        bytes32 destinationCaller,
        uint32 minFinalityThreshold,
        QuoteClaim calldata claim,
        bool autoExecuteHookData,
        bytes calldata hookData
    ) external payable;

    /// The per-token TokenManager that locks or burns the token, which is
    /// the address the bridged amount must be approved to.
    function resolveTokenManager(bytes32 tokenId) external view returns (address);
}

/**
 * @title TreasuryBridgeConduit
 * @notice One quorum-signed transaction that moves a treasury MSCA's stablecoin
 * to ANOTHER CHAIN's treasury: pull on the source chain, optionally swap into
 * the bridge asset, burn it through Circle's cross-chain rail with the
 * destination treasury as the mint recipient, and return every leftover to the
 * source treasury. Nothing is held by anyone in between, and a failure anywhere
 * reverts the whole transaction. Plan 408 v2 (desk-v1).
 *
 * ## Why it exists
 *
 * BUFI treasuries are Circle ERC-6900 accounts with the ColdStorageAddressBook
 * plugin installed. That plugin's userOp validation hook understands only
 * ERC-20/721/1155 transfer and approve selectors, so the treasury can never
 * call a router, `TokenMessengerV2.depositForBurn`, or
 * `CrossChainTokenService.crossChainTransfer` itself
 * (`UnauthorizedRecipient(account, address(0))` at the bundler). The sibling
 * {TreasuryConduit} solved this for same-chain protocol calls. This contract is
 * the cross-chain counterpart, and it replaces plan 408 v1, which bridged
 * through a BUFI-held Circle wallet across several relay legs.
 *
 * Circle's FiatToken pays an ERC-3009 `receiveWithAuthorization` to
 * `msg.sender` and validates ERC-1271 signers. So THIS contract is the payee.
 * The token moves the funds on the quorum's signature, no userOp runs, and the
 * AddressBook never sees the call.
 *
 * ## What the quorum signs
 *
 * One {Intent}, hashed into the ERC-3009 nonce:
 * `auth.nonce == keccak256(abi.encode(INTENT_TYPEHASH, …))`. It covers the
 * venue and the keccak of its calldata, both tokens and amounts, the floor, the
 * bridge kind and contract, the destination domain, mint recipient and caller,
 * the max fee, the finality threshold, the beneficiary, the deadline and the
 * memo. Change any one of them and the authorization no longer redeems. The
 * nonce check runs FIRST, so a tampered intent always reports
 * `NonceIsNotTheIntent` and never a later, less precise error.
 *
 * ## Invariants
 *
 *  1. Funds leave the treasury only under its own quorum-signed authorization
 *     whose nonce commits to the whole intent.
 *  2. The amount burned is the bridge asset THIS transaction delivered to this
 *     contract (balance after the swap minus balance before the pull). It is
 *     at least `minBridgeAmount` and never more than what arrived.
 *  3. The burn receives exactly the signed `destinationDomain`,
 *     `mintRecipient`, `destinationCaller`, `maxFee` and
 *     `minFinalityThreshold`. The bridge must take exactly the burn amount.
 *  4. Afterwards this contract holds none of `tokenIn` or the bridge asset,
 *     and has no allowance left to the venue, the bridge, or the TokenManager.
 *  5. Every leftover goes to `auth.from`, the source treasury, which is also
 *     the required `beneficiary`.
 *  6. Venues, bridges and CCTPx token ids come from registries owned by the
 *     chain's Safe. They add defence in depth on top of the quorum's binding
 *     signature and never replace it.
 *  7. `execute` is permissionless. The caller pays gas and, on the CCTPx
 *     path, the native protocol fee (`msg.value`), which is capped by the
 *     signed `maxFee`. Treasury funds never pay that fee.
 */
contract TreasuryBridgeConduit is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Which Circle rail burns the bridge asset.
    enum BridgeKind {
        /// USDC through CCTP V2 `TokenMessengerV2.depositForBurn`. `maxFee` is in
        /// burn-token units and is deducted on the destination.
        CCTP_V2,
        /// Non-USDC Circle tokens (EURC, cirBTC…) through CCTPx
        /// `CrossChainTokenService.crossChainTransfer`. `maxFee` caps the NATIVE
        /// fee (`msg.value`) the caller pays.
        CCTPX
    }

    /// @dev The ERC-3009 authorization the quorum signed, minus the signature.
    struct Authorization {
        address token;
        address from;
        uint256 value;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce;
    }

    /// @dev Where the money goes. Hashed into `Authorization.nonce`.
    struct Intent {
        /// Swap venue to call, or `address(0)` for no swap (then `tokenIn` must be `bridgeAsset`).
        address venue;
        /// The exact venue calldata the quorum reviewed. Must be empty when `venue == 0`.
        bytes venueData;
        /// The stablecoin pulled from the treasury. Must equal `auth.token`.
        address tokenIn;
        /// How much of it. Must equal `auth.value`.
        uint256 amountIn;
        /// The token that is burned cross-chain.
        address bridgeAsset;
        /// The burn amount must be at least this, in `bridgeAsset` atomic units.
        uint256 minBridgeAmount;
        /// Which Circle rail.
        BridgeKind bridgeKind;
        /// The TokenMessengerV2 (CCTP_V2) or CrossChainTokenService (CCTPX) to call. Must be registered.
        address bridge;
        /// CCTPx token id of `bridgeAsset`. Must be zero for CCTP_V2.
        bytes32 bridgeTokenId;
        /// Circle domain of the destination chain (Arc 26, Avalanche 1…).
        uint32 destinationDomain;
        /// The destination treasury, left-padded to 32 bytes.
        bytes32 mintRecipient;
        /// Who may relay the destination mint. Zero means anyone.
        bytes32 destinationCaller;
        /// CCTP_V2: max fee in burn-token units. CCTPX: max native fee (`msg.value`) in wei.
        uint256 maxFee;
        /// 1000 = FAST, 2000 = SLOW (Circle's constants). Signed, not hard-coded.
        uint32 minFinalityThreshold;
        /// Who receives every leftover. Must equal `auth.from`.
        address beneficiary;
        /// Unix time after which the intent is void even if the authorization window is open.
        uint256 deadline;
        /// A 32-byte reference to find this movement by later. Indexed on `Bridged`.
        bytes32 memoId;
        /// Free-form memo bytes, emitted verbatim.
        bytes memo;
    }

    /// @notice EIP-712-style struct type for the intent. The name differs from
    /// {TreasuryConduit}'s `Intent`, so the two contracts' nonces can never
    /// collide. `bridgeKind` is encoded as `uint8`.
    bytes32 public constant INTENT_TYPEHASH = keccak256(
        "BridgeIntent(address venue,bytes venueData,address tokenIn,uint256 amountIn,address bridgeAsset,uint256 minBridgeAmount,uint8 bridgeKind,address bridge,bytes32 bridgeTokenId,uint32 destinationDomain,bytes32 mintRecipient,bytes32 destinationCaller,uint256 maxFee,uint32 minFinalityThreshold,address beneficiary,uint256 deadline,bytes32 memoId,bytes memo)"
    );

    /// @notice Swap venues an intent may call on this chain.
    mapping(address venue => bool allowed) public targets;
    /// @notice Burn contracts, per rail.
    mapping(BridgeKind kind => mapping(address bridge => bool allowed)) public bridges;
    /// @notice The ERC-20 a CCTPx token id stands for on this chain. Zero = not allowed.
    mapping(bytes32 tokenId => address token) public cctpxTokens;

    event TargetSet(address indexed target, bool allowed);
    event BridgeSet(BridgeKind indexed kind, address indexed bridge, bool allowed);
    event CctpxTokenSet(bytes32 indexed tokenId, address indexed token);
    event Bridged(
        address indexed treasury,
        bytes32 indexed memoId,
        uint32 indexed destinationDomain,
        bytes32 nonce,
        BridgeKind kind,
        address bridge,
        address tokenIn,
        uint256 amountIn,
        address bridgeAsset,
        uint256 burnAmount,
        bytes32 mintRecipient,
        uint256 maxFee,
        bytes memo
    );

    error NonceIsNotTheIntent(bytes32 nonce, bytes32 expected);
    error BeneficiaryMismatch(address beneficiary, address from);
    error TokenMismatch(address tokenIn, address token);
    error AmountMismatch(uint256 amountIn, uint256 value);
    error IntentExpired(uint256 deadline, uint256 now_);
    error TargetNotRegistered(address target);
    error VenueIsABridge(address venue);
    error SwapTokensIdentical(address token);
    error NoSwapButTokensDiffer(address tokenIn, address bridgeAsset);
    error NoSwapButCalldata();
    error TargetCallFailed(bytes reason);
    error BridgeNotRegistered(BridgeKind kind, address bridge);
    error BridgeTokenMismatch(bytes32 tokenId, address registered, address bridgeAsset);
    error UnexpectedBridgeTokenId(bytes32 tokenId);
    error ZeroMintRecipient();
    error NonEvmRecipient(bytes32 mintRecipient);
    error NativeFeeNotAllowed(uint256 value);
    error QuoteNotAllowed();
    error FeeAboveMax(uint256 fee, uint256 maxFee);
    error BelowFloor(uint256 burnAmount, uint256 minBridgeAmount);
    error BurnMismatch(uint256 pulled, uint256 burnAmount);
    error ZeroAddress();
    error NothingToSweep();

    constructor(address initialOwner) Ownable(initialOwner) {}

    // ── governance (owner = the chain's Safe)
    // ───────────────────────────────

    /// @notice Register or retire a swap venue.
    function setTarget(address target, bool allowed) external onlyOwner {
        if (target == address(0)) revert ZeroAddress();
        targets[target] = allowed;
        emit TargetSet(target, allowed);
    }

    /// @notice Register or retire a burn contract for one rail.
    function setBridge(BridgeKind kind, address bridge, bool allowed) external onlyOwner {
        if (bridge == address(0)) revert ZeroAddress();
        bridges[kind][bridge] = allowed;
        emit BridgeSet(kind, bridge, allowed);
    }

    /// @notice Bind a CCTPx token id to its ERC-20 on this chain (`address(0)` retires it).
    /// Never bind Arc's native-backed USDC here: USDC goes through CCTP_V2.
    function setCctpxToken(bytes32 tokenId, address token) external onlyOwner {
        cctpxTokens[tokenId] = token;
        emit CctpxTokenSet(tokenId, token);
    }

    // ── the one entry point
    // ─────────────────────────────────────────────────

    /// @notice The nonce a given intent must be signed under.
    function intentNonce(Intent calldata intent) public pure returns (bytes32) {
        // Every field is a static 32-byte word once the dynamic ones are hashed,
        // so concatenating two `abi.encode` halves equals one flat encode (it
        // only keeps the stack shallow).
        return keccak256(
            bytes.concat(
                abi.encode(
                    INTENT_TYPEHASH,
                    intent.venue,
                    keccak256(intent.venueData),
                    intent.tokenIn,
                    intent.amountIn,
                    intent.bridgeAsset,
                    intent.minBridgeAmount,
                    uint8(intent.bridgeKind),
                    intent.bridge,
                    intent.bridgeTokenId
                ),
                abi.encode(
                    intent.destinationDomain,
                    intent.mintRecipient,
                    intent.destinationCaller,
                    intent.maxFee,
                    intent.minFinalityThreshold,
                    intent.beneficiary,
                    intent.deadline,
                    intent.memoId,
                    keccak256(intent.memo)
                )
            )
        );
    }

    /**
     * @notice Pull `auth.value` of `auth.token` from the treasury on its quorum's
     * signature, optionally swap it into the bridge asset, burn it cross-chain
     * to the signed destination treasury, and return every leftover.
     * @param bridgeQuote CCTPX only: the IRIS-signed fee quote, forwarded
     * verbatim. It is NOT part of the intent, because a quote expires in
     * minutes while a quorum may take hours. It can only set the native fee,
     * which the caller pays and the signed `maxFee` caps. Must be empty for
     * CCTP_V2.
     * @dev Anyone may call. Reverts as a whole on any failure; a revert leaves
     * the authorization nonce unused, so the same signature can be retried.
     */
    function execute(
        Authorization calldata auth,
        bytes calldata quorumSignature,
        Intent calldata intent,
        bytes calldata bridgeQuote
    ) external payable nonReentrant {
        _check(auth, intent, bridgeQuote);

        IERC20 tokenIn = IERC20(intent.tokenIn);
        IERC20 bridgeAsset = IERC20(intent.bridgeAsset);
        uint256 bridgeBefore = bridgeAsset.balanceOf(address(this));

        // 1. The token moves the funds on the treasury's own signature. `to` is
        //    this contract, which FiatToken requires to be msg.sender.
        IFiatTokenV2(auth.token)
            .receiveWithAuthorization(
                auth.from, address(this), auth.value, auth.validAfter, auth.validBefore, auth.nonce, quorumSignature
            );

        // 2. The optional swap: exactly the redeemed amount, cleared afterwards.
        if (intent.venue != address(0)) {
            tokenIn.forceApprove(intent.venue, intent.amountIn);
            (bool ok, bytes memory ret) = intent.venue.call(intent.venueData);
            if (!ok) revert TargetCallFailed(ret);
            tokenIn.forceApprove(intent.venue, 0);
        }

        // 3. The measured floor. Only what THIS transaction delivered counts, so
        //    a stray balance is never burned.
        uint256 held = bridgeAsset.balanceOf(address(this));
        uint256 burnAmount = held - bridgeBefore;
        if (burnAmount < intent.minBridgeAmount) revert BelowFloor(burnAmount, intent.minBridgeAmount);

        // 4. The burn, to exactly the signed destination.
        _burn(intent, bridgeAsset, burnAmount, bridgeQuote);
        uint256 pulled = held - bridgeAsset.balanceOf(address(this));
        if (pulled != burnAmount) revert BurnMismatch(pulled, burnAmount);

        // 5. Every leftover token goes back to the treasury.
        _sweep(tokenIn, auth.from);
        if (address(bridgeAsset) != address(tokenIn)) _sweep(bridgeAsset, auth.from);

        emit Bridged(
            auth.from,
            intent.memoId,
            intent.destinationDomain,
            auth.nonce,
            intent.bridgeKind,
            intent.bridge,
            intent.tokenIn,
            intent.amountIn,
            intent.bridgeAsset,
            burnAmount,
            intent.mintRecipient,
            intent.maxFee,
            intent.memo
        );
    }

    /// @notice Return any token this contract holds. Never needed when `execute`
    /// runs to completion; exists for direct transfers sent here by mistake.
    function rescue(address token, address to) external onlyOwner {
        uint256 amount = IERC20(token).balanceOf(address(this));
        if (amount == 0) revert NothingToSweep();
        IERC20(token).safeTransfer(to, amount);
    }

    // ── internals
    // ───────────────────────────────────────────────────────────

    function _check(Authorization memory auth, Intent calldata intent, bytes calldata bridgeQuote) internal view {
        // The nonce first: any edit to a signed field fails here, precisely.
        bytes32 expected = intentNonce(intent);
        if (auth.nonce != expected) revert NonceIsNotTheIntent(auth.nonce, expected);
        if (intent.beneficiary != auth.from) revert BeneficiaryMismatch(intent.beneficiary, auth.from);
        if (intent.tokenIn != auth.token) revert TokenMismatch(intent.tokenIn, auth.token);
        if (intent.amountIn != auth.value) revert AmountMismatch(intent.amountIn, auth.value);
        if (block.timestamp > intent.deadline) revert IntentExpired(intent.deadline, block.timestamp);

        if (intent.venue == address(0)) {
            if (intent.venueData.length != 0) revert NoSwapButCalldata();
            if (intent.tokenIn != intent.bridgeAsset) revert NoSwapButTokensDiffer(intent.tokenIn, intent.bridgeAsset);
        } else {
            if (!targets[intent.venue]) revert TargetNotRegistered(intent.venue);
            if (bridges[BridgeKind.CCTP_V2][intent.venue] || bridges[BridgeKind.CCTPX][intent.venue]) {
                revert VenueIsABridge(intent.venue);
            }
            if (intent.tokenIn == intent.bridgeAsset) revert SwapTokensIdentical(intent.tokenIn);
        }

        if (!bridges[intent.bridgeKind][intent.bridge]) revert BridgeNotRegistered(intent.bridgeKind, intent.bridge);
        if (intent.mintRecipient == bytes32(0)) revert ZeroMintRecipient();

        if (intent.bridgeKind == BridgeKind.CCTP_V2) {
            if (intent.bridgeTokenId != bytes32(0)) revert UnexpectedBridgeTokenId(intent.bridgeTokenId);
            // On Arc, native value IS USDC: a fee sent here would inflate the
            // very balance being measured. CCTP_V2 takes its fee in-token.
            if (msg.value != 0) revert NativeFeeNotAllowed(msg.value);
            if (bridgeQuote.length != 0) revert QuoteNotAllowed();
        } else {
            address registered = cctpxTokens[intent.bridgeTokenId];
            if (registered == address(0) || registered != intent.bridgeAsset) {
                revert BridgeTokenMismatch(intent.bridgeTokenId, registered, intent.bridgeAsset);
            }
            // Only EVM destinations for now: the recipient must fit 20 bytes.
            if (uint256(intent.mintRecipient) >> 160 != 0) revert NonEvmRecipient(intent.mintRecipient);
            if (msg.value > intent.maxFee) revert FeeAboveMax(msg.value, intent.maxFee);
        }
    }

    function _burn(Intent calldata intent, IERC20 bridgeAsset, uint256 burnAmount, bytes calldata bridgeQuote)
        internal
    {
        if (intent.bridgeKind == BridgeKind.CCTP_V2) {
            bridgeAsset.forceApprove(intent.bridge, burnAmount);
            _checkBridgeAllowance(bridgeAsset, intent.bridge, burnAmount);
            ITokenMessengerV2(intent.bridge)
                .depositForBurn(
                    burnAmount,
                    intent.destinationDomain,
                    intent.mintRecipient,
                    address(bridgeAsset),
                    intent.destinationCaller,
                    intent.maxFee,
                    intent.minFinalityThreshold
                );
            bridgeAsset.forceApprove(intent.bridge, 0);
            _checkBridgeAllowance(bridgeAsset, intent.bridge, 0);
            return;
        }

        ICrossChainTokenService ccts = ICrossChainTokenService(intent.bridge);
        address tokenManager = ccts.resolveTokenManager(intent.bridgeTokenId);
        if (tokenManager == address(0)) revert ZeroAddress();
        bridgeAsset.forceApprove(tokenManager, burnAmount);
        _checkBridgeAllowance(bridgeAsset, tokenManager, burnAmount);

        // The whole `msg.value` goes to the service. The FeeManager refunds any
        // excess over the quoted fee to `refundAddress`, the caller who paid it.
        // This contract has no `receive`, so it can never be left holding
        // native value.
        ccts.crossChainTransfer{value: msg.value}(
            intent.bridgeTokenId,
            burnAmount,
            intent.destinationDomain,
            abi.encodePacked(address(uint160(uint256(intent.mintRecipient)))),
            intent.destinationCaller,
            intent.minFinalityThreshold,
            ICrossChainTokenService.QuoteClaim({signedQuote: bridgeQuote, refundAddress: payable(msg.sender)}),
            false,
            ""
        );
        bridgeAsset.forceApprove(tokenManager, 0);
        _checkBridgeAllowance(bridgeAsset, tokenManager, 0);
    }

    /// @dev Intentionally empty for the historical ERC-3009 path. New funding
    /// adapters may opt into stricter allowance postconditions around this same burn.
    function _checkBridgeAllowance(IERC20, address, uint256) internal view virtual {}

    function _sweep(IERC20 token, address to) private {
        uint256 amount = token.balanceOf(address(this));
        if (amount > 0) token.safeTransfer(to, amount);
    }
}
