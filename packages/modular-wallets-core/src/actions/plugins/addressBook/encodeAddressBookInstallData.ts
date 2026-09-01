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

import { encodeAbiParameters } from 'viem'

import { ADDRESS_BOOK_INSTALL_DATA_ABI_PARAMS } from '../../../abis'

import type { Address, Hex } from 'viem'

/**
 * Encodes the ColdStorageAddressBookPlugin `onInstall` data: `abi.encode(address[] recipients)`.
 *
 * Recipients are de-duplicated case-insensitively because the plugin reverts with `FailToAddRecipient` when the same
 * address is added twice. An empty list is valid: the plugin then requires `addAllowedRecipients` before any transfer.
 * @param recipients - The initial allowlist.
 * @returns The encoded install data.
 */
export function encodeAddressBookInstallData(
  recipients: readonly Address[],
): Hex {
  const seen = new Set<string>()
  const unique = recipients.filter((recipient) => {
    const key = recipient.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  return encodeAbiParameters(ADDRESS_BOOK_INSTALL_DATA_ABI_PARAMS, [unique])
}
