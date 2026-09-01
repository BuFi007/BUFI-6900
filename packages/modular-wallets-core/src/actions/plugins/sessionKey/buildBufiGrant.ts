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

import { ContractAccessControlType } from '../../../types'

import {
  encodeSetAccessListType,
  encodeSetERC20SpendLimit,
  encodeSetGasSpendLimit,
  encodeSetNativeTokenSpendLimit,
  encodeSetRequiredPaymaster,
  encodeUpdateAccessListAddressEntry,
  encodeUpdateAccessListFunctionEntry,
  encodeUpdateTimeRange,
} from './permissionUpdates'

import type { BufiGrant } from '../../../types'
import type { Hex } from 'viem'

/**
 * Compiles a BUFI grant (`{ scope, budget, expiry }`) into the ordered permission updates `addSessionKey` and
 * `updateKeyPermissions` accept.
 *
 * The output order is fixed and deliberate:
 * 1. The access list is switched to allowlist mode before any entry is written, so no update ever runs against an
 * inherited list mode.
 * 2. Scope entries follow: one address entry per target (`checkSelectors` set when selectors are given) and then one
 * function entry per selector.
 * 3. Budget updates: ERC-20 limits in the order given, then the native token limit, then the gas limit.
 * 4. The time range last, so a key is never usable with a partial policy inside a valid window.
 * 5. The required paymaster, when set.
 *
 * Every target must be listed under `scope.allow` for the key to call it — including ERC-20 tokens whose budget is
 * limited, because a budget is a ceiling, not a permission.
 * @param grant - The grant. See {@link BufiGrant}.
 * @returns The ordered, ABI-encoded permission updates.
 * @throws Error if the grant is empty or the expiry is not after the start.
 */
export function buildBufiGrant(grant: BufiGrant): Hex[] {
  if (grant.scope.allow.length === 0) {
    throw new Error('A BUFI grant must allow at least one target.')
  }

  const validAfter = grant.expiry.validAfter ?? 0
  const { validUntil } = grant.expiry
  if (validUntil <= validAfter) {
    throw new Error('A BUFI grant must expire after it becomes valid.')
  }

  const updates: Hex[] = [
    encodeSetAccessListType(ContractAccessControlType.Allowlist),
  ]

  for (const entry of grant.scope.allow) {
    const selectors = entry.selectors ?? []
    updates.push(
      encodeUpdateAccessListAddressEntry({
        contractAddress: entry.target,
        isOnList: true,
        checkSelectors: selectors.length > 0,
      }),
    )
    for (const selector of selectors) {
      updates.push(
        encodeUpdateAccessListFunctionEntry({
          contractAddress: entry.target,
          selector,
          isOnList: true,
        }),
      )
    }
  }

  for (const budget of grant.budget?.erc20 ?? []) {
    updates.push(
      encodeSetERC20SpendLimit({
        token: budget.token,
        spendLimit: budget.limit,
        refreshInterval: budget.refreshIntervalSeconds,
      }),
    )
  }

  if (grant.budget?.native) {
    updates.push(
      encodeSetNativeTokenSpendLimit({
        spendLimit: grant.budget.native.limit,
        refreshInterval: grant.budget.native.refreshIntervalSeconds,
      }),
    )
  }

  if (grant.budget?.gas) {
    updates.push(
      encodeSetGasSpendLimit({
        spendLimit: grant.budget.gas.limit,
        refreshInterval: grant.budget.gas.refreshIntervalSeconds,
      }),
    )
  }

  updates.push(encodeUpdateTimeRange({ validAfter, validUntil }))

  if (grant.requiredPaymaster) {
    updates.push(encodeSetRequiredPaymaster(grant.requiredPaymaster))
  }

  return updates
}
