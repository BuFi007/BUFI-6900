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

import { encodeAbiParameters, zeroHash } from 'viem'

import { SESSION_KEY_INSTALL_DATA_ABI_PARAMS } from '../../../abis'

import type { SessionKeyRegistration } from '../../../types'
import type { Hex } from 'viem'

/**
 * Encodes the session key plugin `onInstall` data:
 * `abi.encode(address[] sessionKeys, bytes32[] tags, bytes[][] permissionUpdates)`.
 *
 * Seeding keys at install time saves one user operation per key on the agent face; an empty list is valid.
 * @param registrations - The keys to register at install. See {@link SessionKeyRegistration}.
 * @returns The encoded install data.
 */
export function encodeSessionKeyInstallData(
  registrations: readonly SessionKeyRegistration[],
): Hex {
  return encodeAbiParameters(SESSION_KEY_INSTALL_DATA_ABI_PARAMS, [
    registrations.map((registration) => registration.sessionKey),
    registrations.map((registration) => registration.tag ?? zeroHash),
    registrations.map((registration) => registration.permissionUpdates),
  ])
}
