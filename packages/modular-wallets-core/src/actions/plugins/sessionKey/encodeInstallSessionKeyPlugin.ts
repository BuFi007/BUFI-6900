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

import { encodeSessionKeyInstallData } from './encodeSessionKeyInstallData'
import { sessionKeyDependencies } from './sessionKeyDependencies'

import type {
  EncodedCall,
  SessionKeyRegistration,
  StackDeployment,
} from '../../../types'
import type { Address } from 'viem'

export interface EncodeInstallSessionKeyPluginParameters {
  /**
   * The modular smart contract account the plugin is installed on.
   */
  account: Address
  /**
   * The keys to register at install time. Defaults to none.
   */
  registrations?: readonly SessionKeyRegistration[]
  /**
   * The stack deployment. Must carry `bufiSessionKey`.
   */
  deployment: StackDeployment
}

/**
 * Encodes the `installPlugin` call that installs the BUFI session key plugin on a weighted-multisig account, wired
 * through {@link sessionKeyDependencies} and optionally seeded with session keys.
 *
 * Submit `data` as raw user operation calldata, in its own user operation.
 * @param parameters - Parameters to use. See {@link EncodeInstallSessionKeyPluginParameters}.
 * @returns The call to submit. See {@link EncodedCall}.
 * @throws Error if the deployment has no session key plugin.
 */
export function encodeInstallSessionKeyPlugin({
  account,
  registrations = [],
  deployment,
}: EncodeInstallSessionKeyPluginParameters): EncodedCall {
  if (!deployment.bufiSessionKey) {
    throw new Error('The stack deployment has no BUFI session key plugin.')
  }

  return encodeInstallPlugin({
    account,
    plugin: deployment.bufiSessionKey.address,
    manifestHash: deployment.bufiSessionKey.manifestHash,
    pluginInstallData: encodeSessionKeyInstallData(registrations),
    dependencies: sessionKeyDependencies(
      deployment.weightedWebauthnMultisig.address,
    ),
  })
}
