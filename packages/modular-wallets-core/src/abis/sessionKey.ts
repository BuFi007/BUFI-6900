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

const CALL_COMPONENTS = [
  { internalType: 'address', name: 'target', type: 'address' },
  { internalType: 'uint256', name: 'value', type: 'uint256' },
  { internalType: 'bytes', name: 'data', type: 'bytes' },
] as const

const SPEND_LIMIT_INFO_COMPONENTS = [
  { internalType: 'bool', name: 'hasLimit', type: 'bool' },
  { internalType: 'uint256', name: 'limit', type: 'uint256' },
  { internalType: 'uint256', name: 'limitUsed', type: 'uint256' },
  { internalType: 'uint48', name: 'refreshInterval', type: 'uint48' },
  { internalType: 'uint48', name: 'lastUsedTime', type: 'uint48' },
] as const

/**
 * The Alchemy Modular Account v1 `ISessionKeyPlugin` ABI, which the BUFI session key plugin implements verbatim.
 *
 * Execution functions (`executeWithSessionKey`, `addSessionKey`, `removeSessionKey`, `rotateSessionKey`,
 * `updateKeyPermissions`) are installed on the account and called through it; the loupe views are called on the
 * plugin itself with the account as the first argument.
 */
export const SESSION_KEY_PLUGIN_ABI = [
  {
    inputs: [
      {
        components: CALL_COMPONENTS,
        internalType: 'struct Call[]',
        name: 'calls',
        type: 'tuple[]',
      },
      { internalType: 'address', name: 'sessionKey', type: 'address' },
    ],
    name: 'executeWithSessionKey',
    outputs: [{ internalType: 'bytes[]', name: '', type: 'bytes[]' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: 'sessionKey', type: 'address' },
      { internalType: 'bytes32', name: 'tag', type: 'bytes32' },
      { internalType: 'bytes[]', name: 'permissionUpdates', type: 'bytes[]' },
    ],
    name: 'addSessionKey',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: 'sessionKey', type: 'address' },
      { internalType: 'bytes32', name: 'predecessor', type: 'bytes32' },
    ],
    name: 'removeSessionKey',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: 'oldSessionKey', type: 'address' },
      { internalType: 'bytes32', name: 'predecessor', type: 'bytes32' },
      { internalType: 'address', name: 'newSessionKey', type: 'address' },
    ],
    name: 'rotateSessionKey',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: 'sessionKey', type: 'address' },
      { internalType: 'bytes[]', name: 'updates', type: 'bytes[]' },
    ],
    name: 'updateKeyPermissions',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: 'account', type: 'address' },
      { internalType: 'address', name: 'sessionKey', type: 'address' },
    ],
    name: 'resetSessionKeyGasLimitTimestamp',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'account', type: 'address' }],
    name: 'sessionKeysOf',
    outputs: [{ internalType: 'address[]', name: '', type: 'address[]' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: 'account', type: 'address' },
      { internalType: 'address', name: 'sessionKey', type: 'address' },
    ],
    name: 'isSessionKeyOf',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: 'account', type: 'address' },
      { internalType: 'address', name: 'sessionKey', type: 'address' },
    ],
    name: 'findPredecessor',
    outputs: [{ internalType: 'bytes32', name: '', type: 'bytes32' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: 'account', type: 'address' },
      { internalType: 'address', name: 'sessionKey', type: 'address' },
    ],
    name: 'getAccessControlType',
    outputs: [
      {
        internalType: 'enum ISessionKeyPlugin.ContractAccessControlType',
        name: '',
        type: 'uint8',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: 'account', type: 'address' },
      { internalType: 'address', name: 'sessionKey', type: 'address' },
      { internalType: 'address', name: 'targetAddress', type: 'address' },
    ],
    name: 'getAccessControlEntry',
    outputs: [
      { internalType: 'bool', name: 'isOnList', type: 'bool' },
      { internalType: 'bool', name: 'checkSelectors', type: 'bool' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: 'account', type: 'address' },
      { internalType: 'address', name: 'sessionKey', type: 'address' },
      { internalType: 'address', name: 'targetAddress', type: 'address' },
      { internalType: 'bytes4', name: 'selector', type: 'bytes4' },
    ],
    name: 'isSelectorOnAccessControlList',
    outputs: [{ internalType: 'bool', name: 'isOnList', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: 'account', type: 'address' },
      { internalType: 'address', name: 'sessionKey', type: 'address' },
    ],
    name: 'getKeyTimeRange',
    outputs: [
      { internalType: 'uint48', name: 'validAfter', type: 'uint48' },
      { internalType: 'uint48', name: 'validUntil', type: 'uint48' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: 'account', type: 'address' },
      { internalType: 'address', name: 'sessionKey', type: 'address' },
    ],
    name: 'getNativeTokenSpendLimitInfo',
    outputs: [
      {
        components: SPEND_LIMIT_INFO_COMPONENTS,
        internalType: 'struct ISessionKeyPlugin.SpendLimitInfo',
        name: '',
        type: 'tuple',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: 'account', type: 'address' },
      { internalType: 'address', name: 'sessionKey', type: 'address' },
    ],
    name: 'getGasSpendLimit',
    outputs: [
      {
        components: SPEND_LIMIT_INFO_COMPONENTS,
        internalType: 'struct ISessionKeyPlugin.SpendLimitInfo',
        name: 'info',
        type: 'tuple',
      },
      { internalType: 'bool', name: 'shouldReset', type: 'bool' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: 'account', type: 'address' },
      { internalType: 'address', name: 'sessionKey', type: 'address' },
      { internalType: 'address', name: 'token', type: 'address' },
    ],
    name: 'getERC20SpendLimitInfo',
    outputs: [
      {
        components: SPEND_LIMIT_INFO_COMPONENTS,
        internalType: 'struct ISessionKeyPlugin.SpendLimitInfo',
        name: '',
        type: 'tuple',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: 'account', type: 'address' },
      { internalType: 'address', name: 'sessionKey', type: 'address' },
    ],
    name: 'getRequiredPaymaster',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const

/**
 * The Alchemy Modular Account v1 `ISessionKeyPermissionsUpdates` ABI.
 *
 * These functions are never called; each permission update is the ABI encoding of one of them, passed inside the
 * `bytes[]` of `addSessionKey` / `updateKeyPermissions` (or the `bytes[][]` of the plugin install data).
 */
export const SESSION_KEY_PERMISSIONS_UPDATES_ABI = [
  {
    inputs: [
      {
        internalType: 'enum ISessionKeyPlugin.ContractAccessControlType',
        name: 'contractAccessControlType',
        type: 'uint8',
      },
    ],
    name: 'setAccessListType',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: 'contractAddress', type: 'address' },
      { internalType: 'bool', name: 'isOnList', type: 'bool' },
      { internalType: 'bool', name: 'checkSelectors', type: 'bool' },
    ],
    name: 'updateAccessListAddressEntry',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: 'contractAddress', type: 'address' },
      { internalType: 'bytes4', name: 'selector', type: 'bytes4' },
      { internalType: 'bool', name: 'isOnList', type: 'bool' },
    ],
    name: 'updateAccessListFunctionEntry',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'uint48', name: 'validAfter', type: 'uint48' },
      { internalType: 'uint48', name: 'validUntil', type: 'uint48' },
    ],
    name: 'updateTimeRange',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'uint256', name: 'spendLimit', type: 'uint256' },
      { internalType: 'uint48', name: 'refreshInterval', type: 'uint48' },
    ],
    name: 'setNativeTokenSpendLimit',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: 'token', type: 'address' },
      { internalType: 'uint256', name: 'spendLimit', type: 'uint256' },
      { internalType: 'uint48', name: 'refreshInterval', type: 'uint48' },
    ],
    name: 'setERC20SpendLimit',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'uint256', name: 'spendLimit', type: 'uint256' },
      { internalType: 'uint48', name: 'refreshInterval', type: 'uint48' },
    ],
    name: 'setGasSpendLimit',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: 'requiredPaymaster', type: 'address' },
    ],
    name: 'setRequiredPaymaster',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const

/**
 * The ABI parameters of the session key plugin `onInstall` data:
 * `abi.encode(address[] sessionKeys, bytes32[] tags, bytes[][] permissionUpdates)`.
 */
export const SESSION_KEY_INSTALL_DATA_ABI_PARAMS = [
  { name: 'sessionKeys', type: 'address[]' },
  { name: 'tags', type: 'bytes32[]' },
  { name: 'permissionUpdates', type: 'bytes[][]' },
] as const
