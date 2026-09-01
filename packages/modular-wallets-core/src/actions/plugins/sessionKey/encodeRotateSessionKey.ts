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

export interface EncodeRotateSessionKeyParameters {
  /**
   * The session key to rotate away.
   */
  oldSessionKey: Address
  /**
   * The list predecessor of the old key, as returned by `findPredecessor`.
   */
  predecessor: Hex
  /**
   * The session key that inherits the registration and permissions.
   */
  newSessionKey: Address
}

/**
 * Encodes a `rotateSessionKey(oldSessionKey, predecessor, newSessionKey)` call. Submit it as raw user operation
 * calldata targeting the account.
 * @param parameters - Parameters to use. See {@link EncodeRotateSessionKeyParameters}.
 * @returns The encoded call data.
 */
export function encodeRotateSessionKey({
  oldSessionKey,
  predecessor,
  newSessionKey,
}: EncodeRotateSessionKeyParameters): Hex {
  return encodeFunctionData({
    abi: SESSION_KEY_PLUGIN_ABI,
    functionName: 'rotateSessionKey',
    args: [oldSessionKey, predecessor, newSessionKey],
  })
}
