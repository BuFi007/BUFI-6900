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

import { CIRCLE_PLUGIN_UPDATE_MULTISIG_WEIGHTS_ABI } from '../../../abis'

import type { Address, Hex } from 'viem'
import type { PublicKey } from 'webauthn-p256'

export interface EncodeUpdateMultisigWeightsParameters {
  /**
   * The address owners to re-weight. Every owner must already exist with a non-zero weight.
   */
  owners?: readonly { address: Address; weight: bigint }[]
  /**
   * The WebAuthn (P-256) owners to re-weight. Every owner must already exist with a non-zero weight.
   */
  publicKeyOwners?: readonly { publicKey: PublicKey; weight: bigint }[]
  /**
   * The new threshold weight, or zero to leave it unchanged.
   */
  thresholdWeight: bigint
}

/**
 * Encodes an `updateMultisigWeights` call on the WeightedWebauthnMultisigPlugin. Send it to the account itself.
 * @param parameters - Parameters to use. See {@link EncodeUpdateMultisigWeightsParameters}.
 * @returns The encoded call data.
 */
export function encodeUpdateMultisigWeights({
  owners = [],
  publicKeyOwners = [],
  thresholdWeight,
}: EncodeUpdateMultisigWeightsParameters): Hex {
  return encodeFunctionData({
    abi: CIRCLE_PLUGIN_UPDATE_MULTISIG_WEIGHTS_ABI,
    functionName: 'updateMultisigWeights',
    args: [
      owners.map((owner) => owner.address),
      owners.map((owner) => owner.weight),
      publicKeyOwners.map((owner) => ({
        x: owner.publicKey.x,
        y: owner.publicKey.y,
      })),
      publicKeyOwners.map((owner) => owner.weight),
      thresholdWeight,
    ],
  })
}
