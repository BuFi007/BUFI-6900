// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {ERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";

/**
 * @title TreasuryEarnVault
 * @notice 1:1 ERC-4626 wrapper used as the Arc-testnet canary target for the
 * treasury conduit Earn rail (plan 354). Not a yield product — deposits mint
 * shares to `receiver` and redemptions burn them 1:1 against the underlying.
 *
 * Production treasuries will point at a curated Morpho/Fluid vault once one
 * exists on a chain the conduit is deployed on. This contract exists so the
 * desk can round-trip deposit + withdraw against a real `asset()` without
 * waiting on that venue.
 */
contract TreasuryEarnVault is ERC4626 {
    constructor(IERC20 asset_) ERC20("BUFI Treasury USDC Vault", "buUSDC") ERC4626(asset_) {}
}
