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

import { encodeFunctionData, toFunctionSelector } from 'viem'

import { MockPublicKey, MockRecipients } from '../../../../__mocks__'
import { encodeUpdateMultisigWeights } from '../../../../actions'

// Independently declared ABI fragment for the calldata assertion
const UPDATE_MULTISIG_WEIGHTS_ABI = [
  {
    type: 'function',
    name: 'updateMultisigWeights',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'ownersToUpdate', type: 'address[]' },
      { name: 'newWeightsToUpdate', type: 'uint256[]' },
      {
        name: 'publicKeyOwnersToUpdate',
        type: 'tuple[]',
        components: [
          { name: 'x', type: 'uint256' },
          { name: 'y', type: 'uint256' },
        ],
      },
      { name: 'pubicKeyNewWeightsToUpdate', type: 'uint256[]' },
      { name: 'newThresholdWeight', type: 'uint256' },
    ],
    outputs: [],
  },
] as const

describe('Actions > plugins > weightedMultisig > encodeUpdateMultisigWeights', () => {
  it('should encode address and public key owners with a new threshold', () => {
    const data = encodeUpdateMultisigWeights({
      owners: [{ address: MockRecipients[0], weight: 2n }],
      publicKeyOwners: [{ publicKey: MockPublicKey[0], weight: 3n }],
      thresholdWeight: 4n,
    })

    expect(data).toBe(
      encodeFunctionData({
        abi: UPDATE_MULTISIG_WEIGHTS_ABI,
        functionName: 'updateMultisigWeights',
        args: [
          [MockRecipients[0]],
          [2n],
          [{ x: MockPublicKey[0].x, y: MockPublicKey[0].y }],
          [3n],
          4n,
        ],
      }),
    )
    expect(data.slice(0, 10)).toBe(
      toFunctionSelector(
        'updateMultisigWeights(address[],uint256[],(uint256,uint256)[],uint256[],uint256)',
      ),
    )
  })

  it('should encode a threshold-only update', () => {
    expect(encodeUpdateMultisigWeights({ thresholdWeight: 2n })).toBe(
      encodeFunctionData({
        abi: UPDATE_MULTISIG_WEIGHTS_ABI,
        functionName: 'updateMultisigWeights',
        args: [[], [], [], [], 2n],
      }),
    )
  })
})
