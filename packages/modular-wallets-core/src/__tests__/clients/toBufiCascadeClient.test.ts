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

import { createBundlerClient } from 'viem/account-abstraction'
import { sepolia } from 'viem/chains'

import { toModularTransport } from '../../__mocks__'
import { bufiCascadeActions, toBufiCascadeClient } from '../../clients'
import { AccountType } from '../../types'

describe('Clients > toBufiCascadeClient', () => {
  const client = createBundlerClient({
    chain: sepolia,
    transport: toModularTransport({ accountType: AccountType.WebAuthn }),
  })

  it('should extend the client with the cascade actions', () => {
    const cascadeClient = toBufiCascadeClient({ client })

    for (const name of Object.keys(bufiCascadeActions(client))) {
      expect(typeof cascadeClient[name as keyof typeof cascadeClient]).toBe(
        'function',
      )
    }
    expect(cascadeClient.chain).toBe(sepolia)
  })
})
