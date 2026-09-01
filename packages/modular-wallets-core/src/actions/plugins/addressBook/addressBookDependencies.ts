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

import {
  WEIGHTED_MULTISIG_OWNER_USER_OP_VALIDATION_FUNCTION_ID,
  WEIGHTED_MULTISIG_UNIMPLEMENTED_RUNTIME_VALIDATION_FUNCTION_ID,
} from '../../../constants'

import type { FunctionReference } from '../../../types'
import type { Address } from 'viem'

/**
 * Builds the dependency list the ColdStorageAddressBookPlugin manifest requires when the account is owned by the
 * WeightedWebauthnMultisigPlugin.
 *
 * The manifest declares two dependency slots: slot 0 is the runtime validation of the owner-only functions and slot 1
 * is their user operation validation. The weighted multisig plugin only implements user operation validation (id 0),
 * so slot 0 is bound to the deliberately unimplemented id 1, which makes the runtime path fail closed. The two
 * references must also differ, because the PluginManager rejects duplicate dependencies with `ItemAlreadyExists`.
 * This `[1, 0]` wiring matches Circle's own address book installations.
 * @param weightedPluginAddress - The WeightedWebauthnMultisigPlugin address.
 * @returns The dependencies in manifest order.
 */
export function addressBookDependencies(
  weightedPluginAddress: Address,
): FunctionReference[] {
  return [
    {
      plugin: weightedPluginAddress,
      functionId:
        WEIGHTED_MULTISIG_UNIMPLEMENTED_RUNTIME_VALIDATION_FUNCTION_ID,
    },
    {
      plugin: weightedPluginAddress,
      functionId: WEIGHTED_MULTISIG_OWNER_USER_OP_VALIDATION_FUNCTION_ID,
    },
  ]
}
