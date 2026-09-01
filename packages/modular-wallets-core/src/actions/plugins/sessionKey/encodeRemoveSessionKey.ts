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

import type { Address, Hex } from 'viem'

export interface EncodeRemoveSessionKeyParameters {
  /**
   * The session key to remove.
   */
  sessionKey: Address
  /**
   * The list predecessor of the key, as returned by `findPredecessor`.
   */
  predecessor: Hex
}

/**
 * Encodes a `removeSessionKey(sessionKey, predecessor)` call. Submit it as raw user operation calldata targeting the
 * account.
 * @param parameters - Parameters to use. See {@link EncodeRemoveSessionKeyParameters}.
 * @returns The encoded call data.
 */
export function encodeRemoveSessionKey({
  sessionKey,
  predecessor,
}: EncodeRemoveSessionKeyParameters): Hex {
  return encodeFunctionData({
    abi: SESSION_KEY_PLUGIN_ABI,
    functionName: 'removeSessionKey',
    args: [sessionKey, predecessor],
  })
}
