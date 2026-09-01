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

/**
 * The Circle `IAddressBookPlugin` functions of the ColdStorageAddressBookPlugin.
 */
export const ADDRESS_BOOK_PLUGIN_ABI = [
  {
    inputs: [
      { internalType: 'address[]', name: 'recipients', type: 'address[]' },
    ],
    name: 'addAllowedRecipients',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address[]', name: 'recipients', type: 'address[]' },
    ],
    name: 'removeAllowedRecipients',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'account', type: 'address' }],
    name: 'getAllowedRecipients',
    outputs: [{ internalType: 'address[]', name: '', type: 'address[]' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const

/**
 * The ABI parameters of the ColdStorageAddressBookPlugin `onInstall` data: `abi.encode(address[] recipients)`.
 */
export const ADDRESS_BOOK_INSTALL_DATA_ABI_PARAMS = [
  { name: 'recipients', type: 'address[]' },
] as const
