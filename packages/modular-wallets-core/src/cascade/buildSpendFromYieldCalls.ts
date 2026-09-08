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

import { encodeFunctionData, erc20Abi, erc4626Abi } from 'viem'

import type { Call } from '../types'
import type { Address } from 'viem'

/**
 * One ERC-20 payment an agent is about to make.
 */
export interface YieldPayment {
  /**
   * The ERC-20 token to pay in.
   */
  token: Address
  /**
   * The recipient. Must be on the account's AddressBook when the recipient hook is installed.
   */
  to: Address
  /**
   * The amount, in the token's own decimals.
   */
  amount: bigint
}

/**
 * The account's liquid balance of one token, as read on-chain.
 */
export interface TokenBalance {
  token: Address
  balance: bigint
}

/**
 * A `(token, vault)` pair from the account's adopted earn config. The shape `getEarnConfigs` returns.
 */
export interface VaultConfig {
  token: Address
  vault: Address
}

export interface BuildSpendFromYieldCallsParameters {
  /**
   * The agent account. It is both the receiver and the owner of every withdrawal, so no share approval is needed.
   */
  account: Address
  /**
   * The payments to make.
   */
  payments: readonly YieldPayment[]
  /**
   * The account's liquid balances. Read with `readContract(erc20Abi, 'balanceOf')`. A token absent here is
   * treated as a zero balance.
   */
  balances: readonly TokenBalance[]
  /**
   * The account's adopted `(token, vault)` pairs. Read with `getEarnConfigs`.
   */
  vaults: readonly VaultConfig[]
}

export interface SpendFromYieldCalls {
  /**
   * The `IERC4626.withdraw` calls that source the shortfall, one per token that needs one, in the order the
   * tokens first appear in `payments`.
   */
  withdrawals: Call[]
  /**
   * The `IERC20.transfer` calls, in the order given.
   */
  transfers: Call[]
  /**
   * `withdrawals` followed by `transfers` — the array to hand to `encodeExecuteWithSessionKey`.
   */
  calls: Call[]
  /**
   * What was sourced per token. Empty when everything was already liquid.
   */
  sourced: { token: Address; vault: Address; amount: bigint }[]
}

const normalize = (address: Address): string => address.toLowerCase()

/**
 * Builds the call array for an agent that pays out of a yield position: redeem the shortfall, then transfer, in
 * one `executeWithSessionKey` user operation.
 *
 * This is the layer FluidKey does it in. `fluidkey/fluidkey-earn-module` has no `withdraw` or `redeem` anywhere in
 * `src/FluidkeyEarnModule.sol` — its entire value surface is wrap, approve and `IERC4626.deposit`. Spending
 * "straight from yield" happens in the transaction their app builds, not in the module. `BufiEarnModule` inherits
 * that shape, so the sourcing leg belongs here rather than in a new on-chain plugin.
 *
 * Two grant-time preconditions, both proved in `contracts/test/bufi/v0.7/session/SpendFromVault.t.sol`.
 * First, every vault this returns a withdrawal for must be on the account's AddressBook:
 * `withdraw(uint256,address,address)` carries no decodable token recipient, so `BufiSessionRecipientHookPlugin`
 * judges it by its target. Second, the vault must NOT be registered with an ERC-20 spend limit in the key's
 * access list — a contract flagged `isERC20WithSpendLimit` admits `transfer` and `approve` only, so the
 * withdrawal would be rejected at validation. Vault shares are an ERC-20, so this is easy to get wrong.
 * @param parameters - Parameters to use. See {@link BuildSpendFromYieldCallsParameters}.
 * @returns The calls. See {@link SpendFromYieldCalls}.
 * @throws Error if a payment is negative, or if a token is short and has no adopted vault to source it from.
 */
export function buildSpendFromYieldCalls({
  account,
  payments,
  balances,
  vaults,
}: BuildSpendFromYieldCallsParameters): SpendFromYieldCalls {
  const liquid = new Map<string, bigint>()
  for (const { token, balance } of balances) {
    liquid.set(normalize(token), balance)
  }

  const vaultOf = new Map<string, Address>()
  for (const { token, vault } of vaults) {
    vaultOf.set(normalize(token), vault)
  }

  // Aggregate per token, keeping first-appearance order so the output is deterministic.
  const needed = new Map<string, { token: Address; amount: bigint }>()
  for (const payment of payments) {
    if (payment.amount < 0n) {
      throw new Error(
        `buildSpendFromYieldCalls: negative amount for token ${payment.token}`,
      )
    }
    const key = normalize(payment.token)
    const entry = needed.get(key)
    if (entry === undefined) {
      needed.set(key, { token: payment.token, amount: payment.amount })
    } else {
      entry.amount += payment.amount
    }
  }

  const withdrawals: Call[] = []
  const sourced: { token: Address; vault: Address; amount: bigint }[] = []

  for (const [key, { token, amount }] of needed) {
    const shortfall = amount - (liquid.get(key) ?? 0n)
    if (shortfall <= 0n) continue

    const vault = vaultOf.get(key)
    if (vault === undefined) {
      throw new Error(
        `buildSpendFromYieldCalls: short ${shortfall} of ${token} and no adopted vault to source it from`,
      )
    }

    withdrawals.push({
      target: vault,
      value: 0n,
      data: encodeFunctionData({
        abi: erc4626Abi,
        functionName: 'withdraw',
        args: [shortfall, account, account],
      }),
    })
    sourced.push({ token, vault, amount: shortfall })
  }

  const transfers: Call[] = payments.map((payment) => ({
    target: payment.token,
    value: 0n,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer',
      args: [payment.to, payment.amount],
    }),
  }))

  return {
    withdrawals,
    transfers,
    calls: [...withdrawals, ...transfers],
    sourced,
  }
}
