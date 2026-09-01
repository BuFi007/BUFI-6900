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
  MockRecipients,
  MockSandboxDeployment,
  toModularTransport,
} from '../../../../__mocks__'
import { ADDRESS_BOOK_PLUGIN_ABI } from '../../../../abis'
import {
  addressBookDependencies,
  encodeAddAllowedRecipients,
  encodeAddressBookInstallData,
  encodeInstallAddressBook,
  encodeInstallPlugin,
  encodeRemoveAllowedRecipients,
  getAllowedRecipients,
} from '../../../../actions'
import {
  CIRCLE_CANONICAL_DEPLOYMENT,
  CIRCLE_COLD_STORAGE_ADDRESS_BOOK_PLUGIN,
  CIRCLE_WEIGHTED_WEB_AUTHN_MULTISIG_PLUGIN,
} from '../../../../constants'
import { AccountType } from '../../../../types'

// Independently declared ABI fragment for the calldata assertions
const ADDRESS_BOOK_ABI = [
  {
    type: 'function',
    name: 'addAllowedRecipients',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'recipients', type: 'address[]' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'removeAllowedRecipients',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'recipients', type: 'address[]' }],
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

describe('Actions > plugins > addressBook > encoders', () => {
  it('should encode addAllowedRecipients', () => {
    const data = encodeAddAllowedRecipients(MockRecipients)

    expect(data).toBe(
      encodeFunctionData({
        abi: ADDRESS_BOOK_ABI,
        functionName: 'addAllowedRecipients',
        args: [MockRecipients],
      }),
    )
    expect(data.slice(0, 10)).toBe(
      toFunctionSelector('addAllowedRecipients(address[])'),
    )
  })

  it('should encode removeAllowedRecipients', () => {
    const data = encodeRemoveAllowedRecipients([MockRecipients[0]])

    expect(data).toBe(
      encodeFunctionData({
        abi: ADDRESS_BOOK_ABI,
        functionName: 'removeAllowedRecipients',
        args: [[MockRecipients[0]]],
      }),
    )
    expect(data.slice(0, 10)).toBe(
      toFunctionSelector('removeAllowedRecipients(address[])'),
    )
  })

  it('should encode the install data as abi.encode(address[]) without case duplicates', () => {
    expect(encodeAddressBookInstallData(MockRecipients)).toBe(
      encodeAbiParameters(
        [{ type: 'address[]' }],
        [[MockRecipients[0], MockRecipients[1]]],
      ),
    )
  })

  it('should encode an empty install list', () => {
    expect(encodeAddressBookInstallData([])).toBe(
      encodeAbiParameters([{ type: 'address[]' }], [[]]),
    )
  })
})

describe('Actions > plugins > addressBook > addressBookDependencies', () => {
  it('should wire slot 0 to the unimplemented runtime id and slot 1 to the owner validation', () => {
    expect(
      addressBookDependencies(
        CIRCLE_WEIGHTED_WEB_AUTHN_MULTISIG_PLUGIN.address,
      ),
    ).toEqual([
      {
        plugin: CIRCLE_WEIGHTED_WEB_AUTHN_MULTISIG_PLUGIN.address,
        functionId: 1,
      },
      {
        plugin: CIRCLE_WEIGHTED_WEB_AUTHN_MULTISIG_PLUGIN.address,
        functionId: 0,
      },
    ])
  })
})

describe('Actions > plugins > addressBook > encodeInstallAddressBook', () => {
  it('should install the canonical address book by default', () => {
    expect(
      encodeInstallAddressBook({
        account: MockAccountAddress,
        recipients: MockRecipients,
      }),
    ).toEqual(
      encodeInstallPlugin({
        account: MockAccountAddress,
        plugin: CIRCLE_COLD_STORAGE_ADDRESS_BOOK_PLUGIN.address,
        manifestHash: CIRCLE_COLD_STORAGE_ADDRESS_BOOK_PLUGIN.manifestHash,
        pluginInstallData: encodeAddressBookInstallData(MockRecipients),
        dependencies: addressBookDependencies(
          CIRCLE_CANONICAL_DEPLOYMENT.weightedWebauthnMultisig.address,
        ),
      }),
    )
  })

  it('should install the address book of a sandbox deployment', () => {
    const call = encodeInstallAddressBook({
      account: MockAccountAddress,
      deployment: MockSandboxDeployment,
    })

    expect(call).toEqual(
      encodeInstallPlugin({
        account: MockAccountAddress,
        plugin: MockSandboxDeployment.coldStorageAddressBook.address,
        manifestHash: MockSandboxDeployment.coldStorageAddressBook.manifestHash,
        pluginInstallData: encodeAddressBookInstallData([]),
        dependencies: addressBookDependencies(
          MockSandboxDeployment.weightedWebauthnMultisig.address,
        ),
      }),
    )
  })
})

describe('Actions > plugins > addressBook > getAllowedRecipients', () => {
  it('should read the allowlist from the plugin', async () => {
    const readContract = jest
      .spyOn(viemActions, 'readContract')
      .mockResolvedValue([MockRecipients[0]] as never)

    const result = await getAllowedRecipients(client, {
      plugin: MockPluginAddress,
      account: MockAccountAddress,
    })

    expect(readContract).toHaveBeenCalledWith(client, {
      address: MockPluginAddress,
      abi: ADDRESS_BOOK_PLUGIN_ABI,
      functionName: 'getAllowedRecipients',
      args: [MockAccountAddress],
    })
    expect(result).toEqual([MockRecipients[0]])
  })
})
