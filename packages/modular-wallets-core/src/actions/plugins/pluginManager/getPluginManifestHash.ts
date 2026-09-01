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

import { encodeAbiParameters, keccak256 } from 'viem'
import { readContract } from 'viem/actions'

import { PLUGIN_MANIFEST_ABI, PLUGIN_MANIFEST_ABI_PARAMS } from '../../../abis'

import type { Address, Chain, Client, Hex, Transport } from 'viem'

/**
 * A decoded ERC-6900 v0.7 `PluginManifest`, as returned by `IPlugin.pluginManifest()`.
 */
export type PluginManifest = {
  interfaceIds: readonly Hex[]
  dependencyInterfaceIds: readonly Hex[]
  executionFunctions: readonly Hex[]
  permittedExecutionSelectors: readonly Hex[]
  permitAnyExternalAddress: boolean
  canSpendNativeToken: boolean
  permittedExternalCalls: readonly {
    externalAddress: Address
    permitAnySelector: boolean
    selectors: readonly Hex[]
  }[]
  userOpValidationFunctions: readonly ManifestAssociatedFunction[]
  runtimeValidationFunctions: readonly ManifestAssociatedFunction[]
  preUserOpValidationHooks: readonly ManifestAssociatedFunction[]
  preRuntimeValidationHooks: readonly ManifestAssociatedFunction[]
  executionHooks: readonly {
    selector: Hex
    preExecHook: ManifestFunction
    postExecHook: ManifestFunction
  }[]
}

/**
 * A decoded ERC-6900 v0.7 `ManifestFunction`.
 */
export type ManifestFunction = {
  functionType: number
  functionId: number
  dependencyIndex: bigint
}

/**
 * A decoded ERC-6900 v0.7 `ManifestAssociatedFunction`.
 */
export type ManifestAssociatedFunction = {
  executionSelector: Hex
  associatedFunction: ManifestFunction
}

export interface GetPluginManifestHashParameters {
  /**
   * The plugin whose manifest to hash.
   */
  plugin: Address
}

/**
 * Hashes a plugin manifest the way the PluginManager verifies it: `keccak256(abi.encode(manifest))`.
 * @param manifest - The manifest. See {@link PluginManifest}.
 * @returns The manifest hash.
 */
export function hashPluginManifest(manifest: PluginManifest): Hex {
  return keccak256(encodeAbiParameters(PLUGIN_MANIFEST_ABI_PARAMS, [manifest]))
}

/**
 * Reads a plugin's manifest and returns its hash, the value `installPlugin` expects as `manifestHash`.
 *
 * Use it to derive the manifest hash of a freshly deployed plugin (for example on a sandbox stack) instead of
 * hard-coding it.
 * @param client - Client to use.
 * @param params - Parameters to use. See {@link GetPluginManifestHashParameters}.
 * @returns The manifest hash.
 */
export async function getPluginManifestHash(
  client: Client<Transport, Chain | undefined>,
  params: GetPluginManifestHashParameters,
): Promise<Hex> {
  const manifest = await readContract(client, {
    address: params.plugin,
    abi: PLUGIN_MANIFEST_ABI,
    functionName: 'pluginManifest',
  })

  return hashPluginManifest(manifest)
}
