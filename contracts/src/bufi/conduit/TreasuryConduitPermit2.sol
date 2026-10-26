// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {TreasuryConduit} from "./TreasuryConduit.sol";
import {IPermit2SignatureTransfer} from "./interfaces/IPermit2SignatureTransfer.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface ITreasuryAddressBook {
    function getAllowedRecipients(address account) external view returns (address[] memory);
}

/// @notice Same-chain, exact-transfer ERC20 funding through Permit2 and the treasury's ERC-1271 quorum.
/// @dev This is a new deployment. The inherited ERC-3009 entrypoint and owner rescue retain their legacy
/// semantics. executePermit2 keeps donated balances separate and never retains operation funds on success.
contract TreasuryConduitPermit2 is TreasuryConduit {
    using SafeERC20 for IERC20;

    address public constant CANONICAL_PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    IPermit2SignatureTransfer public immutable permit2;
    ITreasuryAddressBook public immutable addressBook;

    struct Permit2Intent {
        bytes32 operationId;
        bytes32 documentCommitment;
        address target;
        address allowanceTarget;
        bytes data;
        address tokenIn;
        uint256 amountIn;
        address tokenOut;
        uint256 minOut;
        address recipient;
        uint256 deadline;
        bytes32 memoId;
        bytes memo;
    }

    bytes32 public constant PERMIT2_INTENT_TYPEHASH = keccak256(
        "Permit2Intent(uint256 chainId,address conduit,address treasury,bytes32 operationId,bytes32 documentCommitment,address target,address allowanceTarget,bytes32 dataHash,address tokenIn,uint256 amountIn,address tokenOut,uint256 minOut,address recipient,uint256 deadline,bytes32 memoId,bytes32 memoHash)"
    );
    bytes32 public constant CONDUIT_WITNESS_TYPEHASH =
        keccak256("ConduitWitness(bytes32 operationId,bytes32 intentHash)");
    string public constant WITNESS_TYPE_STRING =
        "ConduitWitness witness)ConduitWitness(bytes32 operationId,bytes32 intentHash)TokenPermissions(address token,uint256 amount)";

    mapping(address treasury => mapping(bytes32 operationId => bool)) public executed;
    mapping(address target => mapping(address allowanceTarget => bool)) public permit2Routes;

    event Permit2RouteSet(address indexed target, address indexed allowanceTarget, bool allowed);
    event Permit2Executed(
        address indexed treasury,
        bytes32 indexed operationId,
        bytes32 indexed memoId,
        bytes32 documentCommitment,
        address target,
        address tokenIn,
        uint256 amountIn,
        address tokenOut,
        address recipient,
        uint256 received,
        uint256 nonce,
        bytes32 intentHash,
        bytes memo
    );

    error InvalidPermit2Deployment();
    error InvalidPermit2Intent();
    error Permit2DeadlineMismatch();
    error OperationAlreadyExecuted();
    error Permit2RouteNotRegistered();
    error RecipientNotInAddressBook();
    error InexactInput();
    error PriorBalanceConsumed();
    error InexactOutput();

    constructor(address initialOwner, address permit2_, address addressBook_) TreasuryConduit(initialOwner) {
        if (permit2_ != CANONICAL_PERMIT2 || permit2_.code.length == 0 || addressBook_.code.length == 0) {
            revert InvalidPermit2Deployment();
        }
        permit2 = IPermit2SignatureTransfer(permit2_);
        addressBook = ITreasuryAddressBook(addressBook_);
    }

    /// @notice The Safe registers the call target and its exact token spender as one reviewed pair.
    function setPermit2Route(address target, address allowanceTarget, bool allowed) external onlyOwner {
        if (allowed && (target.code.length == 0 || allowanceTarget.code.length == 0)) {
            revert InvalidPermit2Intent();
        }
        permit2Routes[target][allowanceTarget] = allowed;
        emit Permit2RouteSet(target, allowanceTarget, allowed);
    }

    function permit2IntentHash(address treasury, Permit2Intent calldata intent) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                PERMIT2_INTENT_TYPEHASH,
                block.chainid,
                address(this),
                treasury,
                intent.operationId,
                intent.documentCommitment,
                intent.target,
                intent.allowanceTarget,
                keccak256(intent.data),
                intent.tokenIn,
                intent.amountIn,
                intent.tokenOut,
                intent.minOut,
                intent.recipient,
                intent.deadline,
                intent.memoId,
                keccak256(intent.memo)
            )
        );
    }

    function executePermit2(
        IPermit2SignatureTransfer.PermitTransferFrom calldata permit,
        address treasury,
        bytes calldata signature,
        Permit2Intent calldata intent
    ) external nonReentrant {
        if (
            treasury.code.length == 0 || intent.operationId == bytes32(0) || intent.amountIn == 0 || intent.minOut == 0
                || intent.recipient == address(0) || intent.recipient == address(this)
                || intent.tokenIn == intent.tokenOut || intent.tokenIn.code.length == 0
                || intent.tokenOut.code.length == 0
        ) revert InvalidPermit2Intent();
        if (executed[treasury][intent.operationId]) revert OperationAlreadyExecuted();
        if (permit.permitted.token != intent.tokenIn) revert TokenMismatch(intent.tokenIn, permit.permitted.token);
        if (permit.permitted.amount != intent.amountIn) {
            revert AmountMismatch(intent.amountIn, permit.permitted.amount);
        }
        if (permit.deadline != intent.deadline) revert Permit2DeadlineMismatch();
        if (block.timestamp >= intent.deadline) revert IntentExpired(intent.deadline, block.timestamp);
        if (!permit2Routes[intent.target][intent.allowanceTarget]) revert Permit2RouteNotRegistered();
        if (intent.documentCommitment == bytes32(0)) {
            if (intent.recipient != treasury) revert BeneficiaryMismatch(intent.recipient, treasury);
        } else if (!_isAllowedRecipient(treasury, intent.recipient)) {
            revert RecipientNotInAddressBook();
        }

        IERC20 tokenIn = IERC20(intent.tokenIn);
        IERC20 tokenOut = IERC20(intent.tokenOut);
        uint256 inputBefore = tokenIn.balanceOf(address(this));
        uint256 outputBefore = tokenOut.balanceOf(address(this));
        uint256 treasuryInputBefore = tokenIn.balanceOf(treasury);
        uint256 recipientBefore = tokenOut.balanceOf(intent.recipient);
        bytes32 intentHash = permit2IntentHash(treasury, intent);
        executed[treasury][intent.operationId] = true;

        permit2.permitWitnessTransferFrom(
            permit,
            IPermit2SignatureTransfer.SignatureTransferDetails(address(this), intent.amountIn),
            treasury,
            keccak256(abi.encode(CONDUIT_WITNESS_TYPEHASH, intent.operationId, intentHash)),
            WITNESS_TYPE_STRING,
            signature
        );
        if (
            tokenIn.balanceOf(address(this)) != inputBefore + intent.amountIn
                || tokenIn.balanceOf(treasury) + intent.amountIn != treasuryInputBefore
        ) revert InexactInput();

        tokenIn.forceApprove(intent.allowanceTarget, intent.amountIn);
        (bool ok, bytes memory result) = intent.target.call(intent.data);
        if (!ok) revert TargetCallFailed(result);
        tokenIn.forceApprove(intent.allowanceTarget, 0);

        uint256 inputAfter = tokenIn.balanceOf(address(this));
        uint256 outputAfter = tokenOut.balanceOf(address(this));
        if (inputAfter < inputBefore || outputAfter < outputBefore) revert PriorBalanceConsumed();
        if (inputAfter > inputBefore) {
            uint256 refund = inputAfter - inputBefore;
            uint256 treasuryBeforeRefund = tokenIn.balanceOf(treasury);
            tokenIn.safeTransfer(treasury, refund);
            if (tokenIn.balanceOf(treasury) != treasuryBeforeRefund + refund) revert InexactInput();
        }
        if (outputAfter > outputBefore) {
            uint256 proceeds = outputAfter - outputBefore;
            uint256 recipientBeforeForward = tokenOut.balanceOf(intent.recipient);
            tokenOut.safeTransfer(intent.recipient, proceeds);
            if (tokenOut.balanceOf(intent.recipient) != recipientBeforeForward + proceeds) revert InexactOutput();
        }
        if (tokenIn.balanceOf(address(this)) != inputBefore || tokenOut.balanceOf(address(this)) != outputBefore) {
            revert InexactOutput();
        }
        uint256 recipientAfter = tokenOut.balanceOf(intent.recipient);
        if (recipientAfter < recipientBefore) revert BelowFloor(0, intent.minOut);
        uint256 received = recipientAfter - recipientBefore;
        if (received < intent.minOut) revert BelowFloor(received, intent.minOut);

        emit Permit2Executed(
            treasury,
            intent.operationId,
            intent.memoId,
            intent.documentCommitment,
            intent.target,
            intent.tokenIn,
            intent.amountIn,
            intent.tokenOut,
            intent.recipient,
            received,
            permit.nonce,
            intentHash,
            intent.memo
        );
    }

    function _isAllowedRecipient(address treasury, address recipient) private view returns (bool) {
        address[] memory recipients = addressBook.getAllowedRecipients(treasury);
        for (uint256 i; i < recipients.length; i++) {
            if (recipients[i] == recipient) return true;
        }
        return false;
    }
}
