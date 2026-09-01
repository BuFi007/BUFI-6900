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
 * @title IGatewayWallet
 * @notice Interface for Circle Gateway Wallet contract
 * @dev Full ABI from https://developers.circle.com/gateway/references/contract-interfaces-and-events
 *
 * ARCHITECTURE NOTE:
 * Gateway validates burn intent signatures OFF-CHAIN first (API), then on-chain.
 * Because off-chain validation uses ECDSA recovery (not on-chain calls),
 * ERC-1271 is NOT supported for burn intents. ERC-1271 only works for deposits.
 *
 * SOLUTION: Delegate Pattern
 * - addDelegate(token, delegate) authorizes an EOA to sign burn intents
 * - The delegate signs EIP-712 burn intents off-chain
 * - Gateway API accepts the signature via ECDSA recovery
 * - removeDelegate(token, delegate) revokes authorization (but NOT pre-signed intents)
 */
interface IGatewayWallet {
    // =========================================================================
    // Deposit Functions
    // =========================================================================

    /**
     * @notice Deposit tokens into Gateway for unified balance management
     * @param token The token address (e.g., USDC)
     * @param value The amount to deposit
     * @dev Caller must have approved Gateway to spend tokens first
     */
    function deposit(address token, uint256 value) external;

    /**
     * @notice Deposit tokens into Gateway on behalf of another address
     * @param token The token address
     * @param depositor The address to credit the deposit to
     * @param value The amount to deposit
     */
    function depositFor(address token, address depositor, uint256 value) external;

    /**
     * @notice Deposit tokens using EIP-2612 permit (no separate approve needed)
     * @param token The token address
     * @param owner The token owner
     * @param value The amount to deposit
     * @param deadline Permit deadline
     * @param v Signature v
     * @param r Signature r
     * @param s Signature s
     */
    function depositWithPermit(
        address token,
        address owner,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    /**
     * @notice Deposit tokens using EIP-2612 permit with bytes signature
     * @param token The token address
     * @param owner The token owner
     * @param value The amount to deposit
     * @param deadline Permit deadline
     * @param signature The packed signature
     */
    function depositWithPermit(
        address token,
        address owner,
        uint256 value,
        uint256 deadline,
        bytes calldata signature
    ) external;

    /**
     * @notice Deposit tokens using EIP-3009 authorization
     * @param token The token address
     * @param from The token holder
     * @param value The amount to deposit
     * @param validAfter Authorization valid after timestamp
     * @param validBefore Authorization valid before timestamp
     * @param nonce Unique nonce
     * @param v Signature v
     * @param r Signature r
     * @param s Signature s
     */
    function depositWithAuthorization(
        address token,
        address from,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    /**
     * @notice Deposit tokens using EIP-3009 authorization with bytes signature
     * @param token The token address
     * @param from The token holder
     * @param value The amount to deposit
     * @param validAfter Authorization valid after timestamp
     * @param validBefore Authorization valid before timestamp
     * @param nonce Unique nonce
     * @param signature The packed signature
     */
    function depositWithAuthorization(
        address token,
        address from,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external;

    // =========================================================================
    // Balance Query Functions
    // =========================================================================

    /**
     * @notice Get total balance (available + withdrawing)
     * @param token The token address
     * @param depositor The depositor address
     * @return The total balance
     */
    function totalBalance(address token, address depositor) external view returns (uint256);

    /**
     * @notice Get available balance for transfers
     * @param token The token address
     * @param depositor The depositor address
     * @return The available balance
     */
    function availableBalance(address token, address depositor) external view returns (uint256);

    /**
     * @notice Get balance currently in withdrawal process
     * @param token The token address
     * @param depositor The depositor address
     * @return The withdrawing balance
     */
    function withdrawingBalance(address token, address depositor) external view returns (uint256);

    /**
     * @notice Get balance ready to be withdrawn (after delay)
     * @param token The token address
     * @param depositor The depositor address
     * @return The withdrawable balance
     */
    function withdrawableBalance(address token, address depositor) external view returns (uint256);

    /**
     * @notice ERC-1155 compatible balance query
     * @param depositor The depositor address
     * @param id Encoded token ID (balanceType + token address)
     * @return balance The balance for the given ID
     * @dev ID encoding: uint256(bytes32(abi.encodePacked(uint96(balanceType), address(token))))
     */
    function balanceOf(address depositor, uint256 id) external view returns (uint256 balance);

    /**
     * @notice Batch balance query
     * @param depositors Array of depositor addresses
     * @param ids Array of encoded token IDs
     * @return balances Array of balances
     */
    function balanceOfBatch(
        address[] calldata depositors,
        uint256[] calldata ids
    ) external view returns (uint256[] memory balances);

    // =========================================================================
    // Delegate Management (TOKEN-SCOPED)
    // =========================================================================

    /**
     * @notice Authorize a delegate to sign burn intents for a specific token
     * @param token The token address this delegation applies to
     * @param delegate The EOA address authorized to sign burn intents
     * @dev This is TOKEN-SCOPED - delegate can only sign for this specific token
     *      The delegate can sign EIP-712 burn intents which Gateway API validates
     *      via ECDSA recovery (not ERC-1271)
     */
    function addDelegate(address token, address delegate) external;

    /**
     * @notice Revoke a delegate's authorization for a specific token
     * @param token The token address to revoke delegation for
     * @param delegate The address to revoke
     * @dev WARNING: Revocation does NOT invalidate pre-signed burn intents!
     *      This is by design to prevent front-running attacks.
     *      Keep delegate authorization windows short.
     */
    function removeDelegate(address token, address delegate) external;

    /**
     * @notice Check if an address is authorized to transfer tokens
     * @param token The token address
     * @param depositor The depositor (MSCA) address
     * @param addr The potential delegate address (or depositor itself)
     * @return True if addr is authorized for this token/depositor pair
     */
    function isAuthorizedForBalance(
        address token,
        address depositor,
        address addr
    ) external view returns (bool);

    // =========================================================================
    // Withdrawal Functions (Trustless)
    // =========================================================================

    /**
     * @notice Initiate a withdrawal (starts the delay period)
     * @param token The token address
     * @param value The amount to withdraw
     * @dev After calling this, wait for withdrawalDelay() before calling withdraw()
     */
    function initiateWithdrawal(address token, uint256 value) external;

    /**
     * @notice Complete a withdrawal after the delay period
     * @param token The token address
     * @dev Must have previously called initiateWithdrawal and waited for delay
     */
    function withdraw(address token) external;

    /**
     * @notice Get the withdrawal delay period
     * @return The delay in seconds (typically 7 days)
     */
    function withdrawalDelay() external view returns (uint256);

    /**
     * @notice Get the block number when withdrawal becomes available
     * @param token The token address
     * @param depositor The depositor address
     * @return The block number (0 if no pending withdrawal)
     */
    function withdrawalBlock(address token, address depositor) external view returns (uint256);
}
