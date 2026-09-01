// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

/// @title CircleStack
/// @notice Re-exports every Circle ERC-6900 v0.7 contract the sandbox redeploys, so `forge build`
///         compiles the vendored `circlefin/buidl-wallet-contracts` sources exactly as pinned in
///         `lib/buidl-wallet-contracts`, using the same solc/evm/optimizer profile Circle ships.
///         Nothing here is modified — these are the contracts Circle runs in production.
import {EntryPoint} from "@account-abstraction/contracts/core/EntryPoint.sol";
import {PluginManager} from "@circle/msca/6900/v0.7/managers/PluginManager.sol";
import {UpgradableMSCA} from "@circle/msca/6900/v0.7/account/UpgradableMSCA.sol";
import {UpgradableMSCAFactory} from "@circle/msca/6900/v0.7/factories/UpgradableMSCAFactory.sol";
import {SingleOwnerPlugin} from "@circle/msca/6900/v0.7/plugins/v1_0_0/acl/SingleOwnerPlugin.sol";
import {WeightedWebauthnMultisigPlugin} from
    "@circle/msca/6900/v0.7/plugins/v1_0_0/multisig/WeightedWebauthnMultisigPlugin.sol";
import {ColdStorageAddressBookPlugin} from
    "@circle/msca/6900/v0.7/plugins/v1_0_0/addressbook/ColdStorageAddressBookPlugin.sol";
import {DefaultCallbackHandler} from "@circle/callback/DefaultCallbackHandler.sol";
import {SponsorPaymaster} from "@circle/paymaster/v1/permissioned/SponsorPaymaster.sol";
