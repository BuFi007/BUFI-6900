/*
 * Copyright (c) 2026, Circle Internet Group, Inc. All rights reserved.
 * Modifications Copyright (c) 2026 BUFI. Licensed under the Apache License, Version 2.0.
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

import {
  MODULAR_WALLETS_TRANSPORT_KEY,
  MODULAR_WALLETS_TRANSPORT_NAME,
} from '../../constants'
import { ModularWalletsProvider } from '../../providers'
import { isCircleUrl } from '../../utils'

export interface ToModularTransportOptions {
  /**
   * Additional hosts (`host` or `host:port`) to trust as Modular Wallets API endpoints, for example a local mock
   * server. A trusted host makes the transport carry the Modular Wallets transport key, which is what makes
   * `toCircleSmartAccount` resolve the account address through `circle_getAddress`. BUFI modification.
   */
  trustedHosts?: readonly string[]
}

/**
 * Creates a custom transport instance with the given clientUrl and clientKey.
 * @param clientUrl - The Client URL to use.
 * @param clientKey - The Client key to use.
 * @param options - Transport options. See {@link ToModularTransportOptions}. BUFI modification.
 * @returns The custom transport instance.
 */
export const toModularTransport = (
  clientUrl: string,
  clientKey: string,
  options: ToModularTransportOptions = {},
) => {
  const provider = new ModularWalletsProvider(clientUrl, clientKey)
  const config = isCircleUrl(provider.clientUrl, options.trustedHosts)
    ? {
        key: MODULAR_WALLETS_TRANSPORT_KEY,
        name: MODULAR_WALLETS_TRANSPORT_NAME,
      }
    : undefined

  return custom(provider, config)
}
