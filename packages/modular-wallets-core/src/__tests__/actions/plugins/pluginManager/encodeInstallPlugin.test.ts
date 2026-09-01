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

import {
  MockAccountAddress,
  MockManifestHash,
  MockPluginAddress,
  MockSandboxDeployment,
} from '../../../../__mocks__'
import { encodeInstallPlugin, encodeUninstallPlugin } from '../../../../actions'

// Independently declared ABI fragments for the calldata assertions
const INSTALL_PLUGIN_ABI = [
  {
    type: 'function',
    name: 'installPlugin',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'plugin', type: 'address' },
      { name: 'manifestHash', type: 'bytes32' },
      { name: 'pluginInstallData', type: 'bytes' },
      {
        name: 'dependencies',
        type: 'tuple[]',
        components: [
          { name: 'plugin', type: 'address' },
          { name: 'functionId', type: 'uint8' },
        ],
      },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'uninstallPlugin',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'plugin', type: 'address' },
      { name: 'config', type: 'bytes' },
      { name: 'pluginUninstallData', type: 'bytes' },
    ],
    outputs: [],
  },
] as const

describe('Actions > plugins > pluginManager > encodeInstallPlugin', () => {
  it('should encode an execute-ready installPlugin call with dependencies', () => {
    const weighted = MockSandboxDeployment.weightedWebauthnMultisig.address
    const call = encodeInstallPlugin({
      account: MockAccountAddress,
      plugin: MockPluginAddress,
      manifestHash: MockManifestHash,
      pluginInstallData: '0x1234',
      dependencies: [
        { plugin: weighted, functionId: 1 },
        { plugin: weighted, functionId: 0 },
      ],
    })

    expect(call).toEqual({
      to: MockAccountAddress,
      value: 0n,
      data: encodeFunctionData({
        abi: INSTALL_PLUGIN_ABI,
        functionName: 'installPlugin',
        args: [
          MockPluginAddress,
          MockManifestHash,
          '0x1234',
          [
            { plugin: weighted, functionId: 1 },
            { plugin: weighted, functionId: 0 },
          ],
        ],
      }),
    })
    expect(call.data.slice(0, 10)).toBe(
      toFunctionSelector(
        'installPlugin(address,bytes32,bytes,(address,uint8)[])',
      ),
    )
  })

  it('should default to empty install data and no dependencies', () => {
    const call = encodeInstallPlugin({
      account: MockAccountAddress,
      plugin: MockPluginAddress,
      manifestHash: MockManifestHash,
    })

    expect(call.data).toBe(
      encodeFunctionData({
        abi: INSTALL_PLUGIN_ABI,
        functionName: 'installPlugin',
        args: [MockPluginAddress, MockManifestHash, '0x', []],
      }),
    )
  })
})

describe('Actions > plugins > pluginManager > encodeUninstallPlugin', () => {
  it('should encode an execute-ready uninstallPlugin call', () => {
    const call = encodeUninstallPlugin({
      account: MockAccountAddress,
      plugin: MockPluginAddress,
      config: '0xaa',
      pluginUninstallData: '0xbb',
    })

    expect(call).toEqual({
      to: MockAccountAddress,
      value: 0n,
      data: encodeFunctionData({
        abi: INSTALL_PLUGIN_ABI,
        functionName: 'uninstallPlugin',
        args: [MockPluginAddress, '0xaa', '0xbb'],
      }),
    })
    expect(call.data.slice(0, 10)).toBe(
      toFunctionSelector('uninstallPlugin(address,bytes,bytes)'),
    )
  })

  it('should default config and uninstall data to empty bytes', () => {
    const call = encodeUninstallPlugin({
      account: MockAccountAddress,
      plugin: MockPluginAddress,
    })

    expect(call.data).toBe(
      encodeFunctionData({
        abi: INSTALL_PLUGIN_ABI,
        functionName: 'uninstallPlugin',
        args: [MockPluginAddress, '0x', '0x'],
      }),
    )
  })
})
