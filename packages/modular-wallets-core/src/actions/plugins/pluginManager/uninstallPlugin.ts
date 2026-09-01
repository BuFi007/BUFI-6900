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

import { sendUserOperation } from 'viem/account-abstraction'

import { encodeUninstallPlugin } from './encodeUninstallPlugin'

import type { Address, Chain, Client, Hex, Transport } from 'viem'
import type {
  SendUserOperationParameters,
  SendUserOperationReturnType,
  SmartAccount,
} from 'viem/account-abstraction'

export interface UninstallPluginParameters
  extends Omit<SendUserOperationParameters, 'callData' | 'calls'> {
  /**
   * The plugin to uninstall.
   */
  plugin: Address
  /**
   * An optional, implementation-specific config. Defaults to empty.
   */
  config?: Hex
  /**
   * The data passed to the plugin's `onUninstall`. Defaults to empty.
   */
  pluginUninstallData?: Hex
}

/**
 * Uninstalls an ERC-6900 plugin from the account by sending an `uninstallPlugin` user operation. The encoded call is
 * submitted as the raw user operation calldata (see `installPlugin`).
 * @param client - Client to use.
 * @param params - Parameters to use. See {@link UninstallPluginParameters}.
 * @returns The user operation hash. See {@link SendUserOperationReturnType}.
 * @throws Error if neither the client nor the parameters carry an account.
 */
export async function uninstallPlugin(
  client: Client<Transport, Chain | undefined, SmartAccount | undefined>,
  params: UninstallPluginParameters,
): Promise<SendUserOperationReturnType> {
  const account = client.account ?? params.account
  if (!account) {
    throw new Error('Account is required')
  }

  const { plugin, config, pluginUninstallData, ...userOp } = params

  const call = encodeUninstallPlugin({
    account: account.address,
    plugin,
    config,
    pluginUninstallData,
  })

  return await sendUserOperation(client, {
    callData: call.data,
    ...userOp,
  } as SendUserOperationParameters)
}
