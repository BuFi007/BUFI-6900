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

import { CIRCLE_CANONICAL_DEPLOYMENT } from '../../../constants'
import { encodeInstallPlugin } from '../pluginManager/encodeInstallPlugin'

import { addressBookDependencies } from './addressBookDependencies'
import { encodeAddressBookInstallData } from './encodeAddressBookInstallData'

import type { EncodedCall, StackDeployment } from '../../../types'
import type { Address } from 'viem'

export interface EncodeInstallAddressBookParameters {
  /**
   * The modular smart contract account the plugin is installed on.
   */
  account: Address
  /**
   * The initial allowlist. Defaults to empty.
   */
  recipients?: readonly Address[]
  /**
   * The stack deployment. Defaults to the canonical Circle deployment.
   */
  deployment?: StackDeployment
}

/**
 * Encodes the `installPlugin` call that installs the ColdStorageAddressBookPlugin on a weighted-multisig account,
 * wired to the multisig plugin through {@link addressBookDependencies} and seeded with the initial allowlist.
 *
 * Submit it as its own user operation, after the ownership plugin has reached its final weights.
 * @param parameters - Parameters to use. See {@link EncodeInstallAddressBookParameters}.
 * @returns The call to execute. See {@link EncodedCall}.
 */
export function encodeInstallAddressBook({
  account,
  recipients = [],
  deployment = CIRCLE_CANONICAL_DEPLOYMENT,
}: EncodeInstallAddressBookParameters): EncodedCall {
  return encodeInstallPlugin({
    account,
    plugin: deployment.coldStorageAddressBook.address,
    manifestHash: deployment.coldStorageAddressBook.manifestHash,
    pluginInstallData: encodeAddressBookInstallData(recipients),
    dependencies: addressBookDependencies(
      deployment.weightedWebauthnMultisig.address,
    ),
  })
}
