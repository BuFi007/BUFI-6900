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

import { SESSION_KEY_PLUGIN_ABI } from '../../../abis'

import type { Call } from '../../../types'
import type { Address, Hex } from 'viem'

/**
 * Encodes an `executeWithSessionKey(calls, sessionKey)` call: the user operation calldata a session key submits.
 *
 * The session key address travels inside the calldata so the plugin can validate the signature and enforce the
 * key's permissions over the same calls it executes.
 * @param calls - The calls to execute. See {@link Call}.
 * @param sessionKey - The session key that signs the user operation.
 * @returns The encoded call data.
 */
export function encodeExecuteWithSessionKey(
  calls: readonly Call[],
  sessionKey: Address,
): Hex {
  return encodeFunctionData({
    abi: SESSION_KEY_PLUGIN_ABI,
    functionName: 'executeWithSessionKey',
    args: [
      calls.map((call) => ({
        target: call.target,
        value: call.value,
        data: call.data,
      })),
      sessionKey,
    ],
  })
}
