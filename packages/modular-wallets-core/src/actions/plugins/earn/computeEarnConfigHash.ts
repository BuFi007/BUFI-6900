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

import { encodeAbiParameters, keccak256 } from 'viem'

import { EARN_CONFIG_ABI_PARAMS } from '../../../abis'

import type { EarnConfigInput } from '../../../types'

/**
 * Computes a BufiEarnModule config hash: `uint256(keccak256(abi.encode(ConfigInput[] configs)))`.
 *
 * Byte-matches the hash `setConfig` derives on-chain, so install data can be built without an RPC read. The entries
 * are hashed in the order given; pass them in the same order they were (or will be) registered with `setConfig`.
 * @param configs - The (chainId, token, vault) entries. See {@link EarnConfigInput}.
 * @returns The config hash as a uint256.
 */
export function computeEarnConfigHash(
  configs: readonly EarnConfigInput[],
): bigint {
  return BigInt(
    keccak256(
      encodeAbiParameters(EARN_CONFIG_ABI_PARAMS, [
        configs.map((config) => ({
          chainId: config.chainId,
          token: config.token,
          vault: config.vault,
        })),
      ]),
    ),
  )
}
