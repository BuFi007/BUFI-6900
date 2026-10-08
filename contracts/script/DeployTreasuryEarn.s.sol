// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.24;

import {TreasuryConduit} from "../src/bufi/conduit/TreasuryConduit.sol";
import {TreasuryRedeemConduit} from "../src/bufi/conduit/TreasuryRedeemConduit.sol";
import {BufiDeployBase} from "./config/BufiDeployBase.sol";
import {BufiDeployConfig} from "./config/BufiDeployConfig.sol";
import {BufiInitCodes} from "./config/BufiInitCodes.sol";

import {console2} from "forge-std/src/Script.sol";

/// @notice Treasury Earn: the redeem conduit (bootstrap owner -> chain Safe) and, on testnet only, the 1:1
/// canary vault; every configured vault is registered on the redeem conduit and on the TreasuryConduit.
/// Run `DeployTreasuryConduit` first — the conduit address is derived from its init code, never passed in.
///
///   forge script script/DeployTreasuryEarn.s.sol --fork-url $RPC --sender $BOOTSTRAP
contract DeployTreasuryEarn is BufiDeployBase {
    function run() external returns (address redeem, address canary) {
        BufiDeployConfig.Chain memory c = _chain();
        address conduit = BufiInitCodes.conduitAddress();
        require(conduit.code.length != 0, "TreasuryConduit not deployed on this chain: run DeployTreasuryConduit");

        vm.startBroadcast(BufiDeployConfig.BOOTSTRAP_OWNER);
        redeem = _create2("TreasuryRedeemConduit", BufiDeployConfig.REDEEM_CONDUIT_SALT, BufiInitCodes.redeemConduit());
        if (c.canaryVault) {
            canary = _create2(
                "TreasuryEarnVault (canary)", BufiDeployConfig.EARN_CANARY_VAULT_SALT, BufiInitCodes.canaryVault(c.usdc)
            );
            _registerVault(conduit, redeem, c.safe, canary);
        }
        for (uint256 i = 0; i < c.earnVaults.length; i++) {
            _registerVault(conduit, redeem, c.safe, c.earnVaults[i]);
        }
        _handover("TreasuryRedeemConduit", redeem, c.safe);
        vm.stopBroadcast();

        console2.log("conduit", conduit);
    }

    function _registerVault(address conduit, address redeem, address safe, address vault) internal {
        if (!TreasuryRedeemConduit(redeem).vaults(vault)) {
            _ownerCall(redeem, safe, abi.encodeCall(TreasuryRedeemConduit.setVault, (vault, true)), "redeem.setVault");
        }
        if (!TreasuryConduit(conduit).targets(vault)) {
            _ownerCall(conduit, safe, abi.encodeCall(TreasuryConduit.setTarget, (vault, true)), "conduit.setTarget");
        }
        console2.log("  vault", vault);
    }
}
