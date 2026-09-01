// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {GatewayBalanceType} from "../../src/bufi/v0.8/gateway/GatewayEnums.sol";
import {IGatewayWallet} from "../../src/bufi/v0.8/gateway/interfaces/IGatewayWallet.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title MockGatewayWallet
/// @notice Local stand-in for Circle's GatewayWallet, implementing the `IGatewayWallet` surface that
///         `GatewayExecutionModule` and `GatewayHelper` touch, so their behaviour can be pinned without a
///         Sepolia fork. Every balance and every delegation is keyed by `msg.sender` — the single property the
///         fork suites established (`GatewayHelper.t.sol::test_DirectExecution_PreservesMsgSender`) and the
///         reason the helper exists at all.
///
/// @dev What is faithful to the fork-verified ABI/behaviour, and what is modelled:
///      - VERIFIED ON SEPOLIA (test/fork/gateway): `addDelegate(address,address)` / `removeDelegate` exist and
///        toggle `isAuthorizedForBalance(token, depositor, addr)` for `depositor == msg.sender`; a random address
///        is not authorized; `deposit(address,uint256)`, `totalBalance`, `availableBalance`, `withdrawalDelay`
///        exist with these signatures.
///      - MODELLED from Circle's published Gateway semantics, never exercised by the fork suites (no testnet
///        USDC was available): deposits pull from `msg.sender` and credit `msg.sender` (`depositFor` credits the
///        named depositor); a depositor is always authorized for its own balance; `initiateWithdrawal` moves
///        funds from available to withdrawing and (re)starts the delay clock; `withdraw` pays `msg.sender` once
///        `withdrawalDelay` BLOCKS have elapsed (the BUFI interface comment says "seconds", but the paired
///        `withdrawalBlock()` getter returns a block number — the mock follows the getter); only supported
///        tokens are accepted.
///      - NOT MODELLED: permit / EIP-3009 deposit variants revert `NotSupportedByMock`. Burn intents and the
///        Minter are off-chain / destination-chain concerns the module never touches.
contract MockGatewayWallet is IGatewayWallet {
    using SafeERC20 for IERC20;

    error UnsupportedToken(address token);
    error InvalidDelegate(address delegate);
    error InsufficientAvailableBalance(uint256 requested, uint256 available);
    error NoWithdrawalPending(address token, address depositor);
    error WithdrawalDelayNotElapsed(uint256 withdrawalBlock, uint256 currentBlock);
    error LengthMismatch();
    error NotSupportedByMock();

    event DelegateAdded(address indexed token, address indexed depositor, address indexed delegate);
    event DelegateRemoved(address indexed token, address indexed depositor, address indexed delegate);
    event Deposited(address indexed token, address indexed depositor, uint256 value);
    event WithdrawalInitiated(address indexed token, address indexed depositor, uint256 value, uint256 withdrawalBlock);
    event WithdrawalCompleted(address indexed token, address indexed depositor, uint256 value);

    /// @dev Delay in BLOCKS between `initiateWithdrawal` and a completable `withdraw`.
    uint256 private immutable _withdrawalDelay;

    mapping(address token => bool) public supportedTokens;
    mapping(address token => mapping(address depositor => uint256)) private _available;
    mapping(address token => mapping(address depositor => uint256)) private _withdrawing;
    mapping(address token => mapping(address depositor => uint256)) private _withdrawalBlock;
    mapping(address token => mapping(address depositor => mapping(address delegate => bool))) private _delegates;

    constructor(uint256 withdrawalDelayBlocks) {
        _withdrawalDelay = withdrawalDelayBlocks;
    }

    /// @dev Sandbox admin: Circle's real contract has an owner-gated token allowlist; here anyone can set it.
    function setSupportedToken(address token, bool supported) external {
        supportedTokens[token] = supported;
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Deposits — attributed to msg.sender                                            ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    function deposit(address token, uint256 value) external override {
        _deposit(token, msg.sender, msg.sender, value);
    }

    function depositFor(address token, address depositor, uint256 value) external override {
        _deposit(token, msg.sender, depositor, value);
    }

    function depositWithPermit(address, address, uint256, uint256, uint8, bytes32, bytes32) external pure override {
        revert NotSupportedByMock();
    }

    function depositWithPermit(address, address, uint256, uint256, bytes calldata) external pure override {
        revert NotSupportedByMock();
    }

    function depositWithAuthorization(address, address, uint256, uint256, uint256, bytes32, uint8, bytes32, bytes32)
        external
        pure
        override
    {
        revert NotSupportedByMock();
    }

    function depositWithAuthorization(address, address, uint256, uint256, uint256, bytes32, bytes calldata)
        external
        pure
        override
    {
        revert NotSupportedByMock();
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Balances                                                                       ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    function totalBalance(address token, address depositor) public view override returns (uint256) {
        return _available[token][depositor] + _withdrawing[token][depositor];
    }

    function availableBalance(address token, address depositor) public view override returns (uint256) {
        return _available[token][depositor];
    }

    function withdrawingBalance(address token, address depositor) public view override returns (uint256) {
        return _withdrawing[token][depositor];
    }

    function withdrawableBalance(address token, address depositor) public view override returns (uint256) {
        uint256 pending = _withdrawing[token][depositor];
        if (pending == 0 || block.number < _withdrawalBlock[token][depositor]) return 0;
        return pending;
    }

    /// @dev id = uint256(bytes32(abi.encodePacked(uint96(balanceType), address(token)))).
    function balanceOf(address depositor, uint256 id) public view override returns (uint256 balance) {
        GatewayBalanceType kind = GatewayBalanceType(uint96(id >> 160));
        address token = address(uint160(id));
        if (kind == GatewayBalanceType.Total) return totalBalance(token, depositor);
        if (kind == GatewayBalanceType.Available) return availableBalance(token, depositor);
        if (kind == GatewayBalanceType.Withdrawing) return withdrawingBalance(token, depositor);
        return withdrawableBalance(token, depositor);
    }

    function balanceOfBatch(address[] calldata depositors, uint256[] calldata ids)
        external
        view
        override
        returns (uint256[] memory balances)
    {
        if (depositors.length != ids.length) revert LengthMismatch();
        balances = new uint256[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            balances[i] = balanceOf(depositors[i], ids[i]);
        }
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Delegates — token-scoped, keyed by msg.sender                                  ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    function addDelegate(address token, address delegate) external override {
        _requireSupported(token);
        if (delegate == address(0)) revert InvalidDelegate(delegate);
        _delegates[token][msg.sender][delegate] = true;
        emit DelegateAdded(token, msg.sender, delegate);
    }

    /// @dev Idempotent: revoking an address that was never a delegate is a no-op, like the real contract's
    ///      "revocation does not invalidate pre-signed intents" model — nothing to unwind on-chain.
    function removeDelegate(address token, address delegate) external override {
        _requireSupported(token);
        if (delegate == address(0)) revert InvalidDelegate(delegate);
        _delegates[token][msg.sender][delegate] = false;
        emit DelegateRemoved(token, msg.sender, delegate);
    }

    function isAuthorizedForBalance(address token, address depositor, address addr)
        external
        view
        override
        returns (bool)
    {
        return addr == depositor || _delegates[token][depositor][addr];
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Withdrawals — two-step, delayed by blocks                                      ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    function initiateWithdrawal(address token, uint256 value) external override {
        _requireSupported(token);
        uint256 available = _available[token][msg.sender];
        if (value == 0 || value > available) revert InsufficientAvailableBalance(value, available);
        _available[token][msg.sender] = available - value;
        _withdrawing[token][msg.sender] += value;
        uint256 readyAt = block.number + _withdrawalDelay;
        _withdrawalBlock[token][msg.sender] = readyAt;
        emit WithdrawalInitiated(token, msg.sender, value, readyAt);
    }

    function withdraw(address token) external override {
        _requireSupported(token);
        uint256 pending = _withdrawing[token][msg.sender];
        if (pending == 0) revert NoWithdrawalPending(token, msg.sender);
        uint256 readyAt = _withdrawalBlock[token][msg.sender];
        if (block.number < readyAt) revert WithdrawalDelayNotElapsed(readyAt, block.number);
        _withdrawing[token][msg.sender] = 0;
        _withdrawalBlock[token][msg.sender] = 0;
        IERC20(token).safeTransfer(msg.sender, pending);
        emit WithdrawalCompleted(token, msg.sender, pending);
    }

    function withdrawalDelay() external view override returns (uint256) {
        return _withdrawalDelay;
    }

    function withdrawalBlock(address token, address depositor) external view override returns (uint256) {
        return _withdrawalBlock[token][depositor];
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Internals                                                                      ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    function _deposit(address token, address from, address depositor, uint256 value) internal {
        _requireSupported(token);
        IERC20(token).safeTransferFrom(from, address(this), value);
        _available[token][depositor] += value;
        emit Deposited(token, depositor, value);
    }

    function _requireSupported(address token) internal view {
        if (!supportedTokens[token]) revert UnsupportedToken(token);
    }
}
