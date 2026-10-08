// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IFiatTokenV2} from "./interfaces/IFiatTokenV2.sol";

/**
 * @title TreasuryConduit
 * @notice One transaction that moves a treasury MSCA's stablecoins through a
 * protocol call (a swap, an ERC-4626 deposit, an Aave supply…) and hands every
 * resulting balance back to that treasury — with nothing held by anyone in
 * between, and a full revert if any step fails. Plan 353.
 *
 * ## Why a contract, not a wallet
 *
 * BUFI treasuries are Circle ERC-6900 accounts with the ColdStorageAddressBook
 * plugin installed. Its userOp validation hook accepts only ERC-20/721/1155
 * transfer and approve selectors, so the treasury itself can never call a
 * router or a pool (`UnauthorizedRecipient(account, address(0))` at the
 * bundler, verified 2026-09-05 and 2026-09-14). Until 2026-09-14 the way round
 * was a BUFI-controlled Circle wallet redeeming the quorum's ERC-3009
 * authorization, swapping, and sending the proceeds back over six relay legs —
 * which stranded funds twice in one afternoon.
 *
 * Circle's FiatToken pays an ERC-3009 `receiveWithAuthorization` to
 * `msg.sender`, and validates ERC-1271 signers. So THIS contract is the payee:
 * the token moves the funds on the quorum's signature, no userOp is involved,
 * the AddressBook never runs, and nothing needs to be installed on the account.
 *
 * ## What the quorum signs
 *
 * The plain ERC-3009 authorization binds `from`, `to`, `value` and a window,
 * nothing about what happens to the money. The intent is therefore hashed INTO
 * the authorization nonce: `nonce == keccak256(abi.encode(INTENT_TYPEHASH, …))`.
 * The signers see the intent (target, calldata, floor, deadline) in their
 * approval sheet; the token enforces that the same nonce is what they signed;
 * this contract enforces that the nonce is that intent. Change one byte of the
 * calldata and the authorization no longer redeems.
 *
 * ## Invariants
 *
 *  1. Funds leave the treasury only under its own quorum-signed authorization
 *     whose nonce commits to the whole intent.
 *  2. This contract holds nothing between transactions: after the call, every
 *     balance of `tokenIn` and `tokenOut` it has is swept to `auth.from`.
 *  3. The beneficiary of every outcome is `auth.from`: proceeds are delivered
 *     to it, positions open in its name, and the floor is measured on ITS
 *     balance of `tokenOut`.
 *  4. `execute` is permissionless. The agent DCW pays gas today; anyone may.
 *  5. Targets come from a registry the BUFI ops multisig maintains — defence
 *     in depth on top of the quorum's binding signature, never instead of it.
 *
 * A failed step reverts the transaction, which un-does the token pull: the
 * nonce stays unused and the treasury balance is exactly what it was.
 */
contract TreasuryConduit is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @dev The ERC-3009 authorization the quorum signed, minus the signature.
    struct Authorization {
        address token;
        address from;
        uint256 value;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce;
    }

    /// @dev What the money does. Hashed into `Authorization.nonce`.
    struct Intent {
        /// The protocol contract to call. Must be registered.
        address target;
        /// The exact calldata the quorum reviewed.
        bytes data;
        /// The stablecoin being spent. Must equal `auth.token`.
        address tokenIn;
        /// How much of it. Must equal `auth.value`.
        uint256 amountIn;
        /// The token whose balance at `beneficiary` must rise (EURC, vault shares, aToken…).
        address tokenOut;
        /// By at least this much, in `tokenOut` atomic units.
        uint256 minOut;
        /// Who ends up with everything. Must equal `auth.from`.
        address beneficiary;
        /// Unix time after which the intent is void even if the authorization window is open.
        uint256 deadline;
        /**
         * A 32-byte reference the workspace can find this movement by later —
         * an invoice id, a payroll run, the approval's own hash. Indexed on
         * `Executed`, so `eth_getLogs` finds it without the transaction hash.
         *
         * Arc ships a `Memo` contract that does this for plain transfers, but
         * it is EOA-ONLY: it preserves the signing EOA as `msg.sender` through
         * the `CallFrom` precompile and REVERTS for smart-contract callers,
         * ERC-4337 accounts and Circle SCAs alike
         * (docs.arc.io/arc/concepts/transaction-memos, read 2026-09-14). Every
         * account in this rail is a contract — the treasury MSCA, the agent
         * wallet, this conduit — so Arc's Memo can never wrap it. Carrying the
         * memo here instead also makes it part of what the quorum SIGNED,
         * because the intent is hashed into the authorisation nonce: the memo
         * on chain is provably the memo that was approved, and it works the
         * same on Avalanche, Arbitrum and Base, which have no Memo contract.
         */
        bytes32 memoId;
        /**
         * Free-form memo bytes (UTF-8 text, or an encoded struct). Emitted verbatim.
         */
        bytes memo;
    }

    bytes32 public constant INTENT_TYPEHASH = keccak256(
        "Intent(address target,bytes data,address tokenIn,uint256 amountIn,address tokenOut,uint256 minOut,address beneficiary,uint256 deadline,bytes32 memoId,bytes memo)"
    );

    /// @notice Protocol contracts an intent may call on this chain.
    mapping(address target => bool allowed) public targets;

    event TargetSet(address indexed target, bool allowed);
    event Rescued(address indexed token, address indexed to, uint256 amount);
    event Executed(
        address indexed treasury,
        bytes32 indexed memoId,
        address indexed target,
        bytes32 nonce,
        address tokenIn,
        uint256 amountIn,
        address tokenOut,
        uint256 gained,
        bytes memo
    );

    error BeneficiaryMismatch(address beneficiary, address from);
    error TokenMismatch(address tokenIn, address token);
    error AmountMismatch(uint256 amountIn, uint256 value);
    error NonceIsNotTheIntent(bytes32 nonce, bytes32 expected);
    error IntentExpired(uint256 deadline, uint256 now_);
    error TargetNotRegistered(address target);
    error TargetCallFailed(bytes reason);
    error BelowFloor(uint256 gained, uint256 minOut);
    error NothingToSweep();
    error ZeroAddress();

    constructor(address initialOwner) Ownable(initialOwner) {}

    // ── governance
    // ──────────────────────────────────────────────────────────

    /// @notice Register or retire a protocol target. Owner is the BUFI ops multisig.
    function setTarget(address target, bool allowed) external onlyOwner {
        if (target == address(0)) revert ZeroAddress();
        targets[target] = allowed;
        emit TargetSet(target, allowed);
    }

    // ── the one entry point
    // ─────────────────────────────────────────────────

    /// @notice The nonce a given intent must be signed under.
    function intentNonce(Intent calldata intent) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                INTENT_TYPEHASH,
                intent.target,
                keccak256(intent.data),
                intent.tokenIn,
                intent.amountIn,
                intent.tokenOut,
                intent.minOut,
                intent.beneficiary,
                intent.deadline,
                intent.memoId,
                keccak256(intent.memo)
            )
        );
    }

    /**
     * @notice Pull `auth.value` of `auth.token` from the treasury on its quorum's
     * signature, run `intent`, and return everything to the treasury.
     * @dev Anyone may call. Reverts as a whole on any failure; a revert leaves
     * the authorization nonce unused, so the same signature can be retried once
     * the world changes (a better quote, a target registered).
     */
    function execute(Authorization calldata auth, bytes calldata quorumSignature, Intent calldata intent)
        external
        nonReentrant
    {
        if (intent.beneficiary != auth.from) revert BeneficiaryMismatch(intent.beneficiary, auth.from);
        if (intent.tokenIn != auth.token) revert TokenMismatch(intent.tokenIn, auth.token);
        if (intent.amountIn != auth.value) revert AmountMismatch(intent.amountIn, auth.value);
        bytes32 expected = intentNonce(intent);
        if (auth.nonce != expected) revert NonceIsNotTheIntent(auth.nonce, expected);
        if (block.timestamp > intent.deadline) revert IntentExpired(intent.deadline, block.timestamp);
        if (!targets[intent.target]) revert TargetNotRegistered(intent.target);

        IERC20 tokenOut = IERC20(intent.tokenOut);
        uint256 before = tokenOut.balanceOf(auth.from);

        // 1. The token moves the funds on the treasury's own signature. `to` is
        //    this contract, which FiatToken requires to be msg.sender.
        IFiatTokenV2(auth.token)
            .receiveWithAuthorization(
                auth.from, address(this), auth.value, auth.validAfter, auth.validBefore, auth.nonce, quorumSignature
            );

        // 2. Exactly the redeemed amount, never MAX_UINT, and cleared afterwards.
        IERC20 tokenIn = IERC20(intent.tokenIn);
        tokenIn.forceApprove(intent.target, intent.amountIn);
        (bool ok, bytes memory ret) = intent.target.call(intent.data);
        if (!ok) revert TargetCallFailed(ret);
        tokenIn.forceApprove(intent.target, 0);

        // 3. Whatever this contract holds now belongs to the treasury — the
        //    proceeds (a swap delivered here), the input (a partial fill), both.
        _sweep(tokenIn, auth.from);
        if (address(tokenOut) != address(tokenIn)) _sweep(tokenOut, auth.from);

        // 4. The reviewed floor, measured where it matters: on the treasury.
        uint256 gained = tokenOut.balanceOf(auth.from) - before;
        if (gained < intent.minOut) revert BelowFloor(gained, intent.minOut);

        emit Executed(
            auth.from,
            intent.memoId,
            intent.target,
            auth.nonce,
            intent.tokenIn,
            intent.amountIn,
            intent.tokenOut,
            gained,
            intent.memo
        );
    }

    /// @notice Return any token this contract holds to a treasury. Never needed
    /// when `execute` runs to completion; exists so a token that arrived here by
    /// mistake (a direct transfer) can go back to its sender without governance.
    /// The owner names the recipient; it cannot name itself as the beneficiary
    /// of someone else's mistake beyond what the event trail shows.
    function rescue(address token, address to) external onlyOwner {
        if (token == address(0) || to == address(0)) revert ZeroAddress();
        uint256 amount = IERC20(token).balanceOf(address(this));
        if (amount == 0) revert NothingToSweep();
        IERC20(token).safeTransfer(to, amount);
        emit Rescued(token, to, amount);
    }

    function _sweep(IERC20 token, address to) private {
        uint256 amount = token.balanceOf(address(this));
        if (amount > 0) token.safeTransfer(to, amount);
    }
}
