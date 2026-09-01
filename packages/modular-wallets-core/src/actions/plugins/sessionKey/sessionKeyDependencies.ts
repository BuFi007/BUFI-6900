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
 * Builds the dependency list the session key plugin manifest requires when the account is owned by the
 * WeightedWebauthnMultisigPlugin.
 *
 * The Alchemy MAv1 manifest declares dependency index 0 as the owner runtime validation and index 1 as the owner
 * user operation validation, the same two slots as the address book. The weighted multisig plugin only validates
 * user operations (id 0), so slot 0 is bound to the unimplemented id 1 (fail-closed runtime path) and slot 1 to the
 * owner validation. The key management functions are therefore owner-signed user operations only.
 * @param weightedPluginAddress - The WeightedWebauthnMultisigPlugin address.
 * @returns The dependencies in manifest order.
 */
export function sessionKeyDependencies(
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
