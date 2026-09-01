// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";

import { BufiEarnModule } from "../src/BufiEarnModule.sol";

/**
 * CREATE2 deploy via the deterministic deployment proxy (0x4e59b4…956C) so
 * Fuji + Arc testnet share one module address — one configHash then spans
 * both chains. Initial relayer = owner = deployer (dev placeholder; rotate
 * via addAuthorizedRelayer / transferOwnership before any shared use).
 *
 * DEPLOYER_PRIVATE_KEY is read from the environment, never from CLI args.
 */
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        bytes32 salt = keccak256("bufi-earn-module-v0.1.0-dev");

        vm.startBroadcast(pk);
        BufiEarnModule module = new BufiEarnModule{ salt: salt }(deployer, deployer);
        vm.stopBroadcast();

        console2.log("chainId", block.chainid);
        console2.log("deployer/relayer/owner", deployer);
        console2.log("BufiEarnModule", address(module));
        console2.logBytes32(module.manifestHash());
    }
}
