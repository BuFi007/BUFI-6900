/*
 * Copyright (c) 2026, Circle Internet Group, Inc. All rights reserved.
 * Modifications Copyright (c) 2026 BUFI. Licensed under the Apache License, Version 2.0.
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

import {
  encodeAbiParameters,
  encodePacked,
  getContractAddress,
  keccak256,
  parseAbiParameters,
} from 'viem'

import { CIRCLE_CANONICAL_DEPLOYMENT, ERC1769_PROXY } from '../../constants'

import { getSalt } from './getSalt'
import { getSenderForContract } from './getSenderForContract'
import { getInitializeUpgradableMSCAData } from './initializeUpgradableMSCA'

import type { StackDeployment } from '../../types'
import type { Address, LocalAccount } from 'viem'
import type { WebAuthnAccount } from 'viem/account-abstraction'

/**
 * Computes the address of a contract.
 * @param owner - The owner.
 * @param deployment - The stack deployment (factory, implementation and ownership plugin) to compute against.
 * Defaults to the canonical Circle deployment. BUFI modification.
 * @returns The computed address.
 */
export function computeAddress(
  owner: WebAuthnAccount | LocalAccount,
  deployment: StackDeployment = CIRCLE_CANONICAL_DEPLOYMENT,
): Address {
  const sender = getSenderForContract(owner)
  const salt = getSalt()
  const initializeUpgradableMSCAData = getInitializeUpgradableMSCAData(
    owner,
    deployment,
  )

  const mixedSalt = keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }],
      [sender, salt],
    ),
  )
  const bytecode = encodePacked(
    ['bytes', 'bytes'],
    [
      ERC1769_PROXY.creationCode,
      encodeAbiParameters(parseAbiParameters('address, bytes'), [
        deployment.upgradableMsca,
        initializeUpgradableMSCAData,
      ]),
    ],
  )

  const address = getContractAddress({
    bytecode,
    from: deployment.upgradableMscaFactory,
    opcode: 'CREATE2',
    salt: mixedSalt,
  })

  return address
}
