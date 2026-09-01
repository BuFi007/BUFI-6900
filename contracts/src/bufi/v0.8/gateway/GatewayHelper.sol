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

import {IGatewayHelper} from "./interfaces/IGatewayHelper.sol";
import {IGatewayWallet} from "./interfaces/IGatewayWallet.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title GatewayHelper
 * @notice Helper contract for encoding Gateway calldata
 * @dev This contract does NOT execute calls. It encodes calldata for MSCAs to execute directly.
 *
 * ARCHITECTURE:
 * Gateway identifies depositors by msg.sender. ERC-6900 modules break this pattern
 * because they're called via external call, making msg.sender = module address.
 *
 * Solution: MSCA calls Gateway directly via execute(target, value, data).
 * This preserves msg.sender = MSCA, ensuring Gateway state is correctly keyed.
 *
 * USAGE:
 * ```solidity
 * // 1. Get encoded calldata
 * (address target, bytes memory data) = helper.encodeAuthorizeDelegate(token, delegate);
 *
 * // 2. MSCA executes (requires multi-sig approval)
 * msca.execute(target, 0, data);
 *
 * // 3. Gateway receives: msg.sender = MSCA (correct!)
 * ```
 *
 * DEPLOYMENT:
 * - Testnet Gateway Wallet: 0x0077777d7EBA4688BDeF3E311b846F25870A19B9
 * - Mainnet Gateway Wallet: 0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE
 */
contract GatewayHelper is IGatewayHelper {
    // =========================================================================
    // Immutable State
    // =========================================================================

    /// @notice Gateway Wallet contract address
    IGatewayWallet private immutable _gatewayWallet;

    // =========================================================================
    // Constructor
    // =========================================================================

    /**
     * @notice Deploy the helper with environment-specific Gateway address
     * @param gatewayWalletAddress The Gateway Wallet contract address
     */
    constructor(address gatewayWalletAddress) {
        require(gatewayWalletAddress != address(0), "Invalid gateway wallet");
        _gatewayWallet = IGatewayWallet(gatewayWalletAddress);
    }

    // =========================================================================
    // Calldata Encoders
    // =========================================================================

    /**
     * @inheritdoc IGatewayHelper
     */
    function encodeAuthorizeDelegate(
        address token,
        address delegate
    ) external view override returns (address target, bytes memory data) {
        if (delegate == address(0)) revert InvalidDelegate();
        if (token == address(0)) revert InvalidToken();

        return (
            address(_gatewayWallet),
            abi.encodeCall(IGatewayWallet.addDelegate, (token, delegate))
        );
    }

    /**
     * @inheritdoc IGatewayHelper
     */
    function encodeRevokeDelegate(
        address token,
        address delegate
    ) external view override returns (address target, bytes memory data) {
        if (delegate == address(0)) revert InvalidDelegate();
        if (token == address(0)) revert InvalidToken();

        return (
            address(_gatewayWallet),
            abi.encodeCall(IGatewayWallet.removeDelegate, (token, delegate))
        );
    }

    /**
     * @inheritdoc IGatewayHelper
     */
    function encodeDeposit(
        address token,
        uint256 amount
    ) external view override returns (address target, bytes memory data) {
        if (token == address(0)) revert InvalidToken();
        if (amount == 0) revert InvalidAmount();

        return (
            address(_gatewayWallet),
            abi.encodeCall(IGatewayWallet.deposit, (token, amount))
        );
    }

    /**
     * @inheritdoc IGatewayHelper
     */
    function encodeInitiateWithdrawal(
        address token,
        uint256 amount
    ) external view override returns (address target, bytes memory data) {
        if (token == address(0)) revert InvalidToken();
        if (amount == 0) revert InvalidAmount();

        return (
            address(_gatewayWallet),
            abi.encodeCall(IGatewayWallet.initiateWithdrawal, (token, amount))
        );
    }

    /**
     * @inheritdoc IGatewayHelper
     */
    function encodeCompleteWithdrawal(
        address token
    ) external view override returns (address target, bytes memory data) {
        if (token == address(0)) revert InvalidToken();

        return (
            address(_gatewayWallet),
            abi.encodeCall(IGatewayWallet.withdraw, (token))
        );
    }

    /**
     * @inheritdoc IGatewayHelper
     */
    function encodeApproveGateway(
        address token,
        uint256 amount
    ) external view override returns (address target, bytes memory data) {
        if (token == address(0)) revert InvalidToken();
        if (amount == 0) revert InvalidAmount();

        return (
            token,
            abi.encodeCall(IERC20.approve, (address(_gatewayWallet), amount))
        );
    }

    // =========================================================================
    // View Functions
    // =========================================================================

    /**
     * @inheritdoc IGatewayHelper
     */
    function isDelegateAuthorized(
        address token,
        address depositor,
        address delegate
    ) external view override returns (bool) {
        return _gatewayWallet.isAuthorizedForBalance(token, depositor, delegate);
    }

    /**
     * @inheritdoc IGatewayHelper
     */
    function getAvailableBalance(
        address token,
        address depositor
    ) external view override returns (uint256) {
        return _gatewayWallet.availableBalance(token, depositor);
    }

    /**
     * @inheritdoc IGatewayHelper
     */
    function getTotalBalance(
        address token,
        address depositor
    ) external view override returns (uint256) {
        return _gatewayWallet.totalBalance(token, depositor);
    }

    /**
     * @inheritdoc IGatewayHelper
     */
    function getWithdrawableBalance(
        address token,
        address depositor
    ) external view override returns (uint256) {
        return _gatewayWallet.withdrawableBalance(token, depositor);
    }

    /**
     * @inheritdoc IGatewayHelper
     */
    function getWithdrawalDelay() external view override returns (uint256) {
        return _gatewayWallet.withdrawalDelay();
    }

    /**
     * @inheritdoc IGatewayHelper
     */
    function gatewayWallet() external view override returns (address) {
        return address(_gatewayWallet);
    }
}
