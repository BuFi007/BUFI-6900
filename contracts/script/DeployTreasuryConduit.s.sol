// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/src/Script.sol";

import {TreasuryConduit} from "../src/bufi/conduit/TreasuryConduit.sol";

/// @notice Deploys TreasuryConduit through the Arachnid CREATE2 deployer so the
/// address is the same on every chain, then registers the chain's targets.
///
///   DEPLOYER_PRIVATE_KEY   signer (needs gas; on Arc that is USDC)
///   CONDUIT_OWNER          BUFI ops multisig (defaults to the deployer — dev only)
///   CONDUIT_SALT           bytes32, defaults to keccak256("bufi.treasury-conduit.v1")
///   CONDUIT_TARGETS        optional comma-separated router/pool/vault addresses
///
///   forge script script/DeployTreasuryConduit.s.sol --rpc-url $RPC --broadcast
contract DeployTreasuryConduit is Script {
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    function run() external {
        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(key);
        address owner = vm.envOr("CONDUIT_OWNER", deployer);
        bytes32 salt = vm.envOr("CONDUIT_SALT", keccak256("bufi.treasury-conduit.v1"));
        bytes memory initCode = abi.encodePacked(type(TreasuryConduit).creationCode, abi.encode(owner));
        address predicted = vm.computeCreate2Address(salt, keccak256(initCode), CREATE2_DEPLOYER);

        vm.startBroadcast(key);
        if (predicted.code.length == 0) {
            (bool ok,) = CREATE2_DEPLOYER.call(abi.encodePacked(salt, initCode));
            require(ok, "create2 failed");
            require(predicted.code.length > 0, "conduit missing after create2");
            console2.log("TreasuryConduit deployed", predicted);
        } else {
            console2.log("TreasuryConduit already at", predicted);
        }
        address[] memory targets = vm.envOr("CONDUIT_TARGETS", ",", new address[](0));
        TreasuryConduit conduit = TreasuryConduit(predicted);
        for (uint256 i = 0; i < targets.length; i++) {
            if (!conduit.targets(targets[i])) {
                conduit.setTarget(targets[i], true);
                console2.log("target registered", targets[i]);
            }
        }
        vm.stopBroadcast();
        console2.log("owner", owner);
    }
}
