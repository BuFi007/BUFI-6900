// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {BufiSessionRecipientHookPlugin} from "../src/bufi/v0.7/recipient-hook/BufiSessionRecipientHookPlugin.sol";
import {BufiSessionKeyPlugin} from "../src/bufi/v0.7/session/BufiSessionKeyPlugin.sol";
import {BufiDeployBase} from "./config/BufiDeployBase.sol";
import {BufiDeployConfig} from "./config/BufiDeployConfig.sol";
import {BufiInitCodes} from "./config/BufiInitCodes.sol";

import {IPlugin} from "@circle/msca/6900/v0.7/interfaces/IPlugin.sol";
import {console} from "forge-std/src/Script.sol";

/// @title DeployBufiPlugins
/// @notice BUFI's ERC-6900 v0.7 plugins through the Arachnid CREATE2 proxy. The two stateless plugins are
///         ownerless; BufiEarnModule is bootstrapped with `BOOTSTRAP_OWNER` and handed to the chain's Safe
///         (Ownable2Step). Unknown chain ids are refused. Salts: `PLUGIN_SALT` for the two stateless plugins,
///         `EARN_MODULE_SALT` for BufiEarnModule; both explicit.
///
///         BufiEarnModule takes no relayer: each account names its own (its team's agent Circle DCW) in its
///         install data, so the module lands at ONE address on every chain — `BufiInitCodes.earnModuleAddress()`.
///
///         forge script script/DeployBufiPlugins.s.sol --fork-url $RPC \
///           --sender 0x09Ce8E2B3Fede2727dA4392Ea8Fe618305ba0474
contract DeployBufiPlugins is BufiDeployBase {
    function run() external returns (address sessionKey, address earn, address recipientHook) {
        BufiDeployConfig.Chain memory c = _chain();

        bytes32 salt = BufiDeployConfig.PLUGIN_SALT;
        vm.startBroadcast(BufiDeployConfig.BOOTSTRAP_OWNER);
        sessionKey = _create2("BufiSessionKeyPlugin", salt, type(BufiSessionKeyPlugin).creationCode);
        earn = _create2("BufiEarnModule", BufiDeployConfig.EARN_MODULE_SALT, BufiInitCodes.earnModule());
        require(earn == BufiInitCodes.earnModuleAddress(), "earn module address drifted");
        // Stateless (its only storage is the per-account AddressBook binding written by `onInstall`).
        recipientHook =
            _create2("BufiSessionRecipientHookPlugin", salt, type(BufiSessionRecipientHookPlugin).creationCode);
        _handover("BufiEarnModule", earn, c.safe);
        vm.stopBroadcast();

        console.log("BufiSessionKeyPlugin        %s", sessionKey);
        console.logBytes32(keccak256(abi.encode(IPlugin(sessionKey).pluginManifest())));
        console.log("BufiEarnModule              %s (per-account relayer)", earn);
        console.logBytes32(keccak256(abi.encode(IPlugin(earn).pluginManifest())));
        console.log("BufiSessionRecipientHookPlugin %s", recipientHook);
        console.logBytes32(keccak256(abi.encode(IPlugin(recipientHook).pluginManifest())));
    }
}
