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

/**
 * The Circle WeightedWebauthnMultisigPlugin `updateMultisigWeights` function.
 */
export const CIRCLE_PLUGIN_UPDATE_MULTISIG_WEIGHTS_ABI = [
  {
    inputs: [
      {
        internalType: 'address[]',
        name: 'ownersToUpdate',
        type: 'address[]',
      },
      {
        internalType: 'uint256[]',
        name: 'newWeightsToUpdate',
        type: 'uint256[]',
      },
      {
        components: [
          { internalType: 'uint256', name: 'x', type: 'uint256' },
          { internalType: 'uint256', name: 'y', type: 'uint256' },
        ],
        internalType: 'struct PublicKey[]',
        name: 'publicKeyOwnersToUpdate',
        type: 'tuple[]',
      },
      {
        internalType: 'uint256[]',
        name: 'pubicKeyNewWeightsToUpdate',
        type: 'uint256[]',
      },
      {
        internalType: 'uint256',
        name: 'newThresholdWeight',
        type: 'uint256',
      },
    ],
    name: 'updateMultisigWeights',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const
