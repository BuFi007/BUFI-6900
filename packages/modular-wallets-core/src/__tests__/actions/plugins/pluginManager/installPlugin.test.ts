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

import { createBundlerClient } from 'viem/account-abstraction'
import * as viemAccountAbstraction from 'viem/account-abstraction'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'

import {
  MockEoaAccount,
  MockManifestHash,
  MockPluginAddress,
  PluginUserOperationHashResponseMock,
  toModularTransport,
} from '../../../../__mocks__'
import { toCircleSmartAccount } from '../../../../accounts'
import {
  encodeInstallPlugin,
  encodeUninstallPlugin,
  installPlugin,
  uninstallPlugin,
} from '../../../../actions'
import { AccountType } from '../../../../types'

import type { SmartAccount } from 'viem/account-abstraction'

const client = createBundlerClient({
  transport: toModularTransport({ accountType: AccountType.Local }),
  chain: sepolia,
})

let account: SmartAccount

beforeAll(async () => {
  account = await toCircleSmartAccount({
    client,
    owner: privateKeyToAccount(MockEoaAccount.privateKey),
  })
})

beforeEach(() => {
  jest
    .spyOn(viemAccountAbstraction, 'sendUserOperation')
    .mockResolvedValue(PluginUserOperationHashResponseMock)
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe('Actions > plugins > pluginManager > installPlugin', () => {
  it('should send the installPlugin calldata as raw user operation calldata', async () => {
    const result = await installPlugin(client, {
      account,
      plugin: MockPluginAddress,
      manifestHash: MockManifestHash,
      pluginInstallData: '0x1234',
      dependencies: [{ plugin: MockPluginAddress, functionId: 0 }],
      maxFeePerGas: 1n,
    })

    expect(viemAccountAbstraction.sendUserOperation).toHaveBeenCalledWith(
      client,
      {
        account,
        callData: encodeInstallPlugin({
          account: account.address,
          plugin: MockPluginAddress,
          manifestHash: MockManifestHash,
          pluginInstallData: '0x1234',
          dependencies: [{ plugin: MockPluginAddress, functionId: 0 }],
        }).data,
        maxFeePerGas: 1n,
      },
    )
    expect(result).toBe(PluginUserOperationHashResponseMock)
  })

  it('should never wrap the install in execute calls', async () => {
    await installPlugin(client, {
      account,
      plugin: MockPluginAddress,
      manifestHash: MockManifestHash,
    })

    const [, parameters] = (
      viemAccountAbstraction.sendUserOperation as jest.Mock
    ).mock.calls[0] as [unknown, Record<string, unknown>]

    expect(parameters.calls).toBeUndefined()
    expect(parameters.callData).toMatch(/^0x[0-9a-f]+$/)
  })

  it('should use the client account when none is passed', async () => {
    const clientWithAccount = { ...client, account }

    await installPlugin(clientWithAccount, {
      plugin: MockPluginAddress,
      manifestHash: MockManifestHash,
    })

    expect(viemAccountAbstraction.sendUserOperation).toHaveBeenCalledWith(
      clientWithAccount,
      expect.objectContaining({
        callData: encodeInstallPlugin({
          account: account.address,
          plugin: MockPluginAddress,
          manifestHash: MockManifestHash,
        }).data,
      }),
    )
  })

  it('should throw when no account is available', async () => {
    await expect(
      installPlugin(
        { ...client, account: undefined },
        { plugin: MockPluginAddress, manifestHash: MockManifestHash },
      ),
    ).rejects.toThrow('Account is required')
    expect(viemAccountAbstraction.sendUserOperation).not.toHaveBeenCalled()
  })
})

describe('Actions > plugins > pluginManager > uninstallPlugin', () => {
  it('should send the uninstallPlugin calldata as raw user operation calldata', async () => {
    const result = await uninstallPlugin(client, {
      account,
      plugin: MockPluginAddress,
      config: '0xaa',
      pluginUninstallData: '0xbb',
    })

    expect(viemAccountAbstraction.sendUserOperation).toHaveBeenCalledWith(
      client,
      {
        account,
        callData: encodeUninstallPlugin({
          account: account.address,
          plugin: MockPluginAddress,
          config: '0xaa',
          pluginUninstallData: '0xbb',
        }).data,
      },
    )
    expect(result).toBe(PluginUserOperationHashResponseMock)
  })

  it('should throw when no account is available', async () => {
    await expect(
      uninstallPlugin(
        { ...client, account: undefined },
        { plugin: MockPluginAddress },
      ),
    ).rejects.toThrow('Account is required')
  })
})
