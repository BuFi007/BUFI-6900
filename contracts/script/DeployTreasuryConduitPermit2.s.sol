// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {TreasuryConduitPermit2} from "../src/bufi/conduit/TreasuryConduitPermit2.sol";
import {Script, console2} from "forge-std/src/Script.sol";

/// @notice Arc/Avalanche inert deployment. Running without --broadcast is a simulation.
/// @dev No keys are read and no router, spender, token or Treasury is enabled here.
contract DeployTreasuryConduitPermit2 is Script {
    address public constant ARC_SAFE = 0x47Dc7D18A6E3a79F696714E7D47456a49B430D09;
    address public constant AVALANCHE_SAFE = 0xA3a40fa2d82C0224c40b1Ed7E07cb474B7D1468B;
    address public constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address public constant ADDRESS_BOOK = 0x0000000d81083B16EA76dfab46B0315B0eDBF3d0;
    address public constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    bytes32 public constant SALT = keccak256("bufi.treasury-conduit-permit2.v1");

    /// @dev The deployment initializer and dependency identity are reviewed per chain.
    function deploymentConfig(uint256 chainId) public pure returns (address owner, bytes32 permit2CodeHash) {
        if (chainId == 5042) {
            return (ARC_SAFE, 0x05a793d6bdba8b8715c8f4cef0725ec3a961f567d33ebb2d360f541f19f70c8f);
        }
        if (chainId == 43114) {
            return (AVALANCHE_SAFE, 0x081beff14e75c5a5c1e60740445f58d54ba0fef228148a11d3e4287dc3551cbb);
        }
        revert("Arc or Avalanche mainnet only");
    }

    function run(address expectedOwner) external returns (TreasuryConduitPermit2 conduit) {
        (address owner, bytes32 permit2CodeHash) = deploymentConfig(block.chainid);
        require(expectedOwner == owner, "owner must be the chain Safe");
        require(owner.code.length > 0, "Safe missing");
        require(PERMIT2.codehash == permit2CodeHash, "Permit2 code changed");
        require(
            ADDRESS_BOOK.codehash == 0x0dede8ca2fbfa958a8ec19275a7a78cca0e64b3b3701af661baa94c1316aa110,
            "Address Book code changed"
        );
        require(
            CREATE2_DEPLOYER.codehash == 0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989,
            "CREATE2 deployer code changed"
        );
        bytes memory initCode =
            abi.encodePacked(type(TreasuryConduitPermit2).creationCode, abi.encode(owner, PERMIT2, ADDRESS_BOOK));
        address predicted = vm.computeCreate2Address(SALT, keccak256(initCode), CREATE2_DEPLOYER);
        if (predicted.code.length == 0) {
            vm.startBroadcast();
            (bool ok,) = CREATE2_DEPLOYER.call(abi.encodePacked(SALT, initCode));
            require(ok && predicted.code.length > 0, "CREATE2 deployment failed");
            vm.stopBroadcast();
        }
        conduit = TreasuryConduitPermit2(predicted);
        require(conduit.owner() == owner, "incorrect owner");
        require(address(conduit.permit2()) == PERMIT2, "incorrect Permit2");
        require(address(conduit.addressBook()) == ADDRESS_BOOK, "incorrect Address Book");
        console2.log("TreasuryConduitPermit2", predicted);
        console2.log("owner", conduit.owner());
        console2.log("runtime code hash");
        console2.logBytes32(predicted.codehash);
    }
}
