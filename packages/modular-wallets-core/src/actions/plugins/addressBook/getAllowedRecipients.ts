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

import { ADDRESS_BOOK_PLUGIN_ABI } from '../../../abis'

import type { Address, Chain, Client, Transport } from 'viem'

export interface GetAllowedRecipientsParameters {
  /**
   * The ColdStorageAddressBookPlugin address.
   */
  plugin: Address
  /**
   * The modular smart contract account whose allowlist to read.
   */
  account: Address
}

/**
 * Gets the recipients the account may transfer tokens to.
 * @param client - Client to use.
 * @param params - Parameters to use. See {@link GetAllowedRecipientsParameters}.
 * @returns The allowed recipients.
 */
export async function getAllowedRecipients(
  client: Client<Transport, Chain | undefined>,
  params: GetAllowedRecipientsParameters,
): Promise<readonly Address[]> {
  return await readContract(client, {
    address: params.plugin,
    abi: ADDRESS_BOOK_PLUGIN_ABI,
    functionName: 'getAllowedRecipients',
    args: [params.account],
  })
}
