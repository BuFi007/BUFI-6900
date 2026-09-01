/*
 * Copyright 2025 Desk. All rights reserved.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <http://www.gnu.org/licenses/>.
 */
pragma solidity 0.8.24;

import {IERC6900ExecutionModule} from "@erc6900/reference-implementation-v0.8.1/interfaces/IERC6900ExecutionModule.sol";

/**
 * @title IGatewayExecutionModule
 * @notice Interface for the Gateway Execution Module
 * @dev Enables MSCA Treasury wallets to interact with Circle Gateway
 *      for unified cross-chain USDC balance management.
 *
 * ARCHITECTURE:
 * Gateway validates burn intent signatures OFF-CHAIN first (API) using ECDSA recovery.
 * ERC-1271 is NOT supported for burn intents (only for deposits).
 * This module manages the delegate lifecycle for cross-chain transfers.
 *
 * FLOW:
 * 1. Multi-sig approves authorizeDelegate() via this module
 * 2. Off-chain orchestrator signs burn intents with delegate's key
 * 3. Gateway API validates signature via ECDSA recovery
 * 4. gatewayMint() on destination chain
 * 5. Multi-sig approves revokeDelegate() after transfer
 */
interface IGatewayExecutionModule is IERC6900ExecutionModule {
    // =========================================================================
    // Events
    // =========================================================================

    /// @notice Emitted when a delegate is authorized for Gateway operations
    event DelegateAuthorized(
        address indexed account,
        address indexed token,
        address indexed delegate
    );

    /// @notice Emitted when a delegate's authorization is revoked
    event DelegateRevoked(
        address indexed account,
        address indexed token,
        address indexed delegate
    );

    /// @notice Emitted when tokens are deposited to Gateway
    event DepositedToGateway(
        address indexed account,
        address indexed token,
        uint256 amount
    );

    /// @notice Emitted when withdrawal is initiated
    event WithdrawalInitiated(
        address indexed account,
        address indexed token,
        uint256 amount
    );

    /// @notice Emitted when withdrawal is completed
    event WithdrawalCompleted(
        address indexed account,
        address indexed token,
        uint256 amount
    );

    // =========================================================================
    // Errors
    // =========================================================================

    /// @notice Thrown when delegate address is zero
    error InvalidDelegate();

    /// @notice Thrown when token address is zero
    error InvalidToken();

    /// @notice Thrown when amount is zero
    error InvalidAmount();

    /// @notice Thrown when delegate is already authorized
    error DelegateAlreadyAuthorized(address token, address delegate);

    /// @notice Thrown when delegate is not authorized
    error DelegateNotAuthorized(address token, address delegate);

    // =========================================================================
    // Execution Functions
    // =========================================================================

    /**
     * @notice Authorize a delegate to sign burn intents for a specific token
     * @param token The token address (e.g., USDC)
     * @param delegate The EOA address that will sign burn intents
     * @dev This function is called through the MSCA, requiring multi-sig approval.
     *      Delegates are TOKEN-SCOPED. Authorization for USDC does not
     *      grant authorization for other tokens.
     */
    function authorizeDelegate(address token, address delegate) external;

    /**
     * @notice Revoke a delegate's authorization for a specific token
     * @param token The token address
     * @param delegate The delegate address to revoke
     * @dev This function is called through the MSCA, requiring multi-sig approval.
     *      WARNING: Revocation does NOT invalidate burn intents signed before revocation.
     *      This is by design to prevent front-running attacks.
     */
    function revokeDelegate(address token, address delegate) external;

    /**
     * @notice Deposit tokens into Gateway for unified balance management
     * @param token The token address (e.g., USDC)
     * @param amount The amount to deposit
     * @dev The MSCA must have approved Gateway to spend the tokens first.
     */
    function depositToGateway(address token, uint256 amount) external;

    /**
     * @notice Initiate a trustless withdrawal from Gateway
     * @param token The token address
     * @param amount The amount to withdraw
     * @dev Starts the withdrawal delay period (typically 7 days).
     *      After delay, call completeWithdrawal().
     */
    function initiateWithdrawal(address token, uint256 amount) external;

    /**
     * @notice Complete a withdrawal after the delay period
     * @param token The token address
     * @dev Must have previously called initiateWithdrawal and waited for delay.
     */
    function completeWithdrawal(address token) external;

    // =========================================================================
    // View Functions
    // =========================================================================

    /**
     * @notice Check if an address is currently authorized as a delegate
     * @param token The token address
     * @param account The MSCA (depositor) address
     * @param delegate The potential delegate address
     * @return True if the delegate is authorized
     */
    function isDelegateAuthorized(
        address token,
        address account,
        address delegate
    ) external view returns (bool);

    /**
     * @notice Get the MSCA's available Gateway balance for a token
     * @param token The token address
     * @param account The MSCA address
     * @return The available balance in Gateway
     */
    function getAvailableBalance(address token, address account) external view returns (uint256);

    /**
     * @notice Get the MSCA's total Gateway balance for a token
     * @param token The token address
     * @param account The MSCA address
     * @return The total balance in Gateway
     */
    function getTotalBalance(address token, address account) external view returns (uint256);

    /**
     * @notice Get the Gateway Wallet contract address
     * @return The Gateway Wallet address
     */
    function gatewayWallet() external view returns (address);
}
