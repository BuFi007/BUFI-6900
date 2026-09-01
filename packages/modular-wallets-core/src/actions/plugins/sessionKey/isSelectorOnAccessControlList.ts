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

import type { Address, Chain, Client, Transport, Hex } from 'viem'

export interface IsSelectorOnAccessControlListParameters {
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
  /**
   * The target contract.
   */
  targetAddress: Address
  /**
   * The 4-byte function selector.
   */
  selector: Hex
}

/**
 * Checks whether a function selector of a target contract is on the access control list of a session key.
 * @param client - Client to use.
 * @param params - Parameters to use. See {@link IsSelectorOnAccessControlListParameters}.
 * @returns True if the selector is on the list.
 */
export async function isSelectorOnAccessControlList(
  client: Client<Transport, Chain | undefined>,
  params: IsSelectorOnAccessControlListParameters,
): Promise<boolean> {
  return await readContract(client, {
    address: params.plugin,
    abi: SESSION_KEY_PLUGIN_ABI,
    functionName: 'isSelectorOnAccessControlList',
    args: [
      params.account,
      params.sessionKey,
      params.targetAddress,
      params.selector,
    ],
  })
}
