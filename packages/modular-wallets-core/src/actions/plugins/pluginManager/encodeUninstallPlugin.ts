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

import type { EncodedCall } from '../../../types'
import type { Address, Hex } from 'viem'

export interface EncodeUninstallPluginParameters {
  /**
   * The modular smart contract account the plugin is uninstalled from.
   */
  account: Address
  /**
   * The plugin to uninstall.
   */
  plugin: Address
  /**
   * An optional, implementation-specific config (the ABI-encoded manifest for the Circle MSCA when the plugin's
   * `pluginManifest()` should not be trusted). Defaults to empty.
   */
  config?: Hex
  /**
   * The data passed to the plugin's `onUninstall`. Defaults to empty.
   */
  pluginUninstallData?: Hex
}

/**
 * Encodes an `uninstallPlugin` call as an `execute`-ready call targeting the account itself.
 * @param parameters - Parameters to use. See {@link EncodeUninstallPluginParameters}.
 * @returns The call to execute. See {@link EncodedCall}.
 */
export function encodeUninstallPlugin({
  account,
  plugin,
  config = '0x',
  pluginUninstallData = '0x',
}: EncodeUninstallPluginParameters): EncodedCall {
  return {
    to: account,
    value: 0n,
    data: encodeFunctionData({
      abi: PLUGIN_MANAGER_ABI,
      functionName: 'uninstallPlugin',
      args: [plugin, config, pluginUninstallData],
    }),
  }
}
