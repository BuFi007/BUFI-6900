/*
 * Copyright (c) 2026, BUFI. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  findPredecessor,
  getAccessControlEntry,
  getAccessControlType,
  getAllowedRecipients,
  getEarnConfigs,
  getERC20SpendLimitInfo,
  getGasSpendLimit,
  getInstalledPlugins,
  getKeyTimeRange,
  getNativeTokenSpendLimitInfo,
  getPluginManifestHash,
  getRequiredPaymaster,
  getSessionKeys,
  installPlugin,
  isSelectorOnAccessControlList,
  isSessionKeyOf,
  uninstallPlugin,
} from '../../actions'

import type {
  FindPredecessorParameters,
  GetAccessControlEntryParameters,
  GetAccessControlTypeParameters,
  GetAllowedRecipientsParameters,
  GetEarnConfigsParameters,
  GetERC20SpendLimitInfoParameters,
  GetGasSpendLimitParameters,
  GetInstalledPluginsParameters,
  GetKeyTimeRangeParameters,
  GetNativeTokenSpendLimitInfoParameters,
  GetPluginManifestHashParameters,
  GetRequiredPaymasterParameters,
  GetSessionKeysParameters,
  InstallPluginParameters,
  IsSelectorOnAccessControlListParameters,
  IsSessionKeyOfParameters,
  UninstallPluginParameters,
} from '../../actions'
import type { ContractAccessControlType, SpendLimitInfo } from '../../types'
import type { Address, Chain, Client, Hex, Transport } from 'viem'
import type {
  SendUserOperationReturnType,
  SmartAccount,
} from 'viem/_types/account-abstraction'

export type BufiCascadeActions = {
  /**
   * Installs an ERC-6900 plugin on the account.
   * @param parameters - Parameters to use. See {@link InstallPluginParameters}.
   * @returns The user operation hash. See {@link SendUserOperationReturnType}.
   */
  installPlugin: (
    parameters: InstallPluginParameters,
  ) => Promise<SendUserOperationReturnType>
  /**
   * Uninstalls an ERC-6900 plugin from the account.
   * @param parameters - Parameters to use. See {@link UninstallPluginParameters}.
   * @returns The user operation hash. See {@link SendUserOperationReturnType}.
   */
  uninstallPlugin: (
    parameters: UninstallPluginParameters,
  ) => Promise<SendUserOperationReturnType>
  /**
   * Gets the plugins installed on an account.
   * @param parameters - Parameters to use. See {@link GetInstalledPluginsParameters}.
   * @returns The installed plugin addresses.
   */
  getInstalledPlugins: (
    parameters: GetInstalledPluginsParameters,
  ) => Promise<readonly Address[]>
  /**
   * Reads a plugin's manifest and returns its hash.
   * @param parameters - Parameters to use. See {@link GetPluginManifestHashParameters}.
   * @returns The manifest hash.
   */
  getPluginManifestHash: (
    parameters: GetPluginManifestHashParameters,
  ) => Promise<Hex>
  /**
   * Gets the recipients an account may transfer tokens to.
   * @param parameters - Parameters to use. See {@link GetAllowedRecipientsParameters}.
   * @returns The allowed recipients.
   */
  getAllowedRecipients: (
    parameters: GetAllowedRecipientsParameters,
  ) => Promise<readonly Address[]>
  /**
   * Gets the session keys registered for an account.
   * @param parameters - Parameters to use. See {@link GetSessionKeysParameters}.
   * @returns The session keys.
   */
  getSessionKeys: (
    parameters: GetSessionKeysParameters,
  ) => Promise<readonly Address[]>
  /**
   * Checks whether a key is a registered session key of an account.
   * @param parameters - Parameters to use. See {@link IsSessionKeyOfParameters}.
   * @returns True if the key is a session key of the account.
   */
  isSessionKeyOf: (parameters: IsSessionKeyOfParameters) => Promise<boolean>
  /**
   * Finds the list predecessor of a session key.
   * @param parameters - Parameters to use. See {@link FindPredecessorParameters}.
   * @returns The list predecessor.
   */
  findPredecessor: (parameters: FindPredecessorParameters) => Promise<Hex>
  /**
   * Gets the time range during which a session key is valid.
   * @param parameters - Parameters to use. See {@link GetKeyTimeRangeParameters}.
   * @returns The validity window.
   */
  getKeyTimeRange: (
    parameters: GetKeyTimeRangeParameters,
  ) => Promise<{ validAfter: number; validUntil: number }>
  /**
   * Gets the ERC-20 spend limit of a session key for a token.
   * @param parameters - Parameters to use. See {@link GetERC20SpendLimitInfoParameters}.
   * @returns The spend limit state. See {@link SpendLimitInfo}.
   */
  getERC20SpendLimitInfo: (
    parameters: GetERC20SpendLimitInfoParameters,
  ) => Promise<SpendLimitInfo>
  /**
   * Gets the gas spend limit of a session key.
   * @param parameters - Parameters to use. See {@link GetGasSpendLimitParameters}.
   * @returns The spend limit state and whether the key must be reset.
   */
  getGasSpendLimit: (
    parameters: GetGasSpendLimitParameters,
  ) => Promise<{ info: SpendLimitInfo; shouldReset: boolean }>
  /**
   * Gets the native token spend limit of a session key.
   * @param parameters - Parameters to use. See {@link GetNativeTokenSpendLimitInfoParameters}.
   * @returns The spend limit state. See {@link SpendLimitInfo}.
   */
  getNativeTokenSpendLimitInfo: (
    parameters: GetNativeTokenSpendLimitInfoParameters,
  ) => Promise<SpendLimitInfo>
  /**
   * Gets the contract access control list mode of a session key.
   * @param parameters - Parameters to use. See {@link GetAccessControlTypeParameters}.
   * @returns The list mode. See {@link ContractAccessControlType}.
   */
  getAccessControlType: (
    parameters: GetAccessControlTypeParameters,
  ) => Promise<ContractAccessControlType>
  /**
   * Gets the access control entry of a session key for a target contract.
   * @param parameters - Parameters to use. See {@link GetAccessControlEntryParameters}.
   * @returns Whether the target is on the list and whether its selectors are checked.
   */
  getAccessControlEntry: (
    parameters: GetAccessControlEntryParameters,
  ) => Promise<{ isOnList: boolean; checkSelectors: boolean }>
  /**
   * Checks whether a function selector of a target contract is on the access control list of a session key.
   * @param parameters - Parameters to use. See {@link IsSelectorOnAccessControlListParameters}.
   * @returns True if the selector is on the list.
   */
  isSelectorOnAccessControlList: (
    parameters: IsSelectorOnAccessControlListParameters,
  ) => Promise<boolean>
  /**
   * Gets the paymaster a session key is required to use.
   * @param parameters - Parameters to use. See {@link GetRequiredPaymasterParameters}.
   * @returns The required paymaster, or the zero address.
   */
  getRequiredPaymaster: (
    parameters: GetRequiredPaymasterParameters,
  ) => Promise<Address>
  /**
   * Gets the (token, vault) pairs of the account's adopted earn config on the current chain.
   * @param parameters - Parameters to use. See {@link GetEarnConfigsParameters}.
   * @returns The configured token to vault pairs.
   */
  getEarnConfigs: (
    parameters: GetEarnConfigsParameters,
  ) => Promise<readonly { token: Address; vault: Address }[]>
}

/**
 * Returns the BUFI cascade actions: plugin management plus the address book, session key and earn module reads
 * that describe the three faces of a cascade wallet (treasury, operations, agent).
 * @param client - Client to use.
 * @returns BUFI cascade actions. See {@link BufiCascadeActions}.
 */
export function bufiCascadeActions<transport extends Transport = Transport>(
  client: Client<transport, Chain | undefined, SmartAccount | undefined>,
): BufiCascadeActions {
  return {
    installPlugin: (parameters) => installPlugin(client, parameters),
    uninstallPlugin: (parameters) => uninstallPlugin(client, parameters),
    getInstalledPlugins: (parameters) =>
      getInstalledPlugins(client, parameters),
    getPluginManifestHash: (parameters) =>
      getPluginManifestHash(client, parameters),
    getAllowedRecipients: (parameters) =>
      getAllowedRecipients(client, parameters),
    getSessionKeys: (parameters) => getSessionKeys(client, parameters),
    isSessionKeyOf: (parameters) => isSessionKeyOf(client, parameters),
    findPredecessor: (parameters) => findPredecessor(client, parameters),
    getKeyTimeRange: (parameters) => getKeyTimeRange(client, parameters),
    getERC20SpendLimitInfo: (parameters) =>
      getERC20SpendLimitInfo(client, parameters),
    getGasSpendLimit: (parameters) => getGasSpendLimit(client, parameters),
    getNativeTokenSpendLimitInfo: (parameters) =>
      getNativeTokenSpendLimitInfo(client, parameters),
    getAccessControlType: (parameters) =>
      getAccessControlType(client, parameters),
    getAccessControlEntry: (parameters) =>
      getAccessControlEntry(client, parameters),
    isSelectorOnAccessControlList: (parameters) =>
      isSelectorOnAccessControlList(client, parameters),
    getRequiredPaymaster: (parameters) =>
      getRequiredPaymaster(client, parameters),
    getEarnConfigs: (parameters) => getEarnConfigs(client, parameters),
  }
}
