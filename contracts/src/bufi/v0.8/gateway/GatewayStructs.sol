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

/// @notice Delegate metadata for tracking authorized signers
/// @param delegate The delegate EOA address
/// @param token The token this delegate is authorized for
/// @param authorizedAt Block timestamp when delegate was authorized
struct DelegateMetadata {
    address delegate;
    address token;
    uint256 authorizedAt;
}

/// @notice Request to authorize a delegate for Gateway operations
/// @param token The token address (e.g., USDC) the delegate can sign for
/// @param delegate The EOA address that will sign burn intents
struct AuthorizeDelegateRequest {
    address token;
    address delegate;
}

/// @notice Request to deposit tokens to Gateway
/// @param token The token address to deposit
/// @param amount The amount to deposit
struct DepositRequest {
    address token;
    uint256 amount;
}

/// @notice Request to initiate withdrawal from Gateway
/// @param token The token address to withdraw
/// @param amount The amount to withdraw
struct WithdrawalRequest {
    address token;
    uint256 amount;
}
