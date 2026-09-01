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

/**
 * @title IGatewayHelper
 * @notice Interface for the Gateway Helper contract
 * @dev Provides calldata encoding for Gateway operations. Does NOT execute calls.
 *
 * ARCHITECTURE:
 * This helper encodes calldata that the MSCA executes directly via execute().
 * This preserves msg.sender = MSCA for Gateway interactions, which is critical
 * because Gateway stores state (deposits, delegations) keyed by msg.sender.
 *
 * WHY NOT AN ERC-6900 MODULE?
 * ERC-6900 modules are called via external call, making msg.sender = module address.
 * Gateway's addDelegate() stores: authorizedDelegates[token][msg.sender][delegate]
 * If module calls Gateway: delegation is for module address, not MSCA. Broken.
 * If MSCA calls Gateway directly: delegation is for MSCA address. Correct.
 *
 * USAGE:
 * 1. Call encodeX() to get (target, calldata)
 * 2. MSCA executes: msca.execute(target, 0, calldata)
 * 3. Gateway receives call with msg.sender = MSCA
 */
interface IGatewayHelper {
    // =========================================================================
    // Errors
    // =========================================================================

    /// @notice Thrown when delegate address is zero
    error InvalidDelegate();

    /// @notice Thrown when token address is zero
    error InvalidToken();

    /// @notice Thrown when amount is zero
    error InvalidAmount();

    // =========================================================================
    // Calldata Encoders
    // =========================================================================

    /**
     * @notice Encode calldata to authorize a delegate for a specific token
     * @param token The token address (e.g., USDC)
     * @param delegate The EOA address that will sign burn intents
     * @return target The Gateway Wallet address to call
     * @return data The encoded calldata for addDelegate(token, delegate)
     * @dev MSCA should execute: msca.execute(target, 0, data)
     */
    function encodeAuthorizeDelegate(
        address token,
        address delegate
    ) external view returns (address target, bytes memory data);

    /**
     * @notice Encode calldata to revoke a delegate's authorization
     * @param token The token address
     * @param delegate The delegate address to revoke
     * @return target The Gateway Wallet address to call
     * @return data The encoded calldata for removeDelegate(token, delegate)
     */
    function encodeRevokeDelegate(
        address token,
        address delegate
    ) external view returns (address target, bytes memory data);

    /**
     * @notice Encode calldata to deposit tokens into Gateway
     * @param token The token address (e.g., USDC)
     * @param amount The amount to deposit
     * @return target The Gateway Wallet address to call
     * @return data The encoded calldata for deposit(token, amount)
     * @dev MSCA must approve Gateway to spend tokens BEFORE executing this call
     */
    function encodeDeposit(
        address token,
        uint256 amount
    ) external view returns (address target, bytes memory data);

    /**
     * @notice Encode calldata to initiate a withdrawal from Gateway
     * @param token The token address
     * @param amount The amount to withdraw
     * @return target The Gateway Wallet address to call
     * @return data The encoded calldata for initiateWithdrawal(token, amount)
     * @dev Starts the withdrawal delay period (typically 7 days)
     */
    function encodeInitiateWithdrawal(
        address token,
        uint256 amount
    ) external view returns (address target, bytes memory data);

    /**
     * @notice Encode calldata to complete a withdrawal after delay
     * @param token The token address
     * @return target The Gateway Wallet address to call
     * @return data The encoded calldata for withdraw(token)
     */
    function encodeCompleteWithdrawal(
        address token
    ) external view returns (address target, bytes memory data);

    /**
     * @notice Encode calldata to approve Gateway to spend tokens
     * @param token The token address
     * @param amount The amount to approve
     * @return target The token address to call
     * @return data The encoded calldata for approve(gateway, amount)
     * @dev Call this BEFORE encodeDeposit. MSCA executes both in sequence.
     */
    function encodeApproveGateway(
        address token,
        uint256 amount
    ) external view returns (address target, bytes memory data);

    // =========================================================================
    // View Functions (No msg.sender dependency)
    // =========================================================================

    /**
     * @notice Check if an address is authorized as a delegate for a depositor
     * @param token The token address
     * @param depositor The depositor (MSCA) address
     * @param delegate The potential delegate address
     * @return True if the delegate is authorized for the depositor's balance
     */
    function isDelegateAuthorized(
        address token,
        address depositor,
        address delegate
    ) external view returns (bool);

    /**
     * @notice Get the available Gateway balance for a depositor
     * @param token The token address
     * @param depositor The depositor (MSCA) address
     * @return The available balance in Gateway
     */
    function getAvailableBalance(
        address token,
        address depositor
    ) external view returns (uint256);

    /**
     * @notice Get the total Gateway balance for a depositor
     * @param token The token address
     * @param depositor The depositor (MSCA) address
     * @return The total balance in Gateway
     */
    function getTotalBalance(
        address token,
        address depositor
    ) external view returns (uint256);

    /**
     * @notice Get the withdrawable balance for a depositor
     * @param token The token address
     * @param depositor The depositor (MSCA) address
     * @return The withdrawable balance (after delay period)
     */
    function getWithdrawableBalance(
        address token,
        address depositor
    ) external view returns (uint256);

    /**
     * @notice Get the Gateway withdrawal delay
     * @return The delay in seconds
     */
    function getWithdrawalDelay() external view returns (uint256);

    /**
     * @notice Get the Gateway Wallet contract address
     * @return The Gateway Wallet address
     */
    function gatewayWallet() external view returns (address);
}
