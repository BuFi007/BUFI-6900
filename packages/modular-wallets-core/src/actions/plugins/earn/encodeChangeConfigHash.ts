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
   * The modular smart contract account that adopts the config set.
   */
  account: Address
  /**
   * The config hash to adopt.
   */
  newConfigHash: bigint
}

/**
 * Encodes the `changeConfigHash` call through which the account adopts a different owner-registered config set.
 *
 * `changeConfigHash` is an execution function installed on the account, validated by the owners through the
 * module's user operation dependency slot. Submit `data` as raw user operation calldata targeting the account: a
 * call to the module itself is rejected by the account (`TargetIsPlugin`), and a self-call through `execute` re-enters
 * runtime validation, which the weighted multisig plugin fails closed.
 * @param parameters - Parameters to use. See {@link EncodeChangeConfigHashParameters}.
 * @returns The call to submit. See {@link EncodedCall}.
 */
export function encodeChangeConfigHash({
  account,
  newConfigHash,
}: EncodeChangeConfigHashParameters): EncodedCall {
  return {
    to: account,
    value: 0n,
    data: encodeFunctionData({
      abi: EARN_MODULE_ABI,
      functionName: 'changeConfigHash',
      args: [newConfigHash],
    }),
  }
}
