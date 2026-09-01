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

import { entryPoint07Address } from 'viem/account-abstraction'

import {
  CIRCLE_CANONICAL_DEPLOYMENT,
  CIRCLE_COLD_STORAGE_ADDRESS_BOOK_PLUGIN,
  CIRCLE_PLUGIN_MANAGER,
  CIRCLE_WEIGHTED_WEB_AUTHN_MULTISIG_PLUGIN,
  FACTORY,
  SESSION_KEY_STUB_SIGNATURE,
  UPGRADABLE_MSCA,
  WEIGHTED_MULTISIG_OWNER_USER_OP_VALIDATION_FUNCTION_ID,
  WEIGHTED_MULTISIG_UNIMPLEMENTED_RUNTIME_VALIDATION_FUNCTION_ID,
} from '../../constants'

describe('Constants > deployments', () => {
  it('should describe the canonical Circle stack', () => {
    expect(CIRCLE_CANONICAL_DEPLOYMENT).toEqual({
      entryPoint: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
      upgradableMscaFactory: '0x0000000DF7E6c9Dc387cAFc5eCBfa6c3a6179AdD',
      upgradableMsca: '0xA70F1296869DA9D7CB69578123F21888E6dB2B62',
      pluginManager: '0x00000005e69188224e4dEeF607801916DC0936d5',
      weightedWebauthnMultisig: {
        address: '0x0000000C984AFf541D6cE86Bb697e68ec57873C8',
        manifestHash:
          '0xa043327d77a74c1c55cfa799284b831fe09535a88b9f5fa4173d334e5ba0fd91',
      },
      coldStorageAddressBook: {
        address: '0x0000000d81083B16EA76dfab46B0315B0eDBF3d0',
        manifestHash:
          '0x9d177c1c9573b10436b693b7a49f0face36b677c1606a2c579bba1415be349d8',
      },
    })
  })

  it('should stay in sync with the upstream compatibility constants', () => {
    expect(CIRCLE_CANONICAL_DEPLOYMENT.entryPoint).toBe(entryPoint07Address)
    expect(CIRCLE_CANONICAL_DEPLOYMENT.upgradableMscaFactory).toBe(
      FACTORY.address,
    )
    expect(CIRCLE_CANONICAL_DEPLOYMENT.upgradableMsca).toBe(
      UPGRADABLE_MSCA.address,
    )
    expect(CIRCLE_CANONICAL_DEPLOYMENT.pluginManager).toBe(
      CIRCLE_PLUGIN_MANAGER.address,
    )
    expect(CIRCLE_CANONICAL_DEPLOYMENT.weightedWebauthnMultisig).toEqual(
      CIRCLE_WEIGHTED_WEB_AUTHN_MULTISIG_PLUGIN,
    )
    expect(CIRCLE_CANONICAL_DEPLOYMENT.coldStorageAddressBook).toEqual(
      CIRCLE_COLD_STORAGE_ADDRESS_BOOK_PLUGIN,
    )
  })

  it('should not ship BUFI plugins on the canonical stack', () => {
    expect(CIRCLE_CANONICAL_DEPLOYMENT.bufiSessionKey).toBeUndefined()
    expect(CIRCLE_CANONICAL_DEPLOYMENT.bufiEarnModule).toBeUndefined()
  })

  it('should wire dependency slots to distinct weighted multisig function ids', () => {
    expect(WEIGHTED_MULTISIG_OWNER_USER_OP_VALIDATION_FUNCTION_ID).toBe(0)
    expect(WEIGHTED_MULTISIG_UNIMPLEMENTED_RUNTIME_VALIDATION_FUNCTION_ID).toBe(
      1,
    )
  })

  it('should use a 65-byte session key stub signature', () => {
    expect(SESSION_KEY_STUB_SIGNATURE).toMatch(/^0x[0-9a-f]{130}$/)
  })
})
