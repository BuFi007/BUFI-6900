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

import { hashTypedData, pad } from 'viem'

import {
  MockAccountAddress,
  MockSandboxDeployment,
  MockSignParams,
} from '../../../__mocks__'
import {
  CIRCLE_CANONICAL_DEPLOYMENT,
  CIRCLE_WEIGHTED_WEB_AUTHN_MULTISIG_PLUGIN,
  REPLAY_SAFE_HASH_V1,
} from '../../../constants'
import { AccountType } from '../../../types'
import { toReplaySafeHash } from '../../../utils'

import type { Address, Hash } from 'viem'

/**
 * Independent EIP-712 computation of the replay-safe hash through viem's `hashTypedData`.
 * @param address - The account.
 * @param chainId - The chain id.
 * @param hash - The hash to wrap.
 * @param verifyingContract - The weighted multisig plugin.
 * @returns The expected replay-safe hash.
 */
function expectedReplaySafeHash(
  address: Address,
  chainId: number,
  hash: Hash,
  verifyingContract: Address,
): Hash {
  return hashTypedData({
    domain: {
      name: REPLAY_SAFE_HASH_V1.name,
      version: REPLAY_SAFE_HASH_V1.version,
      chainId,
      verifyingContract,
      salt: pad(address, { dir: 'right' }),
    },
    types: {
      CircleWeightedWebauthnMultisigMessage: [
        { name: 'hash', type: 'bytes32' },
      ],
    },
    primaryType: 'CircleWeightedWebauthnMultisigMessage',
    message: { hash },
  })
}

describe('Utils > signature > toReplaySafeHash', () => {
  const chainId = 11_155_111
  const hash = MockSignParams[AccountType.Local].hash

  it('should default to the canonical weighted multisig plugin as verifying contract', () => {
    const result = toReplaySafeHash({
      address: MockAccountAddress,
      chainId,
      hash,
    })

    expect(result).toBe(
      expectedReplaySafeHash(
        MockAccountAddress,
        chainId,
        hash,
        CIRCLE_WEIGHTED_WEB_AUTHN_MULTISIG_PLUGIN.address,
      ),
    )
    expect(result).toBe(
      toReplaySafeHash({
        address: MockAccountAddress,
        chainId,
        hash,
        deployment: CIRCLE_CANONICAL_DEPLOYMENT,
      }),
    )
  })

  it('should bind the hash to a redeployed weighted multisig plugin', () => {
    const result = toReplaySafeHash({
      address: MockAccountAddress,
      chainId,
      hash,
      deployment: MockSandboxDeployment,
    })

    expect(result).toBe(
      expectedReplaySafeHash(
        MockAccountAddress,
        chainId,
        hash,
        MockSandboxDeployment.weightedWebauthnMultisig.address,
      ),
    )
    expect(result).not.toBe(
      toReplaySafeHash({ address: MockAccountAddress, chainId, hash }),
    )
  })
})
