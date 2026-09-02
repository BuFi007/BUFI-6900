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
  entryPoint07Abi as abi,
  getUserOperationHash,
  toSmartAccount,
} from 'viem/account-abstraction'
import { readContract } from 'viem/actions'

import { encodeExecuteWithSessionKey } from '../../actions/plugins/sessionKey/encodeExecuteWithSessionKey'
import { getDefaultVerificationGasLimit } from '../../utils/smartAccount/getDefaultVerificationGasLimit'
import {
  CIRCLE_CANONICAL_DEPLOYMENT,
  ENTRY_POINT_07,
  SESSION_KEY_STUB_SIGNATURE,
} from '../../constants'

import type {
  BufiSessionKeyAccountImplementation,
  ToBufiSessionKeyAccountParameters,
  ToBufiSessionKeyAccountReturnType,
} from '../../types'
import type { Address, Hex } from 'viem'
import type { UserOperation } from 'viem/account-abstraction'

/**
 * Creates a BUFI session key account: a viem `SmartAccount` that drives an already-deployed modular smart contract
 * account through the session key plugin, signing user operations with a session key instead of the owners.
 *
 * This is the "agent client". Calls are wrapped in `executeWithSessionKey(calls, sessionKey)`, which the plugin
 * validates with `ECDSA.recover(toEthSignedMessageHash(userOpHash), signature) == sessionKey` and then executes
 * through `executeFromPluginExternal` subject to the key's permissions. The account has no factory args because the
 * account must already exist, and cannot produce ERC-1271 signatures because the session key validation path only
 * covers user operations.
 * @param parameters - Parameters to use. See {@link ToBufiSessionKeyAccountParameters}.
 * @returns BUFI session key account. See {@link ToBufiSessionKeyAccountReturnType}.
 */
export async function toBufiSessionKeyAccount(
  parameters: ToBufiSessionKeyAccountParameters,
): Promise<ToBufiSessionKeyAccountReturnType> {
  const {
    client,
    account: address,
    sessionKey,
    plugin,
    deployment = CIRCLE_CANONICAL_DEPLOYMENT,
  } = parameters
  const entryPoint = {
    ...ENTRY_POINT_07,
    address: deployment.entryPoint,
  } as const

  return toSmartAccount({
    client: client as BufiSessionKeyAccountImplementation['client'],
    entryPoint,
    extend: { abi, plugin, sessionKey: sessionKey.address },
    getAddress: function (): Promise<Address> {
      return Promise.resolve(address)
    },
    /**
     * BufiSessionKeyPlugin requires a gas-limited session key to use its own address as the 192-bit nonce KEY
     * (`SessionKeyPermissions._checkUserOpPermissions`: `uint192(nonce >> 64) == uint192(uint160(sessionKey))`),
     * so gas-limit accounting cannot be bypassed by nonce-key hopping. Viem's `toSmartAccount` always supplies a
     * time-derived key of its own, so the key parameter is deliberately ignored here: a session-key account has
     * exactly one valid nonce lane.
     */
    getNonce: async function (): Promise<bigint> {
      const key = BigInt(sessionKey.address)
      return await readContract(client, {
        abi: entryPoint.abi,
        address: entryPoint.address,
        functionName: 'getNonce',
        args: [address, key],
      })
    },
    encodeCalls: function (
      calls: readonly {
        to: Hex
        data?: Hex | undefined
        value?: bigint | undefined
      }[],
    ): Promise<Hex> {
      return Promise.resolve(
        encodeExecuteWithSessionKey(
          calls.map((call) => ({
            target: call.to,
            value: call.value ?? 0n,
            data: call.data ?? '0x',
          })),
          sessionKey.address,
        ),
      )
    },
    async getFactoryArgs() {
      // The account is already deployed; a session key can never deploy it.
      return Promise.resolve({ factory: undefined, factoryData: undefined })
    },
    async getStubSignature() {
      return Promise.resolve(SESSION_KEY_STUB_SIGNATURE)
    },
    async signMessage() {
      return Promise.reject(
        new Error('A session key can only sign user operations.'),
      )
    },
    async signTypedData() {
      return Promise.reject(
        new Error('A session key can only sign user operations.'),
      )
    },
    async signUserOperation(parameters) {
      const { chainId = client.chain!.id, ...userOperation } = parameters

      const userOperationHash = getUserOperationHash({
        chainId,
        entryPointAddress: entryPoint.address,
        entryPointVersion: entryPoint.version,
        userOperation: {
          ...(userOperation as unknown as UserOperation),
          sender: address,
        },
      })

      // The plugin recovers the signer from `toEthSignedMessageHash(userOpHash)`, i.e. a personal_sign of the raw hash.
      return sessionKey.signMessage({ message: { raw: userOperationHash } })
    },
    userOperation: {
      /**
       * Mirrors `toCircleSmartAccount`: Circle's bundler enforces a verification-gas floor and publishes the
       * right default through `circle_getUserOperationGasPrice`, so ask it (a session-key account is always
       * deployed). An explicit `verificationGasLimit` is respected.
       */
      async estimateGas(userOperation) {
        const verificationGasLimit =
          userOperation.verificationGasLimit !== undefined
            ? BigInt(userOperation.verificationGasLimit)
            : BigInt(await getDefaultVerificationGasLimit(client, true))
        return Promise.resolve({ verificationGasLimit })
      },
    },
  })
}
