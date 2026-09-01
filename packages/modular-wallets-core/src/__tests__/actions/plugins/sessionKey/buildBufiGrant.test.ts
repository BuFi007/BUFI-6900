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

import { decodeFunctionData } from 'viem'

import {
  MockBufiGrant,
  MockTokenAddress,
  MockVaultAddress,
} from '../../../../__mocks__'
import { SESSION_KEY_PERMISSIONS_UPDATES_ABI } from '../../../../abis'
import { buildBufiGrant } from '../../../../actions'
import { ContractAccessControlType } from '../../../../types'

import type { Hex } from 'viem'

/**
 * Decodes a permission update into its function name and arguments.
 * @param update - The ABI-encoded update.
 * @returns The decoded call.
 */
function decode(update: Hex) {
  const { functionName, args } = decodeFunctionData({
    abi: SESSION_KEY_PERMISSIONS_UPDATES_ABI,
    data: update,
  })
  return { functionName, args }
}

describe('Actions > plugins > sessionKey > buildBufiGrant', () => {
  it('should compile a full grant in the documented order', () => {
    const updates = buildBufiGrant(MockBufiGrant).map(decode)

    expect(updates).toEqual([
      {
        functionName: 'setAccessListType',
        args: [ContractAccessControlType.Allowlist],
      },
      {
        functionName: 'updateAccessListAddressEntry',
        args: [MockTokenAddress, true, true],
      },
      {
        functionName: 'updateAccessListFunctionEntry',
        args: [MockTokenAddress, '0xa9059cbb', true],
      },
      {
        functionName: 'updateAccessListAddressEntry',
        args: [MockVaultAddress, true, false],
      },
      {
        functionName: 'setERC20SpendLimit',
        args: [MockTokenAddress, 250_000_000n, 86_400],
      },
      { functionName: 'setNativeTokenSpendLimit', args: [10n ** 16n, 0] },
      { functionName: 'setGasSpendLimit', args: [10n ** 17n, 86_400] },
      {
        functionName: 'updateTimeRange',
        args: [1_800_000_000, 1_800_086_400],
      },
      {
        functionName: 'setRequiredPaymaster',
        args: [MockBufiGrant.requiredPaymaster],
      },
    ])
  })

  it('should compile a minimal grant: allowlist mode, one target, time range', () => {
    const updates = buildBufiGrant({
      scope: { allow: [{ target: MockVaultAddress }] },
      expiry: { validUntil: 100 },
    }).map(decode)

    expect(updates).toEqual([
      {
        functionName: 'setAccessListType',
        args: [ContractAccessControlType.Allowlist],
      },
      {
        functionName: 'updateAccessListAddressEntry',
        args: [MockVaultAddress, true, false],
      },
      { functionName: 'updateTimeRange', args: [0, 100] },
    ])
  })

  it('should keep budgets in the order given', () => {
    const updates = buildBufiGrant({
      scope: {
        allow: [{ target: MockTokenAddress }, { target: MockVaultAddress }],
      },
      budget: {
        erc20: [
          { token: MockVaultAddress, limit: 1n, refreshIntervalSeconds: 1 },
          { token: MockTokenAddress, limit: 2n, refreshIntervalSeconds: 2 },
        ],
      },
      expiry: { validUntil: 100 },
    }).map(decode)

    expect(updates.map((update) => update.functionName)).toEqual([
      'setAccessListType',
      'updateAccessListAddressEntry',
      'updateAccessListAddressEntry',
      'setERC20SpendLimit',
      'setERC20SpendLimit',
      'updateTimeRange',
    ])
    expect(updates[3].args).toEqual([MockVaultAddress, 1n, 1])
    expect(updates[4].args).toEqual([MockTokenAddress, 2n, 2])
  })

  it('should reject a grant without targets', () => {
    expect(() =>
      buildBufiGrant({ scope: { allow: [] }, expiry: { validUntil: 100 } }),
    ).toThrow('A BUFI grant must allow at least one target.')
  })

  it('should reject a grant that expires before it starts', () => {
    expect(() =>
      buildBufiGrant({
        scope: { allow: [{ target: MockVaultAddress }] },
        expiry: { validAfter: 100, validUntil: 100 },
      }),
    ).toThrow('A BUFI grant must expire after it becomes valid.')
  })
})
