// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {ERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";

/// @notice Plain OpenZeppelin ERC-4626 vault: the Earn deposit target in tests.
contract MockVault4626 is ERC4626 {
    constructor(IERC20 asset_) ERC20("Mock USDC Vault", "mvUSDC") ERC4626(asset_) {}
}
