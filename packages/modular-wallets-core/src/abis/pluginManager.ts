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

/**
 * The ERC-6900 v0.7 `IPluginManager` functions of the UpgradableMSCA.
 */
export const PLUGIN_MANAGER_ABI = [
  {
    inputs: [
      { internalType: 'address', name: 'plugin', type: 'address' },
      { internalType: 'bytes32', name: 'manifestHash', type: 'bytes32' },
      { internalType: 'bytes', name: 'pluginInstallData', type: 'bytes' },
      {
        components: [
          { internalType: 'address', name: 'plugin', type: 'address' },
          { internalType: 'uint8', name: 'functionId', type: 'uint8' },
        ],
        internalType: 'struct FunctionReference[]',
        name: 'dependencies',
        type: 'tuple[]',
      },
    ],
    name: 'installPlugin',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: 'plugin', type: 'address' },
      { internalType: 'bytes', name: 'config', type: 'bytes' },
      { internalType: 'bytes', name: 'pluginUninstallData', type: 'bytes' },
    ],
    name: 'uninstallPlugin',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const

/**
 * The ERC-6900 v0.7 `IAccountLoupe.getInstalledPlugins` function of the UpgradableMSCA.
 */
export const ACCOUNT_LOUPE_ABI = [
  {
    inputs: [],
    name: 'getInstalledPlugins',
    outputs: [
      { internalType: 'address[]', name: 'pluginAddresses', type: 'address[]' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
] as const

const MANIFEST_FUNCTION_COMPONENTS = [
  { internalType: 'uint8', name: 'functionType', type: 'uint8' },
  { internalType: 'uint8', name: 'functionId', type: 'uint8' },
  { internalType: 'uint256', name: 'dependencyIndex', type: 'uint256' },
] as const

const MANIFEST_ASSOCIATED_FUNCTION_COMPONENTS = [
  { internalType: 'bytes4', name: 'executionSelector', type: 'bytes4' },
  {
    components: MANIFEST_FUNCTION_COMPONENTS,
    internalType: 'struct ManifestFunction',
    name: 'associatedFunction',
    type: 'tuple',
  },
] as const

/**
 * The ERC-6900 v0.7 `PluginManifest` struct, as returned by `IPlugin.pluginManifest()`.
 */
export const PLUGIN_MANIFEST_ABI_PARAMS = [
  {
    components: [
      { internalType: 'bytes4[]', name: 'interfaceIds', type: 'bytes4[]' },
      {
        internalType: 'bytes4[]',
        name: 'dependencyInterfaceIds',
        type: 'bytes4[]',
      },
      {
        internalType: 'bytes4[]',
        name: 'executionFunctions',
        type: 'bytes4[]',
      },
      {
        internalType: 'bytes4[]',
        name: 'permittedExecutionSelectors',
        type: 'bytes4[]',
      },
      { internalType: 'bool', name: 'permitAnyExternalAddress', type: 'bool' },
      { internalType: 'bool', name: 'canSpendNativeToken', type: 'bool' },
      {
        components: [
          { internalType: 'address', name: 'externalAddress', type: 'address' },
          { internalType: 'bool', name: 'permitAnySelector', type: 'bool' },
          { internalType: 'bytes4[]', name: 'selectors', type: 'bytes4[]' },
        ],
        internalType: 'struct ManifestExternalCallPermission[]',
        name: 'permittedExternalCalls',
        type: 'tuple[]',
      },
      {
        components: MANIFEST_ASSOCIATED_FUNCTION_COMPONENTS,
        internalType: 'struct ManifestAssociatedFunction[]',
        name: 'userOpValidationFunctions',
        type: 'tuple[]',
      },
      {
        components: MANIFEST_ASSOCIATED_FUNCTION_COMPONENTS,
        internalType: 'struct ManifestAssociatedFunction[]',
        name: 'runtimeValidationFunctions',
        type: 'tuple[]',
      },
      {
        components: MANIFEST_ASSOCIATED_FUNCTION_COMPONENTS,
        internalType: 'struct ManifestAssociatedFunction[]',
        name: 'preUserOpValidationHooks',
        type: 'tuple[]',
      },
      {
        components: MANIFEST_ASSOCIATED_FUNCTION_COMPONENTS,
        internalType: 'struct ManifestAssociatedFunction[]',
        name: 'preRuntimeValidationHooks',
        type: 'tuple[]',
      },
      {
        components: [
          { internalType: 'bytes4', name: 'selector', type: 'bytes4' },
          {
            components: MANIFEST_FUNCTION_COMPONENTS,
            internalType: 'struct ManifestFunction',
            name: 'preExecHook',
            type: 'tuple',
          },
          {
            components: MANIFEST_FUNCTION_COMPONENTS,
            internalType: 'struct ManifestFunction',
            name: 'postExecHook',
            type: 'tuple',
          },
        ],
        internalType: 'struct ManifestExecutionHook[]',
        name: 'executionHooks',
        type: 'tuple[]',
      },
    ],
    internalType: 'struct PluginManifest',
    name: '',
    type: 'tuple',
  },
] as const

/**
 * The ERC-6900 v0.7 `IPlugin.pluginManifest` function.
 */
export const PLUGIN_MANIFEST_ABI = [
  {
    inputs: [],
    name: 'pluginManifest',
    outputs: PLUGIN_MANIFEST_ABI_PARAMS,
    stateMutability: 'pure',
    type: 'function',
  },
] as const
