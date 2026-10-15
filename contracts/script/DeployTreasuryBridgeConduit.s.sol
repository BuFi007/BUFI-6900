// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/src/Script.sol";

import {TreasuryBridgeConduit} from "../src/bufi/conduit/TreasuryBridgeConduit.sol";

/// @notice Deploys TreasuryBridgeConduit (plan 408 v2) through the Arachnid
/// CREATE2 deployer, then registers the chain's swap venues, burn contracts and
/// CCTPx token ids. Idempotent: re-running only registers what is missing.
///
///   DEPLOYER_PRIVATE_KEY        signer (needs gas; on Arc that is USDC)
///   BRIDGE_CONDUIT_OWNER        REQUIRED. On a mainnet it must equal that chain's Safe.
///   BRIDGE_CONDUIT_SALT         bytes32, defaults to keccak256("bufi.treasury-bridge-conduit.v1")
///   BRIDGE_CONDUIT_TARGETS      optional comma-separated swap venues (setTarget)
///   BRIDGE_CCTP_V2              optional comma-separated TokenMessengerV2 addresses
///   BRIDGE_CCTPX                optional comma-separated CrossChainTokenService addresses
///   CCTPX_TOKEN_IDS             optional comma-separated bytes32 CCTPx token ids
///   CCTPX_TOKENS                the ERC-20 for each id, same order and length
///   ALLOW_MAINNET               must be 1 to run on a mainnet chain id. Agents never set it.
///
/// Registration calls are owner-only, so they run only when the broadcaster IS
/// the owner (testnets). On a mainnet the owner is the Safe, and registration
/// is a Safe transaction this script never builds.
///
///   forge script script/DeployTreasuryBridgeConduit.s.sol --rpc-url $RPC [--broadcast]
contract DeployTreasuryBridgeConduit is Script {
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    address internal constant ARC_SAFE = 0x47Dc7D18A6E3a79F696714E7D47456a49B430D09;
    address internal constant AVALANCHE_SAFE = 0xA3a40fa2d82C0224c40b1Ed7E07cb474B7D1468B;

    function run() external {
        bool mainnet = _isMainnet(block.chainid);
        if (mainnet) {
            require(vm.envOr("ALLOW_MAINNET", uint256(0)) == 1, "mainnet chain: refused without ALLOW_MAINNET=1");
        }

        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(key);
        address owner = vm.envAddress("BRIDGE_CONDUIT_OWNER");
        require(owner != address(0), "BRIDGE_CONDUIT_OWNER is zero");
        if (mainnet) {
            address safe = _safeFor(block.chainid);
            require(safe != address(0), "no Safe recorded for this mainnet");
            require(owner == safe, "mainnet owner must be the chain's Safe");
        }

        bytes32 salt = vm.envOr("BRIDGE_CONDUIT_SALT", keccak256("bufi.treasury-bridge-conduit.v1"));
        bytes memory initCode = abi.encodePacked(type(TreasuryBridgeConduit).creationCode, abi.encode(owner));
        address predicted = vm.computeCreate2Address(salt, keccak256(initCode), CREATE2_DEPLOYER);
        console2.log("chainid", block.chainid);
        console2.log("deployer", deployer);
        console2.log("owner", owner);
        console2.log("predicted", predicted);

        address[] memory venues = vm.envOr("BRIDGE_CONDUIT_TARGETS", ",", new address[](0));
        address[] memory cctpV2 = vm.envOr("BRIDGE_CCTP_V2", ",", new address[](0));
        address[] memory cctpx = vm.envOr("BRIDGE_CCTPX", ",", new address[](0));
        bytes32[] memory tokenIds = vm.envOr("CCTPX_TOKEN_IDS", ",", new bytes32[](0));
        address[] memory tokens = vm.envOr("CCTPX_TOKENS", ",", new address[](0));
        require(tokenIds.length == tokens.length, "CCTPX_TOKEN_IDS / CCTPX_TOKENS length mismatch");

        // Every address registered must have code, and every CCTPx id must resolve.
        for (uint256 i = 0; i < venues.length; i++) {
            require(venues[i].code.length > 0, "venue has no code");
        }
        for (uint256 i = 0; i < cctpV2.length; i++) {
            require(cctpV2[i].code.length > 0, "TokenMessengerV2 has no code");
        }
        // The CCTPx service runs post-Paris opcodes, which this paris-pinned
        // script EVM cannot execute (`NotActivated`). Confirm each id resolves
        // BEFORE running, outside the script:
        //   cast call $CCTS "resolveTokenManager(bytes32)(address)" $ID --rpc-url $RPC
        for (uint256 i = 0; i < cctpx.length; i++) {
            require(cctpx[i].code.length > 0, "CrossChainTokenService has no code");
        }
        for (uint256 i = 0; i < tokens.length; i++) {
            require(tokens[i].code.length > 0, "CCTPx token has no code");
        }

        vm.startBroadcast(key);
        if (predicted.code.length == 0) {
            (bool ok,) = CREATE2_DEPLOYER.call(abi.encodePacked(salt, initCode));
            require(ok, "create2 failed");
            require(predicted.code.length > 0, "bridge conduit missing after create2");
            console2.log("TreasuryBridgeConduit deployed", predicted);
        } else {
            console2.log("TreasuryBridgeConduit already at", predicted);
        }

        TreasuryBridgeConduit conduit = TreasuryBridgeConduit(predicted);
        require(conduit.owner() == owner, "on-chain owner differs from BRIDGE_CONDUIT_OWNER");

        if (owner != deployer) {
            vm.stopBroadcast();
            console2.log("broadcaster is not the owner: registration skipped (owner must do it)");
            return;
        }

        for (uint256 i = 0; i < venues.length; i++) {
            if (!conduit.targets(venues[i])) {
                conduit.setTarget(venues[i], true);
                console2.log("target registered", venues[i]);
            } else {
                console2.log("target already registered", venues[i]);
            }
        }
        for (uint256 i = 0; i < cctpV2.length; i++) {
            if (!conduit.bridges(TreasuryBridgeConduit.BridgeKind.CCTP_V2, cctpV2[i])) {
                conduit.setBridge(TreasuryBridgeConduit.BridgeKind.CCTP_V2, cctpV2[i], true);
                console2.log("CCTP_V2 bridge registered", cctpV2[i]);
            } else {
                console2.log("CCTP_V2 bridge already registered", cctpV2[i]);
            }
        }
        for (uint256 i = 0; i < cctpx.length; i++) {
            if (!conduit.bridges(TreasuryBridgeConduit.BridgeKind.CCTPX, cctpx[i])) {
                conduit.setBridge(TreasuryBridgeConduit.BridgeKind.CCTPX, cctpx[i], true);
                console2.log("CCTPX bridge registered", cctpx[i]);
            } else {
                console2.log("CCTPX bridge already registered", cctpx[i]);
            }
        }
        for (uint256 i = 0; i < tokenIds.length; i++) {
            if (conduit.cctpxTokens(tokenIds[i]) != tokens[i]) {
                conduit.setCctpxToken(tokenIds[i], tokens[i]);
                console2.log("CCTPx token registered", tokens[i]);
                console2.logBytes32(tokenIds[i]);
            } else {
                console2.log("CCTPx token already registered", tokens[i]);
            }
        }
        vm.stopBroadcast();
    }

    function _isMainnet(uint256 chainId) internal pure returns (bool) {
        return chainId == 5042 || chainId == 43114 || chainId == 1 || chainId == 8453 || chainId == 42161
            || chainId == 10 || chainId == 137;
    }

    function _safeFor(uint256 chainId) internal pure returns (address) {
        if (chainId == 5042) return ARC_SAFE;
        if (chainId == 43114) return AVALANCHE_SAFE;
        return address(0);
    }
}
