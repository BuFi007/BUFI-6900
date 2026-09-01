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

import { encodeFunctionData } from 'viem'

import { SESSION_KEY_PERMISSIONS_UPDATES_ABI } from '../../../abis'

import type { ContractAccessControlType } from '../../../types'
import type { Address, Hex } from 'viem'

/*
 * Session key permission updates.
 *
 * Each encoder returns one element of the `bytes[]` accepted by `addSessionKey` / `updateKeyPermissions`: the ABI
 * encoding of a call to the matching `ISessionKeyPermissionsUpdates` function. The plugin dispatches on the selector
 * and applies the updates in order.
 */

/**
 * Encodes a `setAccessListType` permission update.
 * @param contractAccessControlType - The list mode. See {@link ContractAccessControlType}.
 * @returns The encoded permission update.
 */
export function encodeSetAccessListType(
  contractAccessControlType: ContractAccessControlType,
): Hex {
  return encodeFunctionData({
    abi: SESSION_KEY_PERMISSIONS_UPDATES_ABI,
    functionName: 'setAccessListType',
    args: [contractAccessControlType],
  })
}

export interface EncodeUpdateAccessListAddressEntryParameters {
  /**
   * The contract to add to or remove from the list.
   */
  contractAddress: Address
  /**
   * Whether the contract should be on the list.
   */
  isOnList: boolean
  /**
   * Whether calls to the contract are further restricted by function selector entries.
   */
  checkSelectors: boolean
}

/**
 * Encodes an `updateAccessListAddressEntry` permission update.
 * @param parameters - Parameters to use. See {@link EncodeUpdateAccessListAddressEntryParameters}.
 * @returns The encoded permission update.
 */
export function encodeUpdateAccessListAddressEntry({
  contractAddress,
  isOnList,
  checkSelectors,
}: EncodeUpdateAccessListAddressEntryParameters): Hex {
  return encodeFunctionData({
    abi: SESSION_KEY_PERMISSIONS_UPDATES_ABI,
    functionName: 'updateAccessListAddressEntry',
    args: [contractAddress, isOnList, checkSelectors],
  })
}

export interface EncodeUpdateAccessListFunctionEntryParameters {
  /**
   * The contract the selector belongs to.
   */
  contractAddress: Address
  /**
   * The 4-byte function selector.
   */
  selector: Hex
  /**
   * Whether the selector should be on the list.
   */
  isOnList: boolean
}

/**
 * Encodes an `updateAccessListFunctionEntry` permission update.
 * @param parameters - Parameters to use. See {@link EncodeUpdateAccessListFunctionEntryParameters}.
 * @returns The encoded permission update.
 */
export function encodeUpdateAccessListFunctionEntry({
  contractAddress,
  selector,
  isOnList,
}: EncodeUpdateAccessListFunctionEntryParameters): Hex {
  return encodeFunctionData({
    abi: SESSION_KEY_PERMISSIONS_UPDATES_ABI,
    functionName: 'updateAccessListFunctionEntry',
    args: [contractAddress, selector, isOnList],
  })
}

export interface EncodeUpdateTimeRangeParameters {
  /**
   * The unix timestamp (seconds) after which the key may be used. Zero means no lower bound.
   */
  validAfter: number
  /**
   * The unix timestamp (seconds) before which the key may be used. Zero means no upper bound.
   */
  validUntil: number
}

/**
 * Encodes an `updateTimeRange` permission update (the ABI name of what the BUFI grant calls the expiry).
 * @param parameters - Parameters to use. See {@link EncodeUpdateTimeRangeParameters}.
 * @returns The encoded permission update.
 */
export function encodeUpdateTimeRange({
  validAfter,
  validUntil,
}: EncodeUpdateTimeRangeParameters): Hex {
  return encodeFunctionData({
    abi: SESSION_KEY_PERMISSIONS_UPDATES_ABI,
    functionName: 'updateTimeRange',
    args: [validAfter, validUntil],
  })
}

export interface EncodeSpendLimitParameters {
  /**
   * The maximum amount per interval.
   */
  spendLimit: bigint
  /**
   * The refresh interval in seconds. Zero means the limit never refreshes.
   */
  refreshInterval: number
}

/**
 * Encodes a `setNativeTokenSpendLimit` permission update.
 * @param parameters - Parameters to use. See {@link EncodeSpendLimitParameters}.
 * @returns The encoded permission update.
 */
export function encodeSetNativeTokenSpendLimit({
  spendLimit,
  refreshInterval,
}: EncodeSpendLimitParameters): Hex {
  return encodeFunctionData({
    abi: SESSION_KEY_PERMISSIONS_UPDATES_ABI,
    functionName: 'setNativeTokenSpendLimit',
    args: [spendLimit, refreshInterval],
  })
}

export interface EncodeSetERC20SpendLimitParameters
  extends EncodeSpendLimitParameters {
  /**
   * The ERC-20 token.
   */
  token: Address
}

/**
 * Encodes a `setERC20SpendLimit` permission update.
 * @param parameters - Parameters to use. See {@link EncodeSetERC20SpendLimitParameters}.
 * @returns The encoded permission update.
 */
export function encodeSetERC20SpendLimit({
  token,
  spendLimit,
  refreshInterval,
}: EncodeSetERC20SpendLimitParameters): Hex {
  return encodeFunctionData({
    abi: SESSION_KEY_PERMISSIONS_UPDATES_ABI,
    functionName: 'setERC20SpendLimit',
    args: [token, spendLimit, refreshInterval],
  })
}

/**
 * Encodes a `setGasSpendLimit` permission update.
 * @param parameters - Parameters to use. See {@link EncodeSpendLimitParameters}.
 * @returns The encoded permission update.
 */
export function encodeSetGasSpendLimit({
  spendLimit,
  refreshInterval,
}: EncodeSpendLimitParameters): Hex {
  return encodeFunctionData({
    abi: SESSION_KEY_PERMISSIONS_UPDATES_ABI,
    functionName: 'setGasSpendLimit',
    args: [spendLimit, refreshInterval],
  })
}

/**
 * Encodes a `setRequiredPaymaster` permission update.
 * @param requiredPaymaster - The paymaster the key must use, or the zero address to remove the rule.
 * @returns The encoded permission update.
 */
export function encodeSetRequiredPaymaster(requiredPaymaster: Address): Hex {
  return encodeFunctionData({
    abi: SESSION_KEY_PERMISSIONS_UPDATES_ABI,
    functionName: 'setRequiredPaymaster',
    args: [requiredPaymaster],
  })
}
