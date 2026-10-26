// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {TreasuryBridgeConduit} from "./TreasuryBridgeConduit.sol";
import {IPermit2SignatureTransfer} from "./interfaces/IPermit2SignatureTransfer.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Adds quorum-authorized Permit2 funding to the existing source conversion/burn.
/// @dev This event proves a source burn only. Destination mint, second quorum, final delivery and
/// document finalization remain separate. Existing ERC-3009 execute/rescue semantics are inherited.
contract TreasuryBridgeConduitPermit2 is TreasuryBridgeConduit {
    using SafeERC20 for IERC20;

    address public constant CANONICAL_PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    IPermit2SignatureTransfer public immutable permit2;
    bytes32 public constant PERMIT2_BRIDGE_INTENT_TYPEHASH = keccak256(
        "Permit2BridgeIntent(uint256 chainId,address conduit,address treasury,bytes32 operationId,bytes32 documentCommitment,address allowanceTarget,bytes32 bridgeIntentHash)"
    );
    bytes32 public constant CONDUIT_WITNESS_TYPEHASH =
        keccak256("ConduitWitness(bytes32 operationId,bytes32 intentHash)");
    string public constant WITNESS_TYPE_STRING =
        "ConduitWitness witness)ConduitWitness(bytes32 operationId,bytes32 intentHash)TokenPermissions(address token,uint256 amount)";

    mapping(address treasury => mapping(bytes32 operationId => bool)) public executed;
    mapping(address target => mapping(address allowanceTarget => bool)) public permit2Routes;
    bool private _checkingPermit2Burn;

    event Permit2RouteSet(address indexed target, address indexed allowanceTarget, bool allowed);
    event Permit2BridgeSubmitted(
        address indexed treasury,
        bytes32 indexed operationId,
        bytes32 indexed documentCommitment,
        bytes32 intentHash,
        uint256 nonce,
        uint256 burnAmount
    );

    error InvalidPermit2Deployment();
    error InvalidPermit2Intent();
    error Permit2DeadlineMismatch();
    error OperationAlreadyExecuted();
    error Permit2RouteNotRegistered();
    error InexactInput();
    error PriorBalanceConsumed();
    error AllowanceMismatch(address token, address spender, uint256 expected, uint256 actual);

    constructor(address initialOwner, address permit2_) TreasuryBridgeConduit(initialOwner) {
        if (permit2_ != CANONICAL_PERMIT2 || permit2_.code.length == 0) revert InvalidPermit2Deployment();
        permit2 = IPermit2SignatureTransfer(permit2_);
    }

    function setPermit2Route(address target, address allowanceTarget, bool allowed) external onlyOwner {
        if (allowed && (target.code.length == 0 || allowanceTarget.code.length == 0)) revert InvalidPermit2Intent();
        permit2Routes[target][allowanceTarget] = allowed;
        emit Permit2RouteSet(target, allowanceTarget, allowed);
    }

    function permit2BridgeIntentHash(
        address treasury,
        bytes32 operationId,
        bytes32 documentCommitment,
        address allowanceTarget,
        Intent calldata intent
    ) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                PERMIT2_BRIDGE_INTENT_TYPEHASH,
                block.chainid,
                address(this),
                treasury,
                operationId,
                documentCommitment,
                allowanceTarget,
                intentNonce(intent)
            )
        );
    }

    function executePermit2(
        IPermit2SignatureTransfer.PermitTransferFrom calldata permit,
        address treasury,
        bytes calldata signature,
        bytes32 operationId,
        bytes32 documentCommitment,
        address allowanceTarget,
        Intent calldata intent,
        bytes calldata bridgeQuote
    ) external payable nonReentrant {
        if (
            treasury.code.length == 0 || operationId == bytes32(0) || intent.amountIn == 0
                || intent.minBridgeAmount == 0
        ) {
            revert InvalidPermit2Intent();
        }
        if (executed[treasury][operationId]) revert OperationAlreadyExecuted();
        if (permit.deadline != intent.deadline) revert Permit2DeadlineMismatch();
        if (block.timestamp >= intent.deadline) revert IntentExpired(intent.deadline, block.timestamp);
        _check(
            Authorization(
                permit.permitted.token, treasury, permit.permitted.amount, 0, permit.deadline, intentNonce(intent)
            ),
            intent,
            bridgeQuote
        );
        if (intent.venue == address(0)) {
            if (allowanceTarget != address(0)) revert InvalidPermit2Intent();
        } else if (!permit2Routes[intent.venue][allowanceTarget]) {
            revert Permit2RouteNotRegistered();
        }

        IERC20 tokenIn = IERC20(intent.tokenIn);
        IERC20 bridgeAsset = IERC20(intent.bridgeAsset);
        uint256 inputBefore = tokenIn.balanceOf(address(this));
        uint256 bridgeBefore = bridgeAsset.balanceOf(address(this));
        uint256 treasuryBefore = tokenIn.balanceOf(treasury);
        bytes32 intentHash = permit2BridgeIntentHash(treasury, operationId, documentCommitment, allowanceTarget, intent);
        executed[treasury][operationId] = true;
        permit2.permitWitnessTransferFrom(
            permit,
            IPermit2SignatureTransfer.SignatureTransferDetails(address(this), intent.amountIn),
            treasury,
            keccak256(abi.encode(CONDUIT_WITNESS_TYPEHASH, operationId, intentHash)),
            WITNESS_TYPE_STRING,
            signature
        );
        if (
            tokenIn.balanceOf(address(this)) != inputBefore + intent.amountIn
                || tokenIn.balanceOf(treasury) + intent.amountIn != treasuryBefore
        ) revert InexactInput();

        if (intent.venue != address(0)) {
            tokenIn.forceApprove(allowanceTarget, intent.amountIn);
            _requireAllowance(tokenIn, allowanceTarget, intent.amountIn);
            (bool ok, bytes memory result) = intent.venue.call(intent.venueData);
            if (!ok) revert TargetCallFailed(result);
            tokenIn.forceApprove(allowanceTarget, 0);
            _requireAllowance(tokenIn, allowanceTarget, 0);
        }

        uint256 held = bridgeAsset.balanceOf(address(this));
        if (held < bridgeBefore) revert PriorBalanceConsumed();
        uint256 burnAmount = held - bridgeBefore;
        if (burnAmount < intent.minBridgeAmount) revert BelowFloor(burnAmount, intent.minBridgeAmount);
        _checkingPermit2Burn = true;
        _burn(intent, bridgeAsset, burnAmount, bridgeQuote);
        _checkingPermit2Burn = false;
        uint256 afterBurn = bridgeAsset.balanceOf(address(this));
        if (afterBurn > held || held - afterBurn != burnAmount) {
            revert BurnMismatch(afterBurn > held ? 0 : held - afterBurn, burnAmount);
        }
        uint256 inputAfter = tokenIn.balanceOf(address(this));
        if (inputAfter < inputBefore) revert PriorBalanceConsumed();
        if (inputAfter > inputBefore) {
            uint256 refund = inputAfter - inputBefore;
            uint256 beforeRefund = tokenIn.balanceOf(treasury);
            tokenIn.safeTransfer(treasury, refund);
            if (tokenIn.balanceOf(treasury) != beforeRefund + refund) revert InexactInput();
        }
        if (tokenIn.balanceOf(address(this)) != inputBefore || bridgeAsset.balanceOf(address(this)) != bridgeBefore) {
            revert PriorBalanceConsumed();
        }

        emit Bridged(
            treasury,
            intent.memoId,
            intent.destinationDomain,
            bytes32(permit.nonce),
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
        emit Permit2BridgeSubmitted(treasury, operationId, documentCommitment, intentHash, permit.nonce, burnAmount);
    }

    function _checkBridgeAllowance(IERC20 token, address spender, uint256 expected) internal view override {
        // Preserve inherited ERC-3009 behavior; only this adapter's Permit2 burn opts in.
        if (_checkingPermit2Burn) _requireAllowance(token, spender, expected);
    }

    function _requireAllowance(IERC20 token, address spender, uint256 expected) private view {
        uint256 actual = token.allowance(address(this), spender);
        if (actual != expected) revert AllowanceMismatch(address(token), spender, expected, actual);
    }
}
