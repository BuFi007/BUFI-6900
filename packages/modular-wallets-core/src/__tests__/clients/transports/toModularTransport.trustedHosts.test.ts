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

import { custom } from 'viem'

import { toModularTransport } from '../../../clients'
import {
  MODULAR_WALLETS_TRANSPORT_KEY,
  MODULAR_WALLETS_TRANSPORT_NAME,
} from '../../../constants'
import { ModularWalletsProvider } from '../../../providers'

jest.mock('viem', () => ({
  custom: jest.fn(),
}))

describe('Clients > Transports > toModularTransport (trusted hosts)', () => {
  const sandboxUrl = 'http://127.0.0.1:8788/v1/rpc/w3s/buidl'
  const mockClientKey = '<my-client-key>'

  beforeEach(() => {
    ;(custom as jest.Mock).mockReturnValue({})
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  it('should mark a trusted sandbox host as a Modular Wallets transport', () => {
    toModularTransport(sandboxUrl, mockClientKey, {
      trustedHosts: ['127.0.0.1:8788'],
    })

    expect(custom).toHaveBeenCalledWith(expect.any(ModularWalletsProvider), {
      key: MODULAR_WALLETS_TRANSPORT_KEY,
      name: MODULAR_WALLETS_TRANSPORT_NAME,
    })
  })

  it('should not mark an untrusted host', () => {
    toModularTransport(sandboxUrl, mockClientKey, { trustedHosts: [] })

    expect(custom).toHaveBeenCalledWith(
      expect.any(ModularWalletsProvider),
      undefined,
    )
  })
})
