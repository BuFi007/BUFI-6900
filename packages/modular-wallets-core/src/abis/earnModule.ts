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

const CONFIG_INPUT_COMPONENTS = [
  { internalType: 'uint256', name: 'chainId', type: 'uint256' },
  { internalType: 'address', name: 'token', type: 'address' },
  { internalType: 'address', name: 'vault', type: 'address' },
] as const

/**
 * The BufiEarnModule ABI (the subset the SDK encodes or reads).
 *
 * `autoEarn` and `changeConfigHash` are execution functions installed on the account: `autoEarn` is runtime-only and
 * relayer-gated, `changeConfigHash` is owner-gated through the two manifest dependency slots (slot 0 backs runtime
 * validation, slot 1 backs user operation validation), the same arrangement as the ColdStorageAddressBookPlugin
 * management functions.
 */
export const EARN_MODULE_ABI = [
  {
    inputs: [
      { internalType: 'address', name: 'token', type: 'address' },
      { internalType: 'uint256', name: 'amountToSave', type: 'uint256' },
    ],
    name: 'autoEarn',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'uint256', name: 'newConfigHash', type: 'uint256' },
    ],
    name: 'changeConfigHash',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        components: CONFIG_INPUT_COMPONENTS,
        internalType: 'struct BufiEarnModule.ConfigInput[]',
        name: 'newConfigs',
        type: 'tuple[]',
      },
    ],
    name: 'setConfig',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'account', type: 'address' }],
    name: 'getAllConfigs',
    outputs: [
      {
        components: [
          { internalType: 'address', name: 'token', type: 'address' },
          { internalType: 'address', name: 'vault', type: 'address' },
        ],
        internalType: 'struct BufiEarnModule.ConfigWithToken[]',
        name: '',
        type: 'tuple[]',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: '', type: 'address' }],
    name: 'accountConfig',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'manifestHash',
    outputs: [{ internalType: 'bytes32', name: '', type: 'bytes32' }],
    stateMutability: 'pure',
    type: 'function',
  },
  {
    inputs: [],
    name: 'FUNCTION_ID_RUNTIME_VALIDATION_RELAYER',
    outputs: [{ internalType: 'uint8', name: '', type: 'uint8' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'OWNER_RUNTIME_VALIDATION_DEPENDENCY_INDEX',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'OWNER_USER_OP_VALIDATION_DEPENDENCY_INDEX',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const

/**
 * The ABI parameters hashed by `BufiEarnModule.setConfig`: `keccak256(abi.encode(ConfigInput[] newConfigs))`.
 */
export const EARN_CONFIG_ABI_PARAMS = [
  {
    components: CONFIG_INPUT_COMPONENTS,
    internalType: 'struct BufiEarnModule.ConfigInput[]',
    name: 'newConfigs',
    type: 'tuple[]',
  },
] as const

/**
 * The ABI parameters of the BufiEarnModule `onInstall` data: `abi.encode(uint256 configHash)`.
 */
export const EARN_MODULE_INSTALL_DATA_ABI_PARAMS = [
  { name: 'configHash', type: 'uint256' },
] as const
