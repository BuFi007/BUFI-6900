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

import {IGatewayExecutionModule} from "./interfaces/IGatewayExecutionModule.sol";
import {IGatewayWallet} from "./interfaces/IGatewayWallet.sol";
import {IERC6900Module} from "@erc6900/reference-implementation-v0.8.1/interfaces/IERC6900Module.sol";
import {
    ExecutionManifest,
    ManifestExecutionFunction,
    IERC6900ExecutionModule
} from "@erc6900/reference-implementation-v0.8.1/interfaces/IERC6900ExecutionModule.sol";
import {IERC165} from "@openzeppelin/contracts/interfaces/IERC165.sol";
import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title GatewayExecutionModule
 * @notice ERC-6900 execution module enabling MSCA Treasury wallets to use Circle Gateway
 * @dev Manages the delegate lifecycle for cross-chain USDC transfers.
 *
 * ARCHITECTURE:
 * Gateway validates burn intent signatures OFF-CHAIN first (API) using ECDSA recovery.
 * ERC-1271 is NOT supported for burn intents (only for deposits per ChainSecurity audit).
 * This module manages the delegate lifecycle for cross-chain transfers.
 *
 * SECURITY MODEL:
 * - All execution functions require MSCA validation (multi-sig approval)
 * - Delegates are TOKEN-SCOPED (can only sign for specific tokens)
 * - Revocation does NOT invalidate pre-signed intents (per Gateway audit)
 * - Keep delegate authorization windows short
 *
 * DEPLOYMENT:
 * - Gateway addresses are injected at deployment time (constructor)
 * - Supports both testnet and mainnet deployments
 * - Testnet Gateway Wallet: 0x0077777d7EBA4688BDeF3E311b846F25870A19B9
 * - Mainnet Gateway Wallet: 0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE
 *
 * MODULE PATTERN:
 * Follows Circle's buidl-wallet-contracts module architecture:
 * - Extends ERC165 for interface detection
 * - Implements IModule lifecycle (onInstall, onUninstall, moduleId)
 * - Implements IExecutionModule (executionManifest)
 * - Uses associated storage pattern for 4337 compliance
 */
contract GatewayExecutionModule is IGatewayExecutionModule, ERC165 {
    using SafeERC20 for IERC20;

    // =========================================================================
    // Constants
    // =========================================================================

    /// @notice Module identifier following Circle's naming convention
    string public constant MODULE_ID = "desk.gateway-execution-module.1.0.0";

    // =========================================================================
    // Immutable State
    // =========================================================================

    /// @notice Gateway Wallet contract address (environment-specific)
    IGatewayWallet private immutable _gatewayWallet;

    // =========================================================================
    // Constructor
    // =========================================================================

    /**
     * @notice Deploy the module with environment-specific Gateway address
     * @param gatewayWalletAddress The Gateway Wallet contract address
     * @dev Use testnet address for testnet deployments, mainnet for production
     *      Testnet: 0x0077777d7EBA4688BDeF3E311b846F25870A19B9
     *      Mainnet: 0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE
     */
    constructor(address gatewayWalletAddress) {
        require(gatewayWalletAddress != address(0), "Invalid gateway wallet");
        _gatewayWallet = IGatewayWallet(gatewayWalletAddress);
    }

    // =========================================================================
    // IModule Implementation
    // =========================================================================

    /**
     * @inheritdoc IERC6900Module
     * @dev Called when the module is installed on an MSCA
     *      No initialization required - Gateway state is external
     */
    function onInstall(bytes calldata) external override {
        // No initialization needed
        // Gateway Wallet tracks delegation state externally
        // Each MSCA can start using the module immediately
    }

    /**
     * @inheritdoc IERC6900Module
     * @dev Called when the module is uninstalled from an MSCA
     *      WARNING: Does not automatically revoke delegates!
     *      MSCA should call revokeDelegate before uninstalling if needed
     */
    function onUninstall(bytes calldata) external override {
        // No cleanup required
        // WARNING: Delegates remain authorized in Gateway Wallet
        // The MSCA owner should revoke delegates before uninstalling
    }

    /**
     * @inheritdoc IERC6900Module
     * @return Module identifier in "vendor.module.semver" format
     */
    function moduleId() external pure override returns (string memory) {
        return MODULE_ID;
    }

    // =========================================================================
    // IExecutionModule Implementation
    // =========================================================================

    /**
     * @inheritdoc IERC6900ExecutionModule
     * @dev Returns the execution manifest declaring this module's functions
     */
    function executionManifest() external pure override returns (ExecutionManifest memory manifest) {
        // Declare the execution functions this module provides
        manifest.executionFunctions = new ManifestExecutionFunction[](5);

        // authorizeDelegate - requires validation (multi-sig), no global validation
        manifest.executionFunctions[0] = ManifestExecutionFunction({
            executionSelector: this.authorizeDelegate.selector,
            skipRuntimeValidation: false,
            allowGlobalValidation: false
        });

        // revokeDelegate - requires validation (multi-sig), allow global validation
        manifest.executionFunctions[1] = ManifestExecutionFunction({
            executionSelector: this.revokeDelegate.selector,
            skipRuntimeValidation: false,
            allowGlobalValidation: true
        });

        // depositToGateway - requires validation (multi-sig), no global validation
        manifest.executionFunctions[2] = ManifestExecutionFunction({
            executionSelector: this.depositToGateway.selector,
            skipRuntimeValidation: false,
            allowGlobalValidation: false
        });

        // initiateWithdrawal - requires validation (multi-sig), no global validation
        manifest.executionFunctions[3] = ManifestExecutionFunction({
            executionSelector: this.initiateWithdrawal.selector,
            skipRuntimeValidation: false,
            allowGlobalValidation: false
        });

        // completeWithdrawal - requires validation (multi-sig), allow global validation
        manifest.executionFunctions[4] = ManifestExecutionFunction({
            executionSelector: this.completeWithdrawal.selector,
            skipRuntimeValidation: false,
            allowGlobalValidation: true
        });

        // Declare supported interfaces
        manifest.interfaceIds = new bytes4[](1);
        manifest.interfaceIds[0] = type(IGatewayExecutionModule).interfaceId;

        return manifest;
    }

    // =========================================================================
    // Execution Functions
    // =========================================================================

    /**
     * @inheritdoc IGatewayExecutionModule
     */
    function authorizeDelegate(address token, address delegate) external override {
        if (delegate == address(0)) revert InvalidDelegate();
        if (token == address(0)) revert InvalidToken();

        // Call Gateway Wallet to authorize the delegate
        // msg.sender is the MSCA (after validation)
        _gatewayWallet.addDelegate(token, delegate);

        emit DelegateAuthorized(msg.sender, token, delegate);
    }

    /**
     * @inheritdoc IGatewayExecutionModule
     */
    function revokeDelegate(address token, address delegate) external override {
        if (delegate == address(0)) revert InvalidDelegate();
        if (token == address(0)) revert InvalidToken();

        // Call Gateway Wallet to revoke the delegate
        _gatewayWallet.removeDelegate(token, delegate);

        emit DelegateRevoked(msg.sender, token, delegate);
    }

    /**
     * @inheritdoc IGatewayExecutionModule
     */
    function depositToGateway(address token, uint256 amount) external override {
        if (token == address(0)) revert InvalidToken();
        if (amount == 0) revert InvalidAmount();

        // Approve Gateway Wallet to spend tokens
        // The MSCA (msg.sender) holds the tokens
        IERC20(token).safeIncreaseAllowance(address(_gatewayWallet), amount);

        // Call Gateway Wallet to deposit
        _gatewayWallet.deposit(token, amount);

        emit DepositedToGateway(msg.sender, token, amount);
    }

    /**
     * @inheritdoc IGatewayExecutionModule
     */
    function initiateWithdrawal(address token, uint256 amount) external override {
        if (token == address(0)) revert InvalidToken();
        if (amount == 0) revert InvalidAmount();

        // Initiate withdrawal - starts the delay period
        _gatewayWallet.initiateWithdrawal(token, amount);

        emit WithdrawalInitiated(msg.sender, token, amount);
    }

    /**
     * @inheritdoc IGatewayExecutionModule
     */
    function completeWithdrawal(address token) external override {
        if (token == address(0)) revert InvalidToken();

        // Get balance before withdrawal to emit accurate event
        uint256 withdrawable = _gatewayWallet.withdrawableBalance(token, msg.sender);

        // Complete the withdrawal
        _gatewayWallet.withdraw(token);

        emit WithdrawalCompleted(msg.sender, token, withdrawable);
    }

    // =========================================================================
    // View Functions
    // =========================================================================

    /**
     * @inheritdoc IGatewayExecutionModule
     */
    function isDelegateAuthorized(
        address token,
        address account,
        address delegate
    ) external view override returns (bool) {
        return _gatewayWallet.isAuthorizedForBalance(token, account, delegate);
    }

    /**
     * @inheritdoc IGatewayExecutionModule
     */
    function getAvailableBalance(address token, address account) external view override returns (uint256) {
        return _gatewayWallet.availableBalance(token, account);
    }

    /**
     * @inheritdoc IGatewayExecutionModule
     */
    function getTotalBalance(address token, address account) external view override returns (uint256) {
        return _gatewayWallet.totalBalance(token, account);
    }

    /**
     * @inheritdoc IGatewayExecutionModule
     */
    function gatewayWallet() external view override returns (address) {
        return address(_gatewayWallet);
    }

    // =========================================================================
    // ERC-165 Support
    // =========================================================================

    /**
     * @inheritdoc ERC165
     * @dev Advertises support for IModule, IExecutionModule, and IGatewayExecutionModule
     */
    function supportsInterface(bytes4 interfaceId) public view override(ERC165, IERC165) returns (bool) {
        return
            interfaceId == type(IERC6900Module).interfaceId ||
            interfaceId == type(IGatewayExecutionModule).interfaceId ||
            super.supportsInterface(interfaceId);
    }
}
