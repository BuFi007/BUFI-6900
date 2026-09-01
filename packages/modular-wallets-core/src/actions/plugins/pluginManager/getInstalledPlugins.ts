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

import { ACCOUNT_LOUPE_ABI } from '../../../abis'

import type { Address, Chain, Client, Transport } from 'viem'

export interface GetInstalledPluginsParameters {
  /**
   * The modular smart contract account to inspect.
   */
  account: Address
}

/**
 * Gets the plugins installed on the account through the ERC-6900 `IAccountLoupe`.
 *
 * This is the only source of truth for installed state: a built or submitted install intent must never be persisted
 * as an installed plugin until this read confirms it.
 * @param client - Client to use.
 * @param params - Parameters to use. See {@link GetInstalledPluginsParameters}.
 * @returns The installed plugin addresses.
 */
export async function getInstalledPlugins(
  client: Client<Transport, Chain | undefined>,
  params: GetInstalledPluginsParameters,
): Promise<readonly Address[]> {
  return await readContract(client, {
    address: params.account,
    abi: ACCOUNT_LOUPE_ABI,
    functionName: 'getInstalledPlugins',
  })
}
