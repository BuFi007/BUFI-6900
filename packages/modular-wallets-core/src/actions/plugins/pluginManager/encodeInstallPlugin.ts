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

import { encodeFunctionData } from 'viem'

import { PLUGIN_MANAGER_ABI } from '../../../abis'

import type { EncodedCall, FunctionReference } from '../../../types'
import type { Address, Hex } from 'viem'

export interface EncodeInstallPluginParameters {
  /**
   * The modular smart contract account the plugin is installed on.
   */
  account: Address
  /**
   * The plugin to install.
   */
  plugin: Address
  /**
   * The keccak256 hash of the plugin manifest.
   */
  manifestHash: Hex
  /**
   * The data passed to the plugin's `onInstall`. Defaults to empty.
   */
  pluginInstallData?: Hex
  /**
   * The validation functions the plugin's manifest depends on, in manifest order. Defaults to none.
   */
  dependencies?: readonly FunctionReference[]
}

/**
 * Encodes an `installPlugin` call as an `execute`-ready call targeting the account itself.
 *
 * `installPlugin` is a native function of the UpgradableMSCA that accepts calls from the EntryPoint or from the
 * account itself, so the returned call can be sent as the single call of a user operation (viem wraps it in
 * `execute(account, 0, data)`), or its `data` can be used as raw user operation calldata.
 * @param parameters - Parameters to use. See {@link EncodeInstallPluginParameters}.
 * @returns The call to execute. See {@link EncodedCall}.
 */
export function encodeInstallPlugin({
  account,
  plugin,
  manifestHash,
  pluginInstallData = '0x',
  dependencies = [],
}: EncodeInstallPluginParameters): EncodedCall {
  return {
    to: account,
    value: 0n,
    data: encodeFunctionData({
      abi: PLUGIN_MANAGER_ABI,
      functionName: 'installPlugin',
      args: [
        plugin,
        manifestHash,
        pluginInstallData,
        dependencies.map((dependency) => ({
          plugin: dependency.plugin,
          functionId: dependency.functionId,
        })),
      ],
    }),
  }
}
