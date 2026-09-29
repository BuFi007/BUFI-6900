// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/src/Script.sol";

import {TreasuryConduit} from "../src/bufi/conduit/TreasuryConduit.sol";
import {TreasurySwapAndDeposit} from "../src/bufi/conduit/TreasurySwapAndDeposit.sol";

/// CREATE2 `TreasurySwapAndDeposit` and register it on the dest conduit.
///
///   DEPLOYER_PRIVATE_KEY
///   USDC              defaults to Arc Testnet native-gas USDC
///   CONDUIT           defaults to TreasuryConduit v2
///   CONDUIT_OWNER     defaults to the deployer
///   VAULT             dest to seed (Arc Testnet canary vault)
///   VENUES            comma-separated swap venues (App Kit + LI.FI)
///
///   forge script script/DeployTreasurySwapAndDeposit.s.sol --rpc-url $RPC --broadcast
contract DeployTreasurySwapAndDeposit is Script {
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    address internal constant ARC_TESTNET_USDC = 0x3600000000000000000000000000000000000000;
    address internal constant TREASURY_CONDUIT_V2 = 0xA9817049F0a48d4653719465A7829E85b3A415e7;
    address internal constant ARC_TESTNET_VAULT = 0x0a9a082C24364B90B73e20E57d7625A3aa798bCa;
    address internal constant ARC_APPKIT = 0xBBD70b01a1CAbc96d5b7b129Ae1AAabdf50dd40b;
    address internal constant ARC_LIFI = 0xFf70F4A1d11995621854F3692acF286d8aCd04b2;

    function run() external {
        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(key);
        address owner = vm.envOr("CONDUIT_OWNER", deployer);
        address usdc = vm.envOr("USDC", ARC_TESTNET_USDC);
        address conduitAddr = vm.envOr("CONDUIT", TREASURY_CONDUIT_V2);
        address vault = vm.envOr("VAULT", ARC_TESTNET_VAULT);

        bytes32 salt = keccak256("bufi.treasury-swap-deposit.v1");
        bytes memory initCode = abi.encodePacked(type(TreasurySwapAndDeposit).creationCode, abi.encode(owner, usdc));
        address predicted = vm.computeCreate2Address(salt, keccak256(initCode), CREATE2_DEPLOYER);
        console2.log("predicted", predicted);

        vm.startBroadcast(key);
        if (predicted.code.length == 0) {
            (bool ok,) = CREATE2_DEPLOYER.call(abi.encodePacked(salt, initCode));
            require(ok && predicted.code.length > 0, "adapter create2");
            console2.log("TreasurySwapAndDeposit deployed", predicted);
        } else {
            console2.log("TreasurySwapAndDeposit already at", predicted);
        }

        TreasurySwapAndDeposit adapter = TreasurySwapAndDeposit(predicted);
        if (!adapter.venues(ARC_APPKIT)) adapter.setVenue(ARC_APPKIT, true);
        if (!adapter.venues(ARC_LIFI)) adapter.setVenue(ARC_LIFI, true);
        if (!adapter.dests(vault)) adapter.setDest(vault, true);

        TreasuryConduit conduit = TreasuryConduit(conduitAddr);
        if (!conduit.targets(predicted)) {
            conduit.setTarget(predicted, true);
            console2.log("conduit setTarget adapter");
        }
        vm.stopBroadcast();

        console2.log("owner", owner);
        console2.log("usdc ", usdc);
        console2.log("adapter", predicted);
    }
}
