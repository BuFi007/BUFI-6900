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

import { encodeFunctionData, recoverMessageAddress } from 'viem'
import {
  createBundlerClient,
  getUserOperationHash,
} from 'viem/account-abstraction'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'

import {
  MockAccountAddress,
  MockEncodeCallsParams,
  MockPluginAddress,
  MockSandboxDeployment,
  MockSessionKeyAddress,
  MockSessionKeyPrivateKey,
  MockSignUserOperationParams,
  toModularTransport,
} from '../../../__mocks__'
import { toBufiSessionKeyAccount } from '../../../accounts'
import {
  CIRCLE_CANONICAL_DEPLOYMENT,
  SESSION_KEY_STUB_SIGNATURE,
} from '../../../constants'
import { AccountType } from '../../../types'

import type { LocalAccount } from 'viem'

// Independently declared ABI fragment for the calldata assertion
const EXECUTE_WITH_SESSION_KEY_ABI = [
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
] as const

const client = createBundlerClient({
  transport: toModularTransport({ accountType: AccountType.Local }),
  chain: sepolia,
})

let sessionKey: LocalAccount

beforeAll(() => {
  sessionKey = privateKeyToAccount(MockSessionKeyPrivateKey)
})

describe('Accounts > implementations > toBufiSessionKeyAccount', () => {
  it('should expose the account address, plugin and session key', async () => {
    const account = await toBufiSessionKeyAccount({
      client,
      account: MockAccountAddress,
      sessionKey,
      plugin: MockPluginAddress,
    })

    expect(account.address).toBe(MockAccountAddress)
    expect(await account.getAddress()).toBe(MockAccountAddress)
    expect(account.plugin).toBe(MockPluginAddress)
    expect(account.sessionKey).toBe(MockSessionKeyAddress)
    expect(account.entryPoint.address).toBe(
      CIRCLE_CANONICAL_DEPLOYMENT.entryPoint,
    )
  })

  it('should wrap calls in executeWithSessionKey', async () => {
    const account = await toBufiSessionKeyAccount({
      client,
      account: MockAccountAddress,
      sessionKey,
      plugin: MockPluginAddress,
    })

    const encoded = await account.encodeCalls([
      { ...MockEncodeCallsParams[0], value: 1n },
      MockEncodeCallsParams[1],
    ])

    expect(encoded).toBe(
      encodeFunctionData({
        abi: EXECUTE_WITH_SESSION_KEY_ABI,
        functionName: 'executeWithSessionKey',
        args: [
          [
            { target: MockEncodeCallsParams[0].to, value: 1n, data: '0x' },
            { target: MockEncodeCallsParams[1].to, value: 0n, data: '0x' },
          ],
          MockSessionKeyAddress,
        ],
      }),
    )
  })

  it('should have no factory args and a 65-byte stub signature', async () => {
    const account = await toBufiSessionKeyAccount({
      client,
      account: MockAccountAddress,
      sessionKey,
      plugin: MockPluginAddress,
    })

    expect(await account.getFactoryArgs()).toEqual({
      factory: undefined,
      factoryData: undefined,
    })
    expect(await account.getStubSignature()).toBe(SESSION_KEY_STUB_SIGNATURE)
  })

  it('should sign the user operation hash with the session key over the deployment entry point', async () => {
    const account = await toBufiSessionKeyAccount({
      client,
      account: MockAccountAddress,
      sessionKey,
      plugin: MockPluginAddress,
      deployment: MockSandboxDeployment,
    })

    const signature = await account.signUserOperation(
      MockSignUserOperationParams,
    )
    const { chainId, ...userOperation } = MockSignUserOperationParams
    const hash = getUserOperationHash({
      chainId,
      entryPointAddress: MockSandboxDeployment.entryPoint,
      entryPointVersion: '0.7',
      userOperation: { ...userOperation, sender: MockAccountAddress },
    })

    expect(signature).toMatch(/^0x[0-9a-f]{130}$/)
    expect(
      await recoverMessageAddress({ message: { raw: hash }, signature }),
    ).toBe(MockSessionKeyAddress)
  })

  it('should fall back to the client chain id when the user operation has none', async () => {
    const account = await toBufiSessionKeyAccount({
      client,
      account: MockAccountAddress,
      sessionKey,
      plugin: MockPluginAddress,
    })
    const { chainId: _chainId, ...userOperation } = MockSignUserOperationParams

    const signature = await account.signUserOperation(userOperation)
    const hash = getUserOperationHash({
      chainId: sepolia.id,
      entryPointAddress: CIRCLE_CANONICAL_DEPLOYMENT.entryPoint,
      entryPointVersion: '0.7',
      userOperation: { ...userOperation, sender: MockAccountAddress },
    })

    expect(
      await recoverMessageAddress({ message: { raw: hash }, signature }),
    ).toBe(MockSessionKeyAddress)
  })

  it('should refuse to sign messages and typed data', async () => {
    const account = await toBufiSessionKeyAccount({
      client,
      account: MockAccountAddress,
      sessionKey,
      plugin: MockPluginAddress,
    })

    await expect(account.signMessage({ message: 'hello' })).rejects.toThrow(
      'A session key can only sign user operations.',
    )
    await expect(
      account.signTypedData({
        primaryType: 'EIP712Domain',
        domain: { name: 'bufi', chainId: 1 },
      }),
    ).rejects.toThrow('A session key can only sign user operations.')
  })
})
