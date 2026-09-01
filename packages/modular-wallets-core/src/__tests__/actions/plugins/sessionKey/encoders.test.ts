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
  encodeFunctionData,
  toFunctionSelector,
  zeroAddress,
  zeroHash,
} from 'viem'

import {
  MockAccountAddress,
  MockBufiGrant,
  MockPluginAddress,
  MockRecipients,
  MockSandboxDeployment,
  MockSessionKeyAddress,
  MockTokenAddress,
} from '../../../../__mocks__'
import {
  encodeAddSessionKey,
  encodeExecuteWithSessionKey,
  encodeInstallPlugin,
  encodeInstallSessionKeyPlugin,
  encodeRemoveSessionKey,
  encodeRotateSessionKey,
  encodeSessionKeyInstallData,
  encodeSetAccessListType,
  encodeSetERC20SpendLimit,
  encodeSetGasSpendLimit,
  encodeSetNativeTokenSpendLimit,
  encodeSetRequiredPaymaster,
  encodeUpdateAccessListAddressEntry,
  encodeUpdateAccessListFunctionEntry,
  encodeUpdateKeyPermissions,
  encodeUpdateTimeRange,
  sessionKeyDependencies,
} from '../../../../actions'
import { ContractAccessControlType } from '../../../../types'

// Independently declared ABI fragments (Alchemy MAv1 ISessionKeyPlugin + ISessionKeyPermissionsUpdates)
const SESSION_KEY_ABI = [
  {
    type: 'function',
    name: 'executeWithSessionKey',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          { name: 'target', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'data', type: 'bytes' },
        ],
      },
      { name: 'sessionKey', type: 'address' },
    ],
    outputs: [{ type: 'bytes[]' }],
  },
  {
    type: 'function',
    name: 'addSessionKey',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'sessionKey', type: 'address' },
      { name: 'tag', type: 'bytes32' },
      { name: 'permissionUpdates', type: 'bytes[]' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'removeSessionKey',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'sessionKey', type: 'address' },
      { name: 'predecessor', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'rotateSessionKey',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'oldSessionKey', type: 'address' },
      { name: 'predecessor', type: 'bytes32' },
      { name: 'newSessionKey', type: 'address' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'updateKeyPermissions',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'sessionKey', type: 'address' },
      { name: 'updates', type: 'bytes[]' },
    ],
    outputs: [],
  },
] as const

const PERMISSIONS_UPDATES_ABI = [
  {
    type: 'function',
    name: 'setAccessListType',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'contractAccessControlType', type: 'uint8' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'updateAccessListAddressEntry',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'contractAddress', type: 'address' },
      { name: 'isOnList', type: 'bool' },
      { name: 'checkSelectors', type: 'bool' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'updateAccessListFunctionEntry',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'contractAddress', type: 'address' },
      { name: 'selector', type: 'bytes4' },
      { name: 'isOnList', type: 'bool' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'updateTimeRange',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'validAfter', type: 'uint48' },
      { name: 'validUntil', type: 'uint48' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setNativeTokenSpendLimit',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spendLimit', type: 'uint256' },
      { name: 'refreshInterval', type: 'uint48' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setERC20SpendLimit',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'spendLimit', type: 'uint256' },
      { name: 'refreshInterval', type: 'uint48' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setGasSpendLimit',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spendLimit', type: 'uint256' },
      { name: 'refreshInterval', type: 'uint48' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setRequiredPaymaster',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'requiredPaymaster', type: 'address' }],
    outputs: [],
  },
] as const

const tag = `0x${'aa'.repeat(32)}` as const
const predecessor = `0x${'bb'.repeat(32)}` as const
const updates = ['0x01', '0x02'] as const

describe('Actions > plugins > sessionKey > execution encoders', () => {
  it('should encode executeWithSessionKey', () => {
    const calls = [
      { target: MockRecipients[0], value: 1n, data: '0xdead' as const },
      { target: MockRecipients[1], value: 0n, data: '0x' as const },
    ]
    const data = encodeExecuteWithSessionKey(calls, MockSessionKeyAddress)

    expect(data).toBe(
      encodeFunctionData({
        abi: SESSION_KEY_ABI,
        functionName: 'executeWithSessionKey',
        args: [calls, MockSessionKeyAddress],
      }),
    )
    expect(data.slice(0, 10)).toBe(
      toFunctionSelector(
        'executeWithSessionKey((address,uint256,bytes)[],address)',
      ),
    )
  })

  it('should encode addSessionKey with a zero tag by default', () => {
    expect(
      encodeAddSessionKey({
        sessionKey: MockSessionKeyAddress,
        permissionUpdates: updates,
      }),
    ).toBe(
      encodeFunctionData({
        abi: SESSION_KEY_ABI,
        functionName: 'addSessionKey',
        args: [MockSessionKeyAddress, zeroHash, updates],
      }),
    )
  })

  it('should encode addSessionKey with a tag', () => {
    const data = encodeAddSessionKey({
      sessionKey: MockSessionKeyAddress,
      tag,
      permissionUpdates: updates,
    })

    expect(data).toBe(
      encodeFunctionData({
        abi: SESSION_KEY_ABI,
        functionName: 'addSessionKey',
        args: [MockSessionKeyAddress, tag, updates],
      }),
    )
    expect(data.slice(0, 10)).toBe(
      toFunctionSelector('addSessionKey(address,bytes32,bytes[])'),
    )
  })

  it('should encode removeSessionKey', () => {
    expect(
      encodeRemoveSessionKey({
        sessionKey: MockSessionKeyAddress,
        predecessor,
      }),
    ).toBe(
      encodeFunctionData({
        abi: SESSION_KEY_ABI,
        functionName: 'removeSessionKey',
        args: [MockSessionKeyAddress, predecessor],
      }),
    )
  })

  it('should encode rotateSessionKey', () => {
    expect(
      encodeRotateSessionKey({
        oldSessionKey: MockSessionKeyAddress,
        predecessor,
        newSessionKey: MockRecipients[0],
      }),
    ).toBe(
      encodeFunctionData({
        abi: SESSION_KEY_ABI,
        functionName: 'rotateSessionKey',
        args: [MockSessionKeyAddress, predecessor, MockRecipients[0]],
      }),
    )
  })

  it('should encode updateKeyPermissions', () => {
    expect(
      encodeUpdateKeyPermissions({
        sessionKey: MockSessionKeyAddress,
        updates,
      }),
    ).toBe(
      encodeFunctionData({
        abi: SESSION_KEY_ABI,
        functionName: 'updateKeyPermissions',
        args: [MockSessionKeyAddress, updates],
      }),
    )
  })
})

describe('Actions > plugins > sessionKey > permission update encoders', () => {
  it.each([
    [
      'setAccessListType',
      encodeSetAccessListType(ContractAccessControlType.Denylist),
      { functionName: 'setAccessListType', args: [1] },
      'setAccessListType(uint8)',
    ],
    [
      'updateAccessListAddressEntry',
      encodeUpdateAccessListAddressEntry({
        contractAddress: MockTokenAddress,
        isOnList: true,
        checkSelectors: false,
      }),
      {
        functionName: 'updateAccessListAddressEntry',
        args: [MockTokenAddress, true, false],
      },
      'updateAccessListAddressEntry(address,bool,bool)',
    ],
    [
      'updateAccessListFunctionEntry',
      encodeUpdateAccessListFunctionEntry({
        contractAddress: MockTokenAddress,
        selector: '0xa9059cbb',
        isOnList: true,
      }),
      {
        functionName: 'updateAccessListFunctionEntry',
        args: [MockTokenAddress, '0xa9059cbb', true],
      },
      'updateAccessListFunctionEntry(address,bytes4,bool)',
    ],
    [
      'updateTimeRange',
      encodeUpdateTimeRange({ validAfter: 1, validUntil: 2 }),
      { functionName: 'updateTimeRange', args: [1, 2] },
      'updateTimeRange(uint48,uint48)',
    ],
    [
      'setNativeTokenSpendLimit',
      encodeSetNativeTokenSpendLimit({ spendLimit: 5n, refreshInterval: 6 }),
      { functionName: 'setNativeTokenSpendLimit', args: [5n, 6] },
      'setNativeTokenSpendLimit(uint256,uint48)',
    ],
    [
      'setERC20SpendLimit',
      encodeSetERC20SpendLimit({
        token: MockTokenAddress,
        spendLimit: 7n,
        refreshInterval: 8,
      }),
      { functionName: 'setERC20SpendLimit', args: [MockTokenAddress, 7n, 8] },
      'setERC20SpendLimit(address,uint256,uint48)',
    ],
    [
      'setGasSpendLimit',
      encodeSetGasSpendLimit({ spendLimit: 9n, refreshInterval: 10 }),
      { functionName: 'setGasSpendLimit', args: [9n, 10] },
      'setGasSpendLimit(uint256,uint48)',
    ],
    [
      'setRequiredPaymaster',
      encodeSetRequiredPaymaster(zeroAddress),
      { functionName: 'setRequiredPaymaster', args: [zeroAddress] },
      'setRequiredPaymaster(address)',
    ],
  ] as const)(
    'should encode %s as an ISessionKeyPermissionsUpdates call',
    (_name, encoded, expected, signature) => {
      expect(encoded).toBe(
        encodeFunctionData({
          abi: PERMISSIONS_UPDATES_ABI,
          ...expected,
        }),
      )
      expect(encoded.slice(0, 10)).toBe(toFunctionSelector(signature))
    },
  )
})

describe('Actions > plugins > sessionKey > install', () => {
  it('should wire the same two dependency slots as the address book', () => {
    expect(sessionKeyDependencies(MockPluginAddress)).toEqual([
      { plugin: MockPluginAddress, functionId: 1 },
      { plugin: MockPluginAddress, functionId: 0 },
    ])
  })

  it('should encode the install data as abi.encode(address[], bytes32[], bytes[][])', () => {
    const data = encodeSessionKeyInstallData([
      { sessionKey: MockSessionKeyAddress, tag, permissionUpdates: updates },
      { sessionKey: MockRecipients[0], permissionUpdates: [] },
    ])

    expect(data).toBe(
      encodeAbiParameters(
        [{ type: 'address[]' }, { type: 'bytes32[]' }, { type: 'bytes[][]' }],
        [
          [MockSessionKeyAddress, MockRecipients[0]],
          [tag, zeroHash],
          [updates, []],
        ],
      ),
    )
  })

  it('should encode an empty install', () => {
    expect(encodeSessionKeyInstallData([])).toBe(
      encodeAbiParameters(
        [{ type: 'address[]' }, { type: 'bytes32[]' }, { type: 'bytes[][]' }],
        [[], [], []],
      ),
    )
  })

  it('should install the session key plugin of a deployment', () => {
    const registrations = [
      { sessionKey: MockSessionKeyAddress, permissionUpdates: updates },
    ]

    expect(
      encodeInstallSessionKeyPlugin({
        account: MockAccountAddress,
        registrations,
        deployment: MockSandboxDeployment,
      }),
    ).toEqual(
      encodeInstallPlugin({
        account: MockAccountAddress,
        plugin: MockSandboxDeployment.bufiSessionKey!.address,
        manifestHash: MockSandboxDeployment.bufiSessionKey!.manifestHash,
        pluginInstallData: encodeSessionKeyInstallData(registrations),
        dependencies: sessionKeyDependencies(
          MockSandboxDeployment.weightedWebauthnMultisig.address,
        ),
      }),
    )
  })

  it('should refuse to install when the deployment has no session key plugin', () => {
    expect(() =>
      encodeInstallSessionKeyPlugin({
        account: MockAccountAddress,
        deployment: { ...MockSandboxDeployment, bufiSessionKey: undefined },
      }),
    ).toThrow('The stack deployment has no BUFI session key plugin.')
  })

  it('should keep the mock grant well-formed', () => {
    expect(MockBufiGrant.scope.allow).toHaveLength(2)
  })
})
