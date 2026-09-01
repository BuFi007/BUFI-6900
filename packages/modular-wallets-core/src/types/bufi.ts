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

import type { Address, Client, Hex, LocalAccount, Prettify } from 'viem'
import type {
  SmartAccount,
  SmartAccountImplementation,
} from 'viem/_types/account-abstraction/accounts/types'
import type { entryPoint07Abi } from 'viem/account-abstraction/constants/abis'

/**
 * A deployed ERC-6900 plugin: its address and the keccak256 hash of its manifest.
 */
export interface PluginDeployment {
  /**
   * The plugin contract address.
   */
  address: Hex
  /**
   * The `keccak256(abi.encode(pluginManifest()))` value `installPlugin` expects.
   */
  manifestHash: Hex
}

/**
 * A complete deployment of the Circle Modular Smart Contract Account stack, optionally extended with the BUFI plugins.
 *
 * The canonical Circle deployment is exported as `CIRCLE_CANONICAL_DEPLOYMENT`; a redeployed sandbox stack (for example
 * the anvil stack produced by the `contracts/` package) is loaded with `toStackDeployment`.
 */
export interface StackDeployment {
  /**
   * The chain the stack is deployed on. Optional because the canonical Circle addresses are identical on every chain.
   */
  chainId?: number
  /**
   * The ERC-4337 v0.7 EntryPoint.
   */
  entryPoint: Hex
  /**
   * The UpgradableMSCA factory.
   */
  upgradableMscaFactory: Hex
  /**
   * The UpgradableMSCA implementation the factory proxies to.
   */
  upgradableMsca: Hex
  /**
   * The PluginManager library.
   */
  pluginManager: Hex
  /**
   * The Circle WeightedWebauthnMultisigPlugin.
   */
  weightedWebauthnMultisig: PluginDeployment
  /**
   * The Circle ColdStorageAddressBookPlugin.
   */
  coldStorageAddressBook: PluginDeployment
  /**
   * The BUFI session key plugin (Alchemy MAv1 `ISessionKeyPlugin` ABI). Absent on the canonical Circle deployment.
   */
  bufiSessionKey?: PluginDeployment
  /**
   * The BUFI earn module. Absent on the canonical Circle deployment.
   */
  bufiEarnModule?: PluginDeployment
  /**
   * A verifying paymaster, when the stack ships one.
   */
  paymaster?: Hex
  /**
   * Named token addresses (for example `usdc`) deployed alongside the stack.
   */
  tokens?: Record<string, Hex>
}

/**
 * An ERC-6900 v0.7 `FunctionReference`: a plugin address plus one of its validation function ids.
 */
export interface FunctionReference {
  /**
   * The plugin address.
   */
  plugin: Address
  /**
   * The validation function id within the plugin.
   */
  functionId: number
}

/**
 * A call to be executed by the account. Mirrors the `Call` struct of `IStandardExecutor`.
 */
export interface Call {
  /**
   * The target address.
   */
  target: Address
  /**
   * The value to send with the call.
   */
  value: bigint
  /**
   * The calldata for the call.
   */
  data: Hex
}

/**
 * A call in the shape accepted by a viem `SmartAccount`'s `encodeCalls` (and therefore `sendUserOperation`).
 */
export interface EncodedCall {
  /**
   * The target address.
   */
  to: Address
  /**
   * The value to send with the call.
   */
  value: bigint
  /**
   * The calldata for the call.
   */
  data: Hex
}

/**
 * The contract access control list mode of a session key. Mirrors `ISessionKeyPlugin.ContractAccessControlType`.
 */
export enum ContractAccessControlType {
  /**
   * The list is an allowlist (the default).
   */
  Allowlist = 0,
  /**
   * The list is a denylist.
   */
  Denylist = 1,
  /**
   * Contract access control is disabled.
   */
  AllowAllAccess = 2,
}

/**
 * The state of a spend limit on a session key. Mirrors `ISessionKeyPlugin.SpendLimitInfo`.
 */
export interface SpendLimitInfo {
  /**
   * Whether a limit is enforced.
   */
  hasLimit: boolean
  /**
   * The limit amount.
   */
  limit: bigint
  /**
   * The amount used in the current interval.
   */
  limitUsed: bigint
  /**
   * The refresh interval in seconds (zero means the limit never refreshes).
   */
  refreshInterval: number
  /**
   * The timestamp the limit was last used.
   */
  lastUsedTime: number
}

/**
 * One target the session key may call. Without `selectors` any function on the target is allowed.
 */
export interface BufiGrantScopeEntry {
  /**
   * The contract the session key may call.
   */
  target: Address
  /**
   * The function selectors allowed on the target. Omit to allow every selector.
   */
  selectors?: readonly Hex[]
}

/**
 * The scope of a BUFI grant: the contracts (and optionally selectors) a session key may call.
 */
export interface BufiGrantScope {
  /**
   * The allowlisted targets.
   */
  allow: readonly BufiGrantScopeEntry[]
}

/**
 * An ERC-20 spend budget for a session key.
 */
export interface BufiGrantErc20Budget {
  /**
   * The ERC-20 token.
   */
  token: Address
  /**
   * The maximum amount the session key may spend per interval.
   */
  limit: bigint
  /**
   * The interval in seconds after which the limit refreshes (zero means never).
   */
  refreshIntervalSeconds: number
}

/**
 * A native token or gas spend budget for a session key.
 */
export interface BufiGrantSpendBudget {
  /**
   * The maximum amount (in wei) the session key may spend per interval.
   */
  limit: bigint
  /**
   * The interval in seconds after which the limit refreshes (zero means never).
   */
  refreshIntervalSeconds: number
}

/**
 * The budget of a BUFI grant.
 */
export interface BufiGrantBudget {
  /**
   * ERC-20 spend limits, one per token.
   */
  erc20?: readonly BufiGrantErc20Budget[]
  /**
   * The native token spend limit.
   */
  native?: BufiGrantSpendBudget
  /**
   * The gas spend limit.
   */
  gas?: BufiGrantSpendBudget
}

/**
 * The validity window of a BUFI grant, as unix timestamps in seconds.
 */
export interface BufiGrantExpiry {
  /**
   * The timestamp after which the session key becomes valid. Defaults to zero (immediately).
   */
  validAfter?: number
  /**
   * The timestamp at which the session key stops being valid.
   */
  validUntil: number
}

/**
 * The BUFI agentic wallet policy vocabulary: what a session key may call, how much it may spend, and for how long.
 */
export interface BufiGrant {
  /**
   * The contracts and selectors the session key may call.
   */
  scope: BufiGrantScope
  /**
   * The spend budget. Omit for no spend limits.
   */
  budget?: BufiGrantBudget
  /**
   * The validity window.
   */
  expiry: BufiGrantExpiry
  /**
   * A paymaster the session key must use. Omit for no paymaster requirement.
   */
  requiredPaymaster?: Address
}

/**
 * A session key together with its tag and permission updates, as seeded through `onInstall` or `addSessionKey`.
 */
export interface SessionKeyRegistration {
  /**
   * The session key address.
   */
  sessionKey: Address
  /**
   * An optional 32-byte tag identifying the key. Defaults to zero.
   */
  tag?: Hex
  /**
   * The ABI-encoded permission updates to apply to the key. See `buildBufiGrant`.
   */
  permissionUpdates: readonly Hex[]
}

/**
 * One (chainId, token, vault) entry of a BufiEarnModule config set. Mirrors `BufiEarnModule.ConfigInput`.
 */
export interface EarnConfigInput {
  /**
   * The chain the vault lives on.
   */
  chainId: bigint
  /**
   * The ERC-20 token to sweep.
   */
  token: Address
  /**
   * The ERC-4626 vault to deposit into.
   */
  vault: Address
}

/**
 * Parameters to create a BUFI session key account.
 */
export type ToBufiSessionKeyAccountParameters = {
  /**
   * The client instance.
   */
  client: Client
  /**
   * The address of the (deployed) modular smart contract account the session key belongs to.
   */
  account: Address
  /**
   * The session key that signs user operations on behalf of the account.
   */
  sessionKey: LocalAccount
  /**
   * The address of the session key plugin installed on the account.
   */
  plugin: Address
  /**
   * The stack deployment. Defaults to the canonical Circle deployment.
   */
  deployment?: StackDeployment
}

/**
 * BUFI session key account implementation.
 */
export type BufiSessionKeyAccountImplementation = SmartAccountImplementation<
  typeof entryPoint07Abi,
  '0.7',
  {
    abi: typeof entryPoint07Abi
    plugin: Address
    sessionKey: Address
  }
>

/**
 * Return type of the BUFI session key account.
 */
export type ToBufiSessionKeyAccountReturnType = Prettify<
  SmartAccount<BufiSessionKeyAccountImplementation>
>
