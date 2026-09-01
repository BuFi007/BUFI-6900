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

import { EARN_MODULE_ABI } from '../../../abis'

import type { EncodedCall } from '../../../types'
import type { Address } from 'viem'

export interface EncodeChangeConfigHashParameters {
  /**
   * The BufiEarnModule address.
   */
  plugin: Address
  /**
   * The config hash to adopt.
   */
  newConfigHash: bigint
}

/**
 * Encodes the `changeConfigHash` call the ACCOUNT sends to the module (an owner-signed user operation) to adopt a
 * different config set. `changeConfigHash` is not an installed execution function, so the call targets the module.
 * @param parameters - Parameters to use. See {@link EncodeChangeConfigHashParameters}.
 * @returns The call to execute. See {@link EncodedCall}.
 */
export function encodeChangeConfigHash({
  plugin,
  newConfigHash,
}: EncodeChangeConfigHashParameters): EncodedCall {
  return {
    to: plugin,
    value: 0n,
    data: encodeFunctionData({
      abi: EARN_MODULE_ABI,
      functionName: 'changeConfigHash',
      args: [newConfigHash],
    }),
  }
}
