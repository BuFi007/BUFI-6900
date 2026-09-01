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

import type { Address, Hex } from 'viem'

export interface EncodeAutoEarnParameters {
  /**
   * The ERC-20 token to sweep into its configured vault.
   */
  token: Address
  /**
   * The amount to deposit.
   */
  amountToSave: bigint
}

/**
 * Encodes the `autoEarn` call an authorized relayer sends TO THE ACCOUNT to sweep idle balance into the vault.
 * @param parameters - Parameters to use. See {@link EncodeAutoEarnParameters}.
 * @returns The encoded call data.
 */
export function encodeAutoEarn({
  token,
  amountToSave,
}: EncodeAutoEarnParameters): Hex {
  return encodeFunctionData({
    abi: EARN_MODULE_ABI,
    functionName: 'autoEarn',
    args: [token, amountToSave],
  })
}
