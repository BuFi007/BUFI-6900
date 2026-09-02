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
 * The BufiEarnModule manifest dependency slot that backs the runtime validation of `changeConfigHash`
 * (`OWNER_RUNTIME_VALIDATION_DEPENDENCY_INDEX` on the contract).
 */
export const EARN_MODULE_OWNER_RUNTIME_VALIDATION_DEPENDENCY_INDEX = 0

/**
 * The BufiEarnModule manifest dependency slot that backs the user operation validation of `changeConfigHash`
 * (`OWNER_USER_OP_VALIDATION_DEPENDENCY_INDEX` on the contract).
 */
export const EARN_MODULE_OWNER_USER_OP_VALIDATION_DEPENDENCY_INDEX = 1

/**
 * A 65-byte placeholder secp256k1 signature used to estimate the gas of session key user operations.
 *
 * It is well-formed (`r` below the curve order, low `s`, `v` = 28) so `ECDSA.tryRecover` yields an address instead of
 * reverting, which lets the plugin report a signature failure rather than abort the simulation.
 */
export const SESSION_KEY_STUB_SIGNATURE =
  // A REAL secp256k1 signature (private key 0x…01 over keccak256('bufi-session-key-stub')): bundlers simulate
  // validation with the stub, and BufiSessionKeyPlugin reverts `InvalidSignature` when `tryRecover` errors
  // (an off-curve dummy did exactly that on Circle's Fuji bundler, 2026-09-02). A well-formed signature recovers
  // to an address that is not the session key, so the plugin returns SIG_VALIDATION_FAILED instead — which
  // ERC-4337 bundlers tolerate during estimation, exactly like Circle's own STUB_SIGNATURE for the owner plugin.
  '0x7bb4968166c70b3bcda67cbe87b14d3ddde7aff65bc1cf90fd805d5c94c508690931dd416f12b3336b8f1e4683b1f88c288524c7a99769a2088a644edb697e661c' as Hex

/**
 * BUFI plugins as deployed on public testnets on 2026-09-01 (`contracts/deployments/avax-fuji.json`,
 * `arc-testnet.json`). Same CREATE2 salt on every chain, so the plugin addresses are identical. The Circle
 * addresses are Circle's production deployment on those chains.
 */
export const BUFI_TESTNET_PLUGINS = {
  bufiSessionKey: {
    address: '0x28504B34871Aa5a00269a960A9390187cbB5c070' as Hex,
    manifestHash:
      '0xa32b3449ba437645e2386051ad0fcb64b0c2a9fed66b2eb4349505a2cb11ff5d' as Hex,
  },
  bufiEarnModule: {
    address: '0x57D446a9A9c23d939035a924F7D3643B6eedE4Cf' as Hex,
    manifestHash:
      '0x5adab6895bc4f41df3405079667ae5103316a130ce3ebe225402958a96652e53' as Hex,
  },
} as const

/**
 * Avalanche Fuji (43113): Circle's canonical stack + BUFI testnet plugins.
 */
export const AVAX_FUJI_DEPLOYMENT: StackDeployment = {
  ...CIRCLE_CANONICAL_DEPLOYMENT,
  chainId: 43113,
  ...BUFI_TESTNET_PLUGINS,
  tokens: { usdc: '0x5425890298aed601595a70AB815c96711a31Bc65' },
}

/**
 * Arc testnet (5042002): Circle's canonical stack + BUFI testnet plugins.
 */
export const ARC_TESTNET_DEPLOYMENT: StackDeployment = {
  ...CIRCLE_CANONICAL_DEPLOYMENT,
  chainId: 5042002,
  ...BUFI_TESTNET_PLUGINS,
  tokens: { usdc: '0x3600000000000000000000000000000000000000' },
}
