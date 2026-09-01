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

import { EARN_MODULE_ABI } from '../../../abis'

import type { Address, Chain, Client, Transport } from 'viem'

export interface GetEarnConfigsParameters {
  /**
   * The BufiEarnModule address.
   */
  plugin: Address
  /**
   * The modular smart contract account whose adopted config to read.
   */
  account: Address
}

/**
 * Gets the (token, vault) pairs the account's adopted config set defines on the current chain.
 * @param client - Client to use.
 * @param params - Parameters to use. See {@link GetEarnConfigsParameters}.
 * @returns The configured token to vault pairs; empty when the module is not initialized for the account.
 */
export async function getEarnConfigs(
  client: Client<Transport, Chain | undefined>,
  params: GetEarnConfigsParameters,
): Promise<readonly { token: Address; vault: Address }[]> {
  return await readContract(client, {
    address: params.plugin,
    abi: EARN_MODULE_ABI,
    functionName: 'getAllConfigs',
    args: [params.account],
  })
}
