// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.24;

import {TreasuryConduit} from "../src/bufi/conduit/TreasuryConduit.sol";
import {TreasurySwapAndDeposit} from "../src/bufi/conduit/TreasurySwapAndDeposit.sol";
import {BufiDeployBase} from "./config/BufiDeployBase.sol";
import {BufiDeployConfig} from "./config/BufiDeployConfig.sol";
import {BufiInitCodes} from "./config/BufiInitCodes.sol";

import {console2} from "forge-std/src/Script.sol";

/// @notice TreasurySwapAndDeposit (bootstrap owner -> chain Safe), its venues (App Kit, LI.FI) and dests (the
/// chain's Earn vaults, plus the canary on testnet), registered as a TreasuryConduit target. USDC is an
/// immutable constructor arg, so this address differs per chain by construction.
/// Run `DeployTreasuryConduit` (and on testnet `DeployTreasuryEarn`) first.
///
///   forge script script/DeployTreasurySwapAndDeposit.s.sol --fork-url $RPC --sender $BOOTSTRAP
contract DeployTreasurySwapAndDeposit is BufiDeployBase {
    function run() external returns (address adapter) {
        BufiDeployConfig.Chain memory c = _chain();
        address conduit = BufiInitCodes.conduitAddress();
        require(conduit.code.length != 0, "TreasuryConduit not deployed on this chain: run DeployTreasuryConduit");
        address canary;
        if (c.canaryVault) {
            canary = BufiInitCodes.canaryVaultAddress(c.usdc);
            require(canary.code.length != 0, "canary vault not deployed: run DeployTreasuryEarn");
        }

        vm.startBroadcast(BufiDeployConfig.BOOTSTRAP_OWNER);
        adapter = _create2(
            "TreasurySwapAndDeposit", BufiDeployConfig.SWAP_DEPOSIT_SALT, BufiInitCodes.swapAndDeposit(c.usdc)
        );
        _venue(adapter, c.safe, c.appKit);
        _venue(adapter, c.safe, c.lifi);
        _venue(adapter, c.safe, c.uniswap);
        _dest(adapter, c.safe, canary);
        for (uint256 i = 0; i < c.earnVaults.length; i++) {
            _dest(adapter, c.safe, c.earnVaults[i]);
        }
        if (!TreasuryConduit(conduit).targets(adapter)) {
            _ownerCall(conduit, c.safe, abi.encodeCall(TreasuryConduit.setTarget, (adapter, true)), "conduit.setTarget");
        }
        _handover("TreasurySwapAndDeposit", adapter, c.safe);
        vm.stopBroadcast();

        console2.log("conduit", conduit);
    }

    function _venue(address adapter, address safe, address venue) internal {
        if (venue == address(0) || TreasurySwapAndDeposit(adapter).venues(venue)) return;
        _ownerCall(adapter, safe, abi.encodeCall(TreasurySwapAndDeposit.setVenue, (venue, true)), "adapter.setVenue");
        console2.log("  venue", venue);
    }

    function _dest(address adapter, address safe, address dest) internal {
        if (dest == address(0) || TreasurySwapAndDeposit(adapter).dests(dest)) return;
        _ownerCall(adapter, safe, abi.encodeCall(TreasurySwapAndDeposit.setDest, (dest, true)), "adapter.setDest");
        console2.log("  dest", dest);
    }
}
