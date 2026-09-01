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
import { polygonAmoy } from 'viem/chains'

import { toModularTransport } from '../../../__mocks__'
import { bufiCascadeActions } from '../../../clients'
import { AccountType } from '../../../types'

// Mocking the actions
jest.mock('../../../actions', () => {
  const jestMockResult = (mockResult: string) => {
    return jest.fn().mockImplementation(() => Promise.resolve({ mockResult }))
  }

  return {
    installPlugin: jestMockResult('installPlugin'),
    uninstallPlugin: jestMockResult('uninstallPlugin'),
    getInstalledPlugins: jestMockResult('getInstalledPlugins'),
    getPluginManifestHash: jestMockResult('getPluginManifestHash'),
    getAllowedRecipients: jestMockResult('getAllowedRecipients'),
    getSessionKeys: jestMockResult('getSessionKeys'),
    isSessionKeyOf: jestMockResult('isSessionKeyOf'),
    findPredecessor: jestMockResult('findPredecessor'),
    getKeyTimeRange: jestMockResult('getKeyTimeRange'),
    getERC20SpendLimitInfo: jestMockResult('getERC20SpendLimitInfo'),
    getGasSpendLimit: jestMockResult('getGasSpendLimit'),
    getNativeTokenSpendLimitInfo: jestMockResult(
      'getNativeTokenSpendLimitInfo',
    ),
    getAccessControlType: jestMockResult('getAccessControlType'),
    getAccessControlEntry: jestMockResult('getAccessControlEntry'),
    isSelectorOnAccessControlList: jestMockResult(
      'isSelectorOnAccessControlList',
    ),
    getRequiredPaymaster: jestMockResult('getRequiredPaymaster'),
    getEarnConfigs: jestMockResult('getEarnConfigs'),
  }
})

describe('Client > Decorators > bufiCascade', () => {
  const transport = toModularTransport({ accountType: AccountType.WebAuthn })
  const client = createBundlerClient({ chain: polygonAmoy, transport })

  afterEach(() => {
    jest.clearAllMocks()
  })

  it('should include the cascade actions', () => {
    expect(bufiCascadeActions(client)).toMatchInlineSnapshot(`
      {
        "findPredecessor": [Function],
        "getAccessControlEntry": [Function],
        "getAccessControlType": [Function],
        "getAllowedRecipients": [Function],
        "getERC20SpendLimitInfo": [Function],
        "getEarnConfigs": [Function],
        "getGasSpendLimit": [Function],
        "getInstalledPlugins": [Function],
        "getKeyTimeRange": [Function],
        "getNativeTokenSpendLimitInfo": [Function],
        "getPluginManifestHash": [Function],
        "getRequiredPaymaster": [Function],
        "getSessionKeys": [Function],
        "installPlugin": [Function],
        "isSelectorOnAccessControlList": [Function],
        "isSessionKeyOf": [Function],
        "uninstallPlugin": [Function],
      }
    `)
  })

  it('should delegate every action to its implementation', async () => {
    const actions = bufiCascadeActions(client)
    const params = {} as never

    for (const [name, action] of Object.entries(actions)) {
      const result = await (action as (parameters: never) => Promise<unknown>)(
        params,
      )
      expect(result).toEqual({ mockResult: name })
    }
  })
})
