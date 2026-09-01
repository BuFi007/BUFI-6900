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

import { encodeInstallPlugin } from '../pluginManager/encodeInstallPlugin'

import { earnModuleDependencies } from './earnModuleDependencies'
import { encodeEarnModuleInstallData } from './encodeEarnModuleInstallData'

import type { EncodedCall, StackDeployment } from '../../../types'
import type { Address } from 'viem'

export interface EncodeInstallEarnModuleParameters {
  /**
   * The modular smart contract account the module is installed on.
   */
  account: Address
  /**
   * The config hash the account adopts.
   */
  configHash: bigint
  /**
   * The stack deployment. Must carry `bufiEarnModule`; its weighted multisig plugin backs the dependency slots.
   */
  deployment: StackDeployment
}

/**
 * Encodes the `installPlugin` call that installs the BufiEarnModule on a weighted-multisig account, wired to the
 * multisig plugin through {@link earnModuleDependencies} so that `changeConfigHash` is owner-gated. `autoEarn` keeps
 * the module's own relayer runtime validation.
 *
 * Submit `data` as raw user operation calldata, in its own user operation.
 * @param parameters - Parameters to use. See {@link EncodeInstallEarnModuleParameters}.
 * @returns The call to submit. See {@link EncodedCall}.
 * @throws Error if the deployment has no earn module.
 */
export function encodeInstallEarnModule({
  account,
  configHash,
  deployment,
}: EncodeInstallEarnModuleParameters): EncodedCall {
  if (!deployment.bufiEarnModule) {
    throw new Error('The stack deployment has no BufiEarnModule.')
  }

  return encodeInstallPlugin({
    account,
    plugin: deployment.bufiEarnModule.address,
    manifestHash: deployment.bufiEarnModule.manifestHash,
    pluginInstallData: encodeEarnModuleInstallData(configHash),
    dependencies: earnModuleDependencies(
      deployment.weightedWebauthnMultisig.address,
    ),
  })
}
