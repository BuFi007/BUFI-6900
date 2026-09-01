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

import { readContract } from 'viem/actions'

import { SESSION_KEY_PLUGIN_ABI } from '../../../abis'

import type { SpendLimitInfo } from '../../../types'
import type { Address, Chain, Client, Transport } from 'viem'

export interface GetGasSpendLimitParameters {
  /**
   * The session key plugin address.
   */
  plugin: Address
  /**
   * The modular smart contract account.
   */
  account: Address
  /**
   * The session key.
   */
  sessionKey: Address
}

/**
 * Gets the gas spend limit of a session key.
 * @param client - Client to use.
 * @param params - Parameters to use. See {@link GetGasSpendLimitParameters}.
 * @returns The spend limit state and whether `resetSessionKeyGasLimitTimestamp` must be called before the key can be used.
 */
export async function getGasSpendLimit(
  client: Client<Transport, Chain | undefined>,
  params: GetGasSpendLimitParameters,
): Promise<{ info: SpendLimitInfo; shouldReset: boolean }> {
  const [info, shouldReset] = await readContract(client, {
    address: params.plugin,
    abi: SESSION_KEY_PLUGIN_ABI,
    functionName: 'getGasSpendLimit',
    args: [params.account, params.sessionKey],
  })

  return { info, shouldReset }
}
