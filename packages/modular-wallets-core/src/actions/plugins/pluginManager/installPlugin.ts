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

import { encodeInstallPlugin } from './encodeInstallPlugin'

import type { FunctionReference } from '../../../types'
import type { Address, Chain, Client, Hex, Transport } from 'viem'
import type {
  SendUserOperationParameters,
  SendUserOperationReturnType,
  SmartAccount,
} from 'viem/account-abstraction'

export interface InstallPluginParameters
  extends Omit<SendUserOperationParameters, 'callData' | 'calls'> {
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
 * Installs an ERC-6900 plugin on the account by sending an `installPlugin` user operation.
 *
 * Send exactly one plugin install per user operation. Installing a plugin whose manifest depends on the ownership
 * plugin in the same user operation that re-weights the owners is not supported by the Circle stack.
 * @param client - Client to use.
 * @param params - Parameters to use. See {@link InstallPluginParameters}.
 * @returns The user operation hash. See {@link SendUserOperationReturnType}.
 * @throws Error if neither the client nor the parameters carry an account.
 */
export async function installPlugin(
  client: Client<Transport, Chain | undefined, SmartAccount | undefined>,
  params: InstallPluginParameters,
): Promise<SendUserOperationReturnType> {
  const account = client.account ?? params.account
  if (!account) {
    throw new Error('Account is required')
  }

  const { plugin, manifestHash, pluginInstallData, dependencies, ...userOp } =
    params

  const call = encodeInstallPlugin({
    account: account.address,
    plugin,
    manifestHash,
    pluginInstallData,
    dependencies,
  })

  return await sendUserOperation(client, {
    calls: [call],
    ...userOp,
  } as SendUserOperationParameters)
}
