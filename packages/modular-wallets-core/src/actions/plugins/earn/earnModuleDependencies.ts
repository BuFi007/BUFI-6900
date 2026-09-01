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
  EARN_MODULE_OWNER_RUNTIME_VALIDATION_DEPENDENCY_INDEX,
  EARN_MODULE_OWNER_USER_OP_VALIDATION_DEPENDENCY_INDEX,
  WEIGHTED_MULTISIG_OWNER_USER_OP_VALIDATION_FUNCTION_ID,
  WEIGHTED_MULTISIG_UNIMPLEMENTED_RUNTIME_VALIDATION_FUNCTION_ID,
} from '../../../constants'

import type { FunctionReference } from '../../../types'
import type { Address } from 'viem'

/**
 * Builds the dependency list the BufiEarnModule manifest requires when the account is owned by the
 * WeightedWebauthnMultisigPlugin.
 *
 * The manifest declares `dependencyInterfaceIds = [IPlugin, IPlugin]` for `changeConfigHash`, mirroring the
 * ColdStorageAddressBookPlugin: slot `OWNER_RUNTIME_VALIDATION_DEPENDENCY_INDEX` (0) backs runtime validation and slot
 * `OWNER_USER_OP_VALIDATION_DEPENDENCY_INDEX` (1) backs user operation validation. The weighted multisig plugin only
 * validates user operations (id 0), so slot 0 is bound to the deliberately unimplemented id 1 (fail-closed runtime
 * path) and slot 1 to the owner validation: only a threshold-signed user operation can re-point the account's vault
 * set. `autoEarn` is unaffected; it keeps the module's own relayer runtime validation.
 * @param weightedPluginAddress - The WeightedWebauthnMultisigPlugin address.
 * @returns The dependencies in manifest order.
 */
export function earnModuleDependencies(
  weightedPluginAddress: Address,
): FunctionReference[] {
  const dependencies: FunctionReference[] = []

  dependencies[EARN_MODULE_OWNER_RUNTIME_VALIDATION_DEPENDENCY_INDEX] = {
    plugin: weightedPluginAddress,
    functionId: WEIGHTED_MULTISIG_UNIMPLEMENTED_RUNTIME_VALIDATION_FUNCTION_ID,
  }
  dependencies[EARN_MODULE_OWNER_USER_OP_VALIDATION_DEPENDENCY_INDEX] = {
    plugin: weightedPluginAddress,
    functionId: WEIGHTED_MULTISIG_OWNER_USER_OP_VALIDATION_FUNCTION_ID,
  }

  return dependencies
}
