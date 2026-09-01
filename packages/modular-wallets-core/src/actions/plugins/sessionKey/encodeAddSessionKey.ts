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

import { encodeFunctionData, zeroHash } from 'viem'

import { SESSION_KEY_PLUGIN_ABI } from '../../../abis'

import type { SessionKeyRegistration } from '../../../types'
import type { Hex } from 'viem'

/**
 * Encodes an `addSessionKey(sessionKey, tag, permissionUpdates)` call. Send it to the account itself; it is validated
 * by the owners. Build `permissionUpdates` with `buildBufiGrant` or the individual permission update encoders.
 * @param parameters - The registration. See {@link SessionKeyRegistration}.
 * @returns The encoded call data.
 */
export function encodeAddSessionKey({
  sessionKey,
  tag = zeroHash,
  permissionUpdates,
}: SessionKeyRegistration): Hex {
  return encodeFunctionData({
    abi: SESSION_KEY_PLUGIN_ABI,
    functionName: 'addSessionKey',
    args: [sessionKey, tag, permissionUpdates],
  })
}
