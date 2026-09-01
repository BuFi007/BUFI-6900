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

import {
  encodeAbiParameters,
  encodePacked,
  getContractAddress,
  keccak256,
  pad,
  parseAbiParameters,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { MockEoaAccount, MockSandboxDeployment } from '../../../__mocks__'
import {
  CIRCLE_CANONICAL_DEPLOYMENT,
  ERC1769_PROXY,
  FACTORY,
} from '../../../constants'
import {
  computeAddress,
  getInitializeUpgradableMSCAData,
  getInitializeUpgradableMSCAParams,
} from '../../../utils'

import type { LocalAccount } from 'viem'

let owner: LocalAccount

beforeAll(() => {
  owner = privateKeyToAccount(MockEoaAccount.privateKey)
})

describe('Utils > account > computeAddress (deployment)', () => {
  it('should default to the canonical deployment', () => {
    expect(computeAddress(owner)).toBe(
      computeAddress(owner, CIRCLE_CANONICAL_DEPLOYMENT),
    )
  })

  it('should compute a different address when the factory differs', () => {
    const deployment = {
      ...CIRCLE_CANONICAL_DEPLOYMENT,
      upgradableMscaFactory: MockSandboxDeployment.upgradableMscaFactory,
    }

    expect(computeAddress(owner, deployment)).not.toBe(computeAddress(owner))
  })

  it('should compute a different address when the implementation differs', () => {
    const deployment = {
      ...CIRCLE_CANONICAL_DEPLOYMENT,
      upgradableMsca: MockSandboxDeployment.upgradableMsca,
    }

    expect(computeAddress(owner, deployment)).not.toBe(computeAddress(owner))
  })

  it('should compute a different address when the ownership plugin differs', () => {
    const deployment = {
      ...CIRCLE_CANONICAL_DEPLOYMENT,
      weightedWebauthnMultisig: MockSandboxDeployment.weightedWebauthnMultisig,
    }

    expect(computeAddress(owner, deployment)).not.toBe(computeAddress(owner))
  })

  it('should match an independent CREATE2 computation for a sandbox deployment', () => {
    const deployment = MockSandboxDeployment
    const salt = pad('0x', { size: 32 })
    const mixedSalt = keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'bytes32' }],
        [pad(owner.address), salt],
      ),
    )
    const bytecode = encodePacked(
      ['bytes', 'bytes'],
      [
        ERC1769_PROXY.creationCode,
        encodeAbiParameters(parseAbiParameters('address, bytes'), [
          deployment.upgradableMsca,
          getInitializeUpgradableMSCAData(owner, deployment),
        ]),
      ],
    )
    const expected = getContractAddress({
      bytecode,
      from: deployment.upgradableMscaFactory,
      opcode: 'CREATE2',
      salt: mixedSalt,
    })

    expect(computeAddress(owner, deployment)).toBe(expected)
    expect(deployment.upgradableMscaFactory).not.toBe(FACTORY.address)
  })
})

describe('Utils > account > initializeUpgradableMSCA (deployment)', () => {
  it('should install the ownership plugin of the given deployment', () => {
    const data = getInitializeUpgradableMSCAData(owner, MockSandboxDeployment)
    const params = getInitializeUpgradableMSCAParams(
      owner,
      MockSandboxDeployment,
    )
    const plugin = MockSandboxDeployment.weightedWebauthnMultisig

    expect(data.toLowerCase()).toContain(plugin.address.slice(2).toLowerCase())
    expect(data).toContain(plugin.manifestHash.slice(2))
    expect(params.toLowerCase()).toContain(
      plugin.address.slice(2).toLowerCase(),
    )
    expect(params).toContain(plugin.manifestHash.slice(2))
    expect(data).not.toBe(getInitializeUpgradableMSCAData(owner))
    expect(params).not.toBe(getInitializeUpgradableMSCAParams(owner))
  })
})
