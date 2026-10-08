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
///         env (required, no default): EARN_MODULE_RELAYER — the production relayer: ONE Circle
///         developer-controlled wallet (DCW) EOA, created in the live Circle entity by the founder/ops and used
///         on every chain (founder, 2026-10-08). It may not be the bootstrap deployer or the Safe. It is part of
///         the earn module's init code, so the module's address is identical across chains only because the
///         same relayer is used on each.
///
///         EARN_MODULE_RELAYER=0x... forge script script/DeployBufiPlugins.s.sol --fork-url $RPC \
///           --sender 0x09Ce8E2B3Fede2727dA4392Ea8Fe618305ba0474
contract DeployBufiPlugins is BufiDeployBase {
    function run() external returns (address sessionKey, address earn, address recipientHook) {
        BufiDeployConfig.Chain memory c = _chain();
        address relayer = _relayer();
        require(relayer != address(0), "EARN_MODULE_RELAYER is zero");
        require(relayer != BufiDeployConfig.BOOTSTRAP_OWNER, "EARN_MODULE_RELAYER must not be the deployer");
        require(relayer != c.safe, "EARN_MODULE_RELAYER must not be the Safe");

        bytes32 salt = BufiDeployConfig.PLUGIN_SALT;
        vm.startBroadcast(BufiDeployConfig.BOOTSTRAP_OWNER);
        sessionKey = _create2("BufiSessionKeyPlugin", salt, type(BufiSessionKeyPlugin).creationCode);
        earn = _create2("BufiEarnModule", BufiDeployConfig.EARN_MODULE_SALT, BufiInitCodes.earnModule(relayer));
        // Stateless (its only storage is the per-account AddressBook binding written by `onInstall`).
        recipientHook =
            _create2("BufiSessionRecipientHookPlugin", salt, type(BufiSessionRecipientHookPlugin).creationCode);
        _handover("BufiEarnModule", earn, c.safe);
        vm.stopBroadcast();

        console.log("BufiSessionKeyPlugin        %s", sessionKey);
        console.logBytes32(keccak256(abi.encode(IPlugin(sessionKey).pluginManifest())));
        console.log("BufiEarnModule              %s (relayer %s)", earn, relayer);
        console.logBytes32(keccak256(abi.encode(IPlugin(earn).pluginManifest())));
        console.log("BufiSessionRecipientHookPlugin %s", recipientHook);
        console.logBytes32(keccak256(abi.encode(IPlugin(recipientHook).pluginManifest())));
    }

    /// Required, no default. Virtual only so tests can supply it without a process-global env var.
    function _relayer() internal view virtual returns (address) {
        return vm.envAddress("EARN_MODULE_RELAYER");
    }
}
