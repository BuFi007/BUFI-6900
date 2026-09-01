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

import type { Address, Chain, Client, Transport } from 'viem'

export interface GetKeyTimeRangeParameters {
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
 * Gets the time range during which a session key is valid.
 * @param client - Client to use.
 * @param params - Parameters to use. See {@link GetKeyTimeRangeParameters}.
 * @returns The validity window as unix timestamps in seconds (zero means unbounded).
 */
export async function getKeyTimeRange(
  client: Client<Transport, Chain | undefined>,
  params: GetKeyTimeRangeParameters,
): Promise<{ validAfter: number; validUntil: number }> {
  const [validAfter, validUntil] = await readContract(client, {
    address: params.plugin,
    abi: SESSION_KEY_PLUGIN_ABI,
    functionName: 'getKeyTimeRange',
    args: [params.account, params.sessionKey],
  })

  return { validAfter, validUntil }
}
