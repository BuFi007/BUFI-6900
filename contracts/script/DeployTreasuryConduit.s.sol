// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.24;

import {TreasuryConduit} from "../src/bufi/conduit/TreasuryConduit.sol";
import {BufiDeployBase} from "./config/BufiDeployBase.sol";
import {BufiDeployConfig} from "./config/BufiDeployConfig.sol";
import {BufiInitCodes} from "./config/BufiInitCodes.sol";

import {console2} from "forge-std/src/Script.sol";

/// @notice TreasuryConduit through the Arachnid CREATE2 proxy with the bootstrap deployer as the init-code
/// owner (same address on every chain), the chain's configured targets registered, then ownership proposed to
/// the chain's Safe (`BufiDeployConfig`). Unknown chain ids are refused. Salt: `CONDUIT_SALT`, explicit.
///
/// Simulate (no key needed), with BOOTSTRAP = 0x09Ce8E2B3Fede2727dA4392Ea8Fe618305ba0474:
///   forge script script/DeployTreasuryConduit.s.sol --fork-url $RPC --sender $BOOTSTRAP
/// Broadcast: same, plus --broadcast and a signer for BOOTSTRAP (--account / --ledger).
contract DeployTreasuryConduit is BufiDeployBase {
    function run() external returns (address conduit) {
        BufiDeployConfig.Chain memory c = _chain();

        vm.startBroadcast(BufiDeployConfig.BOOTSTRAP_OWNER);
        conduit = _create2("TreasuryConduit", BufiDeployConfig.CONDUIT_SALT, BufiInitCodes.conduit());
        _register(conduit, c.safe, c.appKit);
        _register(conduit, c.safe, c.lifi);
        for (uint256 i = 0; i < c.earnVaults.length; i++) {
            _register(conduit, c.safe, c.earnVaults[i]);
        }
        _handover("TreasuryConduit", conduit, c.safe);
        vm.stopBroadcast();
    }

    function _register(address conduit, address safe, address target) internal {
        if (target == address(0) || TreasuryConduit(conduit).targets(target)) return;
        _ownerCall(conduit, safe, abi.encodeCall(TreasuryConduit.setTarget, (target, true)), "conduit.setTarget");
        console2.log("  target", target);
    }
}
