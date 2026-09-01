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

import { bufiCascadeActions } from './decorators'

import type { BufiCascadeActions } from './decorators'
import type { Chain, Client, RpcSchema, Transport } from 'viem'
import type { SmartAccount } from 'viem/account-abstraction'

export interface ToBufiCascadeClientParameters {
  /**
   * The client instance, typically a bundler client with the account attached.
   */
  client: Client<Transport, Chain | undefined, SmartAccount | undefined>
}

export type BufiCascadeClient = Client<
  Transport,
  Chain | undefined,
  SmartAccount | undefined,
  RpcSchema,
  BufiCascadeActions
>

/**
 * Transforms a client into a BUFI cascade client using decorators.
 * @param parameters - Parameters to use. See {@link ToBufiCascadeClientParameters}.
 * @returns A decorated BUFI cascade client. See {@link BufiCascadeClient}.
 */
export function toBufiCascadeClient({
  client,
}: ToBufiCascadeClientParameters): BufiCascadeClient {
  const bufiCascadeClient =
    client.extend<BufiCascadeActions>(bufiCascadeActions)

  return bufiCascadeClient
}
