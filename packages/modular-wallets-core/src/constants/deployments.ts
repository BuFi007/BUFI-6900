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
  CIRCLE_WEIGHTED_WEB_AUTHN_MULTISIG_PLUGIN,
  ENTRY_POINT_07,
  FACTORY,
  UPGRADABLE_MSCA,
} from './smartAccount'

import type { StackDeployment } from '../types/bufi'
import type { Hex } from 'viem'

/**
 * The Circle PluginManager library used by the canonical UpgradableMSCA.
 */
export const CIRCLE_PLUGIN_MANAGER = {
  address: '0x00000005e69188224e4dEeF607801916DC0936d5' as Hex,
} as const

/**
 * The Circle ColdStorageAddressBookPlugin. Restricts ERC-20/721/1155 transfer recipients of the account to an
 * on-chain allowlist. Deployed at the same address on every supported chain.
 */
export const CIRCLE_COLD_STORAGE_ADDRESS_BOOK_PLUGIN = {
  address: '0x0000000d81083B16EA76dfab46B0315B0eDBF3d0' as Hex,
  manifestHash:
    '0x9d177c1c9573b10436b693b7a49f0face36b677c1606a2c579bba1415be349d8' as Hex,
} as const

/**
 * The canonical Circle Modular Wallets stack as deployed on every supported chain.
 *
 * Every deployment-parametrized function in this SDK defaults to it, which keeps the upstream behaviour byte-for-byte
 * identical when no deployment is passed. The BUFI plugins are not part of the canonical stack.
 */
export const CIRCLE_CANONICAL_DEPLOYMENT: StackDeployment = {
  entryPoint: ENTRY_POINT_07.address,
  upgradableMscaFactory: FACTORY.address,
  upgradableMsca: UPGRADABLE_MSCA.address,
  pluginManager: CIRCLE_PLUGIN_MANAGER.address,
  weightedWebauthnMultisig: {
    address: CIRCLE_WEIGHTED_WEB_AUTHN_MULTISIG_PLUGIN.address,
    manifestHash: CIRCLE_WEIGHTED_WEB_AUTHN_MULTISIG_PLUGIN.manifestHash,
  },
  coldStorageAddressBook: {
    address: CIRCLE_COLD_STORAGE_ADDRESS_BOOK_PLUGIN.address,
    manifestHash: CIRCLE_COLD_STORAGE_ADDRESS_BOOK_PLUGIN.manifestHash,
  },
}

/**
 * The WeightedWebauthnMultisigPlugin validation function id that validates user operations signed by the owners.
 */
export const WEIGHTED_MULTISIG_OWNER_USER_OP_VALIDATION_FUNCTION_ID = 0

/**
 * A validation function id the WeightedWebauthnMultisigPlugin deliberately does NOT implement.
 *
 * Plugins whose manifest declares a runtime-validation dependency (the address book and the session key plugin) are
 * wired to this id so that the runtime path is fail-closed: the multisig plugin only validates user operations.
 */
export const WEIGHTED_MULTISIG_UNIMPLEMENTED_RUNTIME_VALIDATION_FUNCTION_ID = 1

/**
 * A 65-byte placeholder secp256k1 signature used to estimate the gas of session key user operations.
 *
 * It is well-formed (`r` below the curve order, low `s`, `v` = 28) so `ECDSA.tryRecover` yields an address instead of
 * reverting, which lets the plugin report a signature failure rather than abort the simulation.
 */
export const SESSION_KEY_STUB_SIGNATURE =
  '0xfffffffffffffffffffffffffffffff0000000000000000000000000000000077aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c' as Hex
