// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {BufiEarnModule} from "../src/bufi/v0.7/earn/BufiEarnModule.sol";
import {BufiSessionKeyPlugin} from "../src/bufi/v0.7/session/BufiSessionKeyPlugin.sol";

import {IPlugin} from "@circle/msca/6900/v0.7/interfaces/IPlugin.sol";
import {Script, console} from "forge-std/src/Script.sol";

/// @title DeployBufiPlugins
/// @notice Deploys BUFI's ERC-6900 v0.7 plugins through the Arachnid CREATE2 deployer so every chain (local
///         sandbox, Avalanche Fuji, Arc testnet, …) gets the SAME plugin addresses — the pattern Circle uses for
///         its own stack. Idempotent: skips a plugin whose code already exists at the expected address.
///
///         forge script script/DeployBufiPlugins.s.sol --rpc-url avax-fuji --broadcast -vv
///         env: DEPLOYER_PRIVATE_KEY, EARN_MODULE_OWNER / EARN_MODULE_RELAYER (default to the deployer),
///              BUFI_PLUGIN_SALT (optional)
contract DeployBufiPlugins is Script {
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    function run() external {
        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(key);
        address earnOwner = vm.envOr("EARN_MODULE_OWNER", deployer);
        address earnRelayer = vm.envOr("EARN_MODULE_RELAYER", deployer);
        bytes32 salt = vm.envOr("BUFI_PLUGIN_SALT", keccak256("bufi-6900-plugins-v0.1.0"));
        require(CREATE2_DEPLOYER.code.length != 0, "CREATE2 deployer missing on this chain");

        vm.startBroadcast(key);
        address sessionKey = _create2("BufiSessionKeyPlugin", salt, type(BufiSessionKeyPlugin).creationCode, "");
        address earn = _create2("BufiEarnModule", salt, type(BufiEarnModule).creationCode, abi.encode(earnRelayer, earnOwner));
        vm.stopBroadcast();

        console.log("chainId                     %s", block.chainid);
        console.log("BufiSessionKeyPlugin        %s", sessionKey);
        console.log("  manifestHash");
        console.logBytes32(keccak256(abi.encode(IPlugin(sessionKey).pluginManifest())));
        console.log("BufiEarnModule              %s (owner %s, relayer %s)", earn, earnOwner, earnRelayer);
        console.log("  manifestHash");
        console.logBytes32(keccak256(abi.encode(IPlugin(earn).pluginManifest())));
    }

    function _create2(string memory name, bytes32 salt, bytes memory creationCode, bytes memory args)
        internal
        returns (address deployed)
    {
        bytes memory initCode = abi.encodePacked(creationCode, args);
        address expected = vm.computeCreate2Address(salt, keccak256(initCode), CREATE2_DEPLOYER);
        if (expected.code.length != 0) {
            console.log("%s already at %s", name, expected);
            return expected;
        }
        (bool ok, bytes memory ret) = CREATE2_DEPLOYER.call(abi.encodePacked(salt, initCode));
        require(ok, string.concat("CREATE2 failed: ", name));
        deployed = address(bytes20(ret));
        require(deployed == expected, string.concat("CREATE2 address mismatch: ", name));
    }
}
