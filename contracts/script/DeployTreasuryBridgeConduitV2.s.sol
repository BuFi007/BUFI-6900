// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/src/Script.sol";
import {TreasuryBridgeConduitV2} from "../src/bufi/conduit/TreasuryBridgeConduitV2.sol";

/// @notice Testnet-only V2 deployment. `forge script` defaults to simulation;
/// an operator must explicitly add --broadcast. Mainnet has no override here.
/// Owner, venues and bridges are explicit inputs; no existing V1 registry is changed.
contract DeployTreasuryBridgeConduitV2 is Script {
    address public constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    bytes32 public constant SALT = keccak256("bufi.treasury-bridge-conduit.v2");

    function run() external returns (address predicted) {
        require(block.chainid == 5042002 || block.chainid == 43113, "V2 deployment: Arc Testnet or Fuji only");
        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address owner = vm.envAddress("BRIDGE_CONDUIT_OWNER");
        require(owner != address(0) && owner == vm.addr(key), "testnet bootstrap owner must be broadcaster");
        require(CREATE2_DEPLOYER.code.length > 0, "canonical CREATE2 deployer missing");
        address[] memory venues = vm.envOr("BRIDGE_CONDUIT_TARGETS", ",", new address[](0));
        address messenger = vm.envAddress("BRIDGE_CCTP_V2");
        require(messenger.code.length > 0, "TokenMessengerV2 missing");
        for (uint256 i; i < venues.length; i++) {
            require(venues[i] != messenger && venues[i].code.length > 0, "invalid source swap venue");
        }
        bytes memory initCode = abi.encodePacked(type(TreasuryBridgeConduitV2).creationCode, abi.encode(owner));
        predicted = vm.computeCreate2Address(SALT, keccak256(initCode), CREATE2_DEPLOYER);
        console2.log("chainId", block.chainid);
        console2.log("owner", owner);
        console2.log("predicted V2", predicted);
        vm.startBroadcast(key);
        if (predicted.code.length == 0) {
            (bool ok,) = CREATE2_DEPLOYER.call(abi.encodePacked(SALT, initCode));
            require(ok && predicted.code.length > 0, "V2 CREATE2 deployment failed");
        }
        require(predicted.codehash == keccak256(type(TreasuryBridgeConduitV2).runtimeCode), "V2 runtime mismatch");
        TreasuryBridgeConduitV2 conduit = TreasuryBridgeConduitV2(predicted);
        require(conduit.owner() == owner, "V2 owner mismatch");
        if (!conduit.bridges(TreasuryBridgeConduitV2.BridgeKind.CCTP_V2, messenger)) {
            conduit.setBridge(TreasuryBridgeConduitV2.BridgeKind.CCTP_V2, messenger, true);
        }
        for (uint256 i; i < venues.length; i++) {
            if (!conduit.targets(venues[i])) conduit.setTarget(venues[i], true);
        }
        vm.stopBroadcast();
        require(conduit.bridges(TreasuryBridgeConduitV2.BridgeKind.CCTP_V2, messenger), "V2 bridge readback failed");
        for (uint256 i; i < venues.length; i++) {
            require(conduit.targets(venues[i]), "V2 venue readback failed");
        }
    }
}
