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
  MockSandboxDeployment,
  MockSandboxDeploymentJson,
} from '../../../__mocks__'
import { toStackDeployment } from '../../../utils'

describe('Utils > deployment > toStackDeployment', () => {
  it('should load a sandbox deployment file', () => {
    expect(toStackDeployment(MockSandboxDeploymentJson)).toEqual(
      MockSandboxDeployment,
    )
  })

  it('should omit optional plugins that are null or absent', () => {
    const {
      paymaster: _paymaster,
      tokens: _tokens,
      ...json
    } = MockSandboxDeploymentJson
    const deployment = toStackDeployment({
      ...json,
      plugins: { ...json.plugins, bufiSessionKey: null },
    })

    expect(deployment.bufiSessionKey).toBeUndefined()
    expect(deployment.bufiEarnModule).toBeUndefined()
    expect(deployment.paymaster).toBeUndefined()
    expect(deployment.tokens).toBeUndefined()
    expect(deployment).toEqual({
      chainId: 31337,
      entryPoint: MockSandboxDeployment.entryPoint,
      upgradableMscaFactory: MockSandboxDeployment.upgradableMscaFactory,
      upgradableMsca: MockSandboxDeployment.upgradableMsca,
      pluginManager: MockSandboxDeployment.pluginManager,
      weightedWebauthnMultisig: MockSandboxDeployment.weightedWebauthnMultisig,
      coldStorageAddressBook: MockSandboxDeployment.coldStorageAddressBook,
    })
  })

  it('should accept a null paymaster and a missing chain id', () => {
    const { chainId: _chainId, ...json } = MockSandboxDeploymentJson
    const deployment = toStackDeployment({ ...json, paymaster: null })

    expect(deployment.chainId).toBeUndefined()
    expect(deployment.paymaster).toBeUndefined()
  })

  it('should load the earn module when present', () => {
    const deployment = toStackDeployment({
      ...MockSandboxDeploymentJson,
      plugins: {
        ...MockSandboxDeploymentJson.plugins,
        bufiEarnModule: {
          address: '0x8A791620dd6260079BF849Dc5567aDC3F2FdC318',
          manifestHash: `0x${'44'.repeat(32)}`,
        },
      },
    })

    expect(deployment.bufiEarnModule).toEqual({
      address: '0x8A791620dd6260079BF849Dc5567aDC3F2FdC318',
      manifestHash: `0x${'44'.repeat(32)}`,
    })
  })

  it.each([
    ['a non-object', 'not json', 'expected a JSON object'],
    ['a null value', null, 'expected a JSON object'],
    [
      'a negative chain id',
      { ...MockSandboxDeploymentJson, chainId: -1 },
      '"chainId" must be a positive integer',
    ],
    [
      'a missing entry point',
      { ...MockSandboxDeploymentJson, entryPoint: undefined },
      '"entryPoint" must be a 20-byte hex address',
    ],
    [
      'a malformed factory address',
      { ...MockSandboxDeploymentJson, upgradableMscaFactory: '0x1234' },
      '"upgradableMscaFactory" must be a 20-byte hex address',
    ],
    [
      'missing plugins',
      { ...MockSandboxDeploymentJson, plugins: undefined },
      '"plugins" must be an object',
    ],
    [
      'a missing required plugin',
      {
        ...MockSandboxDeploymentJson,
        plugins: {
          ...MockSandboxDeploymentJson.plugins,
          coldStorageAddressBook: null,
        },
      },
      '"plugins.coldStorageAddressBook" must be an object',
    ],
    [
      'a malformed manifest hash',
      {
        ...MockSandboxDeploymentJson,
        plugins: {
          ...MockSandboxDeploymentJson.plugins,
          weightedWebauthnMultisig: {
            address: MockSandboxDeployment.weightedWebauthnMultisig.address,
            manifestHash: '0xabcd',
          },
        },
      },
      '"plugins.weightedWebauthnMultisig.manifestHash" must be a 32-byte hex string',
    ],
    [
      'a malformed optional plugin',
      {
        ...MockSandboxDeploymentJson,
        plugins: {
          ...MockSandboxDeploymentJson.plugins,
          bufiSessionKey: {
            address: 'nope',
            manifestHash: `0x${'33'.repeat(32)}`,
          },
        },
      },
      '"plugins.bufiSessionKey.address" must be a 20-byte hex address',
    ],
    [
      'a malformed paymaster',
      { ...MockSandboxDeploymentJson, paymaster: 'nope' },
      '"paymaster" must be an object or null',
    ],
    [
      'a paymaster without address',
      { ...MockSandboxDeploymentJson, paymaster: { signer: '0x' } },
      '"paymaster.address" must be a 20-byte hex address',
    ],
    [
      'malformed tokens',
      { ...MockSandboxDeploymentJson, tokens: 'usdc' },
      '"tokens" must be an object',
    ],
    [
      'a malformed token address',
      { ...MockSandboxDeploymentJson, tokens: { usdc: '0x00' } },
      '"tokens.usdc" must be a 20-byte hex address',
    ],
  ])('should reject %s', (_description, json, message) => {
    expect(() => toStackDeployment(json)).toThrow(message)
  })
})
