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

import { createClient, encodeAbiParameters, keccak256 } from 'viem'
import * as viemActions from 'viem/actions'
import { sepolia } from 'viem/chains'

import {
  MockAccountAddress,
  MockPluginAddress,
  toModularTransport,
} from '../../../../__mocks__'
import { ACCOUNT_LOUPE_ABI, PLUGIN_MANIFEST_ABI } from '../../../../abis'
import {
  getInstalledPlugins,
  getPluginManifestHash,
  hashPluginManifest,
} from '../../../../actions'
import { AccountType } from '../../../../types'

import type { PluginManifest } from '../../../../actions'

const client = createClient({
  transport: toModularTransport({ accountType: AccountType.Local }),
  chain: sepolia,
})

/**
 * The manifest of the BufiEarnModule, transcribed from the contract: one execution function with a SELF runtime
 * validation, permitAnyExternalAddress set.
 */
const EarnManifest: PluginManifest = {
  interfaceIds: [],
  dependencyInterfaceIds: [],
  executionFunctions: ['0x3c8e0d6d'],
  permittedExecutionSelectors: [],
  permitAnyExternalAddress: true,
  canSpendNativeToken: false,
  permittedExternalCalls: [],
  userOpValidationFunctions: [],
  runtimeValidationFunctions: [
    {
      executionSelector: '0x3c8e0d6d',
      associatedFunction: {
        functionType: 1,
        functionId: 0,
        dependencyIndex: 0n,
      },
    },
  ],
  preUserOpValidationHooks: [],
  preRuntimeValidationHooks: [],
  executionHooks: [],
}

afterEach(() => {
  jest.restoreAllMocks()
})

describe('Actions > plugins > pluginManager > getInstalledPlugins', () => {
  it('should read the installed plugins through the account loupe', async () => {
    const readContract = jest
      .spyOn(viemActions, 'readContract')
      .mockResolvedValue([MockPluginAddress] as never)

    const result = await getInstalledPlugins(client, {
      account: MockAccountAddress,
    })

    expect(readContract).toHaveBeenCalledWith(client, {
      address: MockAccountAddress,
      abi: ACCOUNT_LOUPE_ABI,
      functionName: 'getInstalledPlugins',
    })
    expect(result).toEqual([MockPluginAddress])
  })
})

describe('Actions > plugins > pluginManager > hashPluginManifest', () => {
  it('should hash the manifest as keccak256(abi.encode(manifest))', () => {
    // Independently encoded with the tuple layout of PluginManifest.sol
    const expected = keccak256(
      encodeAbiParameters(
        [
          {
            type: 'tuple',
            components: [
              { type: 'bytes4[]' },
              { type: 'bytes4[]' },
              { type: 'bytes4[]' },
              { type: 'bytes4[]' },
              { type: 'bool' },
              { type: 'bool' },
              {
                type: 'tuple[]',
                components: [
                  { type: 'address' },
                  { type: 'bool' },
                  { type: 'bytes4[]' },
                ],
              },
              {
                type: 'tuple[]',
                components: [
                  { type: 'bytes4' },
                  {
                    type: 'tuple',
                    components: [
                      { type: 'uint8' },
                      { type: 'uint8' },
                      { type: 'uint256' },
                    ],
                  },
                ],
              },
              {
                type: 'tuple[]',
                components: [
                  { type: 'bytes4' },
                  {
                    type: 'tuple',
                    components: [
                      { type: 'uint8' },
                      { type: 'uint8' },
                      { type: 'uint256' },
                    ],
                  },
                ],
              },
              {
                type: 'tuple[]',
                components: [
                  { type: 'bytes4' },
                  {
                    type: 'tuple',
                    components: [
                      { type: 'uint8' },
                      { type: 'uint8' },
                      { type: 'uint256' },
                    ],
                  },
                ],
              },
              {
                type: 'tuple[]',
                components: [
                  { type: 'bytes4' },
                  {
                    type: 'tuple',
                    components: [
                      { type: 'uint8' },
                      { type: 'uint8' },
                      { type: 'uint256' },
                    ],
                  },
                ],
              },
              {
                type: 'tuple[]',
                components: [
                  { type: 'bytes4' },
                  {
                    type: 'tuple',
                    components: [
                      { type: 'uint8' },
                      { type: 'uint8' },
                      { type: 'uint256' },
                    ],
                  },
                  {
                    type: 'tuple',
                    components: [
                      { type: 'uint8' },
                      { type: 'uint8' },
                      { type: 'uint256' },
                    ],
                  },
                ],
              },
            ],
          },
        ],
        [
          [
            [],
            [],
            ['0x3c8e0d6d'],
            [],
            true,
            false,
            [],
            [],
            [['0x3c8e0d6d', [1, 0, 0n]]],
            [],
            [],
            [],
          ],
        ],
      ),
    )

    expect(hashPluginManifest(EarnManifest)).toBe(expected)
  })

  it('should change when any manifest field changes', () => {
    expect(
      hashPluginManifest({ ...EarnManifest, canSpendNativeToken: true }),
    ).not.toBe(hashPluginManifest(EarnManifest))
  })
})

describe('Actions > plugins > pluginManager > getPluginManifestHash', () => {
  it('should read the manifest from the plugin and hash it', async () => {
    const readContract = jest
      .spyOn(viemActions, 'readContract')
      .mockResolvedValue(EarnManifest)

    const result = await getPluginManifestHash(client, {
      plugin: MockPluginAddress,
    })

    expect(readContract).toHaveBeenCalledWith(client, {
      address: MockPluginAddress,
      abi: PLUGIN_MANIFEST_ABI,
      functionName: 'pluginManifest',
    })
    expect(result).toBe(hashPluginManifest(EarnManifest))
  })
})
