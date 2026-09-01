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

import { createClient } from 'viem'
import * as viemActions from 'viem/actions'
import { sepolia } from 'viem/chains'

import {
  MockAccountAddress,
  MockPluginAddress,
  MockSessionKeyAddress,
  MockTokenAddress,
  toModularTransport,
} from '../../../../__mocks__'
import { SESSION_KEY_PLUGIN_ABI } from '../../../../abis'
import {
  findPredecessor,
  getAccessControlEntry,
  getAccessControlType,
  getERC20SpendLimitInfo,
  getGasSpendLimit,
  getKeyTimeRange,
  getNativeTokenSpendLimitInfo,
  getRequiredPaymaster,
  getSessionKeys,
  isSelectorOnAccessControlList,
  isSessionKeyOf,
} from '../../../../actions'
import { AccountType, ContractAccessControlType } from '../../../../types'

const client = createClient({
  transport: toModularTransport({ accountType: AccountType.Local }),
  chain: sepolia,
})

const baseParams = { plugin: MockPluginAddress, account: MockAccountAddress }
const keyParams = { ...baseParams, sessionKey: MockSessionKeyAddress }
const spendLimitInfo = {
  hasLimit: true,
  limit: 5n,
  limitUsed: 1n,
  refreshInterval: 60,
  lastUsedTime: 10,
}

afterEach(() => {
  jest.restoreAllMocks()
})

describe('Actions > plugins > sessionKey > loupe reads', () => {
  it.each([
    [
      'getSessionKeys',
      () => getSessionKeys(client, baseParams),
      [MockSessionKeyAddress],
      { functionName: 'sessionKeysOf', args: [MockAccountAddress] },
      [MockSessionKeyAddress],
    ],
    [
      'isSessionKeyOf',
      () => isSessionKeyOf(client, keyParams),
      true,
      {
        functionName: 'isSessionKeyOf',
        args: [MockAccountAddress, MockSessionKeyAddress],
      },
      true,
    ],
    [
      'findPredecessor',
      () => findPredecessor(client, keyParams),
      `0x${'bb'.repeat(32)}`,
      {
        functionName: 'findPredecessor',
        args: [MockAccountAddress, MockSessionKeyAddress],
      },
      `0x${'bb'.repeat(32)}`,
    ],
    [
      'getKeyTimeRange',
      () => getKeyTimeRange(client, keyParams),
      [1, 2],
      {
        functionName: 'getKeyTimeRange',
        args: [MockAccountAddress, MockSessionKeyAddress],
      },
      { validAfter: 1, validUntil: 2 },
    ],
    [
      'getERC20SpendLimitInfo',
      () =>
        getERC20SpendLimitInfo(client, {
          ...keyParams,
          token: MockTokenAddress,
        }),
      spendLimitInfo,
      {
        functionName: 'getERC20SpendLimitInfo',
        args: [MockAccountAddress, MockSessionKeyAddress, MockTokenAddress],
      },
      spendLimitInfo,
    ],
    [
      'getNativeTokenSpendLimitInfo',
      () => getNativeTokenSpendLimitInfo(client, keyParams),
      spendLimitInfo,
      {
        functionName: 'getNativeTokenSpendLimitInfo',
        args: [MockAccountAddress, MockSessionKeyAddress],
      },
      spendLimitInfo,
    ],
    [
      'getGasSpendLimit',
      () => getGasSpendLimit(client, keyParams),
      [spendLimitInfo, true],
      {
        functionName: 'getGasSpendLimit',
        args: [MockAccountAddress, MockSessionKeyAddress],
      },
      { info: spendLimitInfo, shouldReset: true },
    ],
    [
      'getAccessControlType',
      () => getAccessControlType(client, keyParams),
      ContractAccessControlType.Denylist,
      {
        functionName: 'getAccessControlType',
        args: [MockAccountAddress, MockSessionKeyAddress],
      },
      ContractAccessControlType.Denylist,
    ],
    [
      'getAccessControlEntry',
      () =>
        getAccessControlEntry(client, {
          ...keyParams,
          targetAddress: MockTokenAddress,
        }),
      [true, false],
      {
        functionName: 'getAccessControlEntry',
        args: [MockAccountAddress, MockSessionKeyAddress, MockTokenAddress],
      },
      { isOnList: true, checkSelectors: false },
    ],
    [
      'isSelectorOnAccessControlList',
      () =>
        isSelectorOnAccessControlList(client, {
          ...keyParams,
          targetAddress: MockTokenAddress,
          selector: '0xa9059cbb',
        }),
      true,
      {
        functionName: 'isSelectorOnAccessControlList',
        args: [
          MockAccountAddress,
          MockSessionKeyAddress,
          MockTokenAddress,
          '0xa9059cbb',
        ],
      },
      true,
    ],
    [
      'getRequiredPaymaster',
      () => getRequiredPaymaster(client, keyParams),
      MockTokenAddress,
      {
        functionName: 'getRequiredPaymaster',
        args: [MockAccountAddress, MockSessionKeyAddress],
      },
      MockTokenAddress,
    ],
  ] as const)(
    'should read %s from the plugin',
    async (_name, read, rpcResult, expectedCall, expectedResult) => {
      const readContract = jest
        .spyOn(viemActions, 'readContract')
        .mockResolvedValue(rpcResult)

      const result = await read()

      expect(readContract).toHaveBeenCalledWith(client, {
        address: MockPluginAddress,
        abi: SESSION_KEY_PLUGIN_ABI,
        ...expectedCall,
      })
      expect(result).toEqual(expectedResult)
    },
  )
})
