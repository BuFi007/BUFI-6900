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

import { ADDRESS_BOOK_PLUGIN_ABI } from '../../../abis'

import type { Address, Hex } from 'viem'

/**
 * Encodes an `addAllowedRecipients` call. Submit it as raw user operation calldata targeting the account (the plugin
 * execution function is installed on the account and validated by the owners); by default a recipient may then
 * receive any token. Never wrap it in `execute`: a self-call re-enters runtime validation, which is fail-closed.
 * @param recipients - The recipients to allow.
 * @returns The encoded call data.
 */
export function encodeAddAllowedRecipients(
  recipients: readonly Address[],
): Hex {
  return encodeFunctionData({
    abi: ADDRESS_BOOK_PLUGIN_ABI,
    functionName: 'addAllowedRecipients',
    args: [recipients],
  })
}
