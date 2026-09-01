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
  createClient,
  encodeAbiParameters,
  encodeFunctionData,
  toFunctionSelector,
} from 'viem'
import * as viemActions from 'viem/actions'
import { sepolia } from 'viem/chains'

import {
  MockAccountAddress,
  MockPluginAddress,
  MockSandboxDeployment,
  MockTokenAddress,
  MockVaultAddress,
  toModularTransport,
} from '../../../../__mocks__'
import { EARN_MODULE_ABI } from '../../../../abis'
import {
  computeEarnConfigHash,
  encodeAutoEarn,
  encodeChangeConfigHash,
  encodeEarnModuleInstallData,
  encodeInstallEarnModule,
  encodeInstallPlugin,
  getEarnConfigs,
} from '../../../../actions'
import { AccountType } from '../../../../types'

// Independently declared ABI fragments for the calldata assertions
const EARN_ABI = [
  {
    type: 'function',
    name: 'autoEarn',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'amountToSave', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'changeConfigHash',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'newConfigHash', type: 'uint256' }],
    outputs: [],
  },
] as const

const client = createClient({
  transport: toModularTransport({ accountType: AccountType.Local }),
  chain: sepolia,
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe('Actions > plugins > earn > computeEarnConfigHash', () => {
  it('should byte-match Solidity keccak256(abi.encode(ConfigInput[]))', () => {
    // Ground truth generated with:
    // cast keccak $(cast abi-encode 'f((uint256,address,address)[])' \
    //   '[(43114,0x5425890298aed601595a70AB815c96711a31Bc65,0x000000000000000000000000000000000000dEaD)]')
    const hash = computeEarnConfigHash([
      { chainId: 43_114n, token: MockTokenAddress, vault: MockVaultAddress },
    ])

    expect(`0x${hash.toString(16).padStart(64, '0')}`).toBe(
      '0x17015bb7dfc2c6565fcbf9e9745fc92eb00310d9dc265518f6a0e534fb8f09a3',
    )
  })

  it('should hash entries in the order given', () => {
    const a = {
      chainId: 43_114n,
      token: MockTokenAddress,
      vault: MockVaultAddress,
    }
    const b = {
      chainId: 5_042_002n,
      token: MockTokenAddress,
      vault: MockVaultAddress,
    }

    expect(computeEarnConfigHash([a, b])).not.toBe(
      computeEarnConfigHash([b, a]),
    )
  })
})

describe('Actions > plugins > earn > encoders', () => {
  it('should encode the install data as abi.encode(uint256 configHash)', () => {
    expect(encodeEarnModuleInstallData(1n)).toBe(
      encodeAbiParameters([{ type: 'uint256' }], [1n]),
    )
  })

  it('should reject a zero config hash', () => {
    expect(() => encodeEarnModuleInstallData(0n)).toThrow(
      'Earn module config hash must be a non-zero uint256.',
    )
  })

  it('should encode autoEarn', () => {
    const data = encodeAutoEarn({
      token: MockTokenAddress,
      amountToSave: 250_000_000n,
    })

    expect(data).toBe(
      encodeFunctionData({
        abi: EARN_ABI,
        functionName: 'autoEarn',
        args: [MockTokenAddress, 250_000_000n],
      }),
    )
    expect(data.slice(0, 10)).toBe(
      toFunctionSelector('autoEarn(address,uint256)'),
    )
  })

  it('should encode changeConfigHash as a call to the module', () => {
    expect(
      encodeChangeConfigHash({ plugin: MockPluginAddress, newConfigHash: 42n }),
    ).toEqual({
      to: MockPluginAddress,
      value: 0n,
      data: encodeFunctionData({
        abi: EARN_ABI,
        functionName: 'changeConfigHash',
        args: [42n],
      }),
    })
  })

  it('should install the earn module of a deployment without dependencies', () => {
    const deployment = {
      ...MockSandboxDeployment,
      bufiEarnModule: {
        address: MockPluginAddress,
        manifestHash: `0x${'44'.repeat(32)}` as const,
      },
    }

    expect(
      encodeInstallEarnModule({
        account: MockAccountAddress,
        configHash: 7n,
        deployment,
      }),
    ).toEqual(
      encodeInstallPlugin({
        account: MockAccountAddress,
        plugin: MockPluginAddress,
        manifestHash: `0x${'44'.repeat(32)}`,
        pluginInstallData: encodeEarnModuleInstallData(7n),
      }),
    )
  })

  it('should refuse to install when the deployment has no earn module', () => {
    expect(() =>
      encodeInstallEarnModule({
        account: MockAccountAddress,
        configHash: 7n,
        deployment: MockSandboxDeployment,
      }),
    ).toThrow('The stack deployment has no BufiEarnModule.')
  })
})

describe('Actions > plugins > earn > getEarnConfigs', () => {
  it('should read the adopted config from the module', async () => {
    const configs = [{ token: MockTokenAddress, vault: MockVaultAddress }]
    const readContract = jest
      .spyOn(viemActions, 'readContract')
      .mockResolvedValue(configs)

    const result = await getEarnConfigs(client, {
      plugin: MockPluginAddress,
      account: MockAccountAddress,
    })

    expect(readContract).toHaveBeenCalledWith(client, {
      address: MockPluginAddress,
      abi: EARN_MODULE_ABI,
      functionName: 'getAllConfigs',
      args: [MockAccountAddress],
    })
    expect(result).toEqual(configs)
  })
})
