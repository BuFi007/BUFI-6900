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

import { encodeAbiParameters } from 'viem'

import { EARN_MODULE_INSTALL_DATA_ABI_PARAMS } from '../../../abis'

import type { Hex } from 'viem'

/**
 * Encodes the BufiEarnModule `onInstall` data: `abi.encode(uint256 configHash)`.
 * @param configHash - The config hash the account adopts. Must be non-zero.
 * @returns The encoded install data.
 * @throws Error if the config hash is zero.
 */
export function encodeEarnModuleInstallData(configHash: bigint): Hex {
  if (configHash <= 0n) {
    throw new Error('Earn module config hash must be a non-zero uint256.')
  }

  return encodeAbiParameters(EARN_MODULE_INSTALL_DATA_ABI_PARAMS, [configHash])
}
