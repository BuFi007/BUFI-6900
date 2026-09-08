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

import { MockAccountAddress } from '../../__mocks__'
import { buildSpendFromYieldCalls } from '../../cascade'

import type { Address } from 'viem'

const USDC: Address = '0x3333333333333333333333333333333333333333'
const EURC: Address = '0x4444444444444444444444444444444444444444'
const USDC_VAULT: Address = '0x5555555555555555555555555555555555555555'
const EURC_VAULT: Address = '0x6666666666666666666666666666666666666666'
const PAYEE: Address = '0x7777777777777777777777777777777777777777'
const OTHER_PAYEE: Address = '0x8888888888888888888888888888888888888888'

const withdraw = (vault: Address, amount: bigint) => ({
  target: vault,
  value: 0n,
  data: encodeFunctionData({
    abi: erc4626Abi,
    functionName: 'withdraw',
    args: [amount, MockAccountAddress, MockAccountAddress],
  }),
})

const transfer = (token: Address, to: Address, amount: bigint) => ({
  target: token,
  value: 0n,
  data: encodeFunctionData({
    abi: erc20Abi,
    functionName: 'transfer',
    args: [to, amount],
  }),
})

const build = (params: {
  payments: { token: Address; to: Address; amount: bigint }[]
  balances?: { token: Address; balance: bigint }[]
  vaults?: { token: Address; vault: Address }[]
}) =>
  buildSpendFromYieldCalls({
    account: MockAccountAddress,
    payments: params.payments,
    balances: params.balances ?? [],
    vaults: params.vaults ?? [{ token: USDC, vault: USDC_VAULT }],
  })

describe('Cascade > buildSpendFromYieldCalls', () => {
  it('should source the full amount when nothing is liquid', () => {
    const { calls, withdrawals, transfers, sourced } = build({
      payments: [{ token: USDC, to: PAYEE, amount: 250_000_000n }],
      balances: [{ token: USDC, balance: 0n }],
    })

    expect(withdrawals).toEqual([withdraw(USDC_VAULT, 250_000_000n)])
    expect(transfers).toEqual([transfer(USDC, PAYEE, 250_000_000n)])
    expect(calls).toEqual([...withdrawals, ...transfers])
    expect(sourced).toEqual([
      { token: USDC, vault: USDC_VAULT, amount: 250_000_000n },
    ])
  })

  it('should source only the shortfall when the balance is partial', () => {
    const { withdrawals, sourced } = build({
      payments: [{ token: USDC, to: PAYEE, amount: 250_000_000n }],
      balances: [{ token: USDC, balance: 100_000_000n }],
    })

    expect(withdrawals).toEqual([withdraw(USDC_VAULT, 150_000_000n)])
    expect(sourced[0]?.amount).toBe(150_000_000n)
  })

  it('should not source when the balance already covers the payment', () => {
    const { calls, withdrawals, sourced } = build({
      payments: [{ token: USDC, to: PAYEE, amount: 250_000_000n }],
      balances: [{ token: USDC, balance: 250_000_000n }],
    })

    expect(withdrawals).toEqual([])
    expect(sourced).toEqual([])
    expect(calls).toEqual([transfer(USDC, PAYEE, 250_000_000n)])
  })

  it('should treat an unknown balance as zero', () => {
    const { withdrawals } = build({
      payments: [{ token: USDC, to: PAYEE, amount: 5n }],
      balances: [{ token: EURC, balance: 1_000n }],
      vaults: [{ token: USDC, vault: USDC_VAULT }],
    })

    expect(withdrawals).toEqual([withdraw(USDC_VAULT, 5n)])
  })

  it('should aggregate several payments of the same token into ONE withdrawal', () => {
    const { withdrawals, transfers, sourced } = build({
      payments: [
        { token: USDC, to: PAYEE, amount: 100_000_000n },
        { token: USDC, to: OTHER_PAYEE, amount: 60_000_000n },
      ],
      balances: [{ token: USDC, balance: 10_000_000n }],
    })

    expect(withdrawals).toEqual([withdraw(USDC_VAULT, 150_000_000n)])
    expect(sourced).toHaveLength(1)
    expect(transfers).toHaveLength(2)
  })

  it('should source each token from its own vault, in first-appearance order', () => {
    const { calls, withdrawals } = build({
      payments: [
        { token: EURC, to: PAYEE, amount: 20n },
        { token: USDC, to: PAYEE, amount: 30n },
      ],
      balances: [],
      vaults: [
        { token: USDC, vault: USDC_VAULT },
        { token: EURC, vault: EURC_VAULT },
      ],
    })

    expect(withdrawals).toEqual([
      withdraw(EURC_VAULT, 20n),
      withdraw(USDC_VAULT, 30n),
    ])
    expect(calls).toEqual([
      withdraw(EURC_VAULT, 20n),
      withdraw(USDC_VAULT, 30n),
      transfer(EURC, PAYEE, 20n),
      transfer(USDC, PAYEE, 30n),
    ])
  })

  it('should put every withdrawal before every transfer', () => {
    const { calls } = build({
      payments: [
        { token: USDC, to: PAYEE, amount: 10n },
        { token: EURC, to: PAYEE, amount: 10n },
      ],
      vaults: [
        { token: USDC, vault: USDC_VAULT },
        { token: EURC, vault: EURC_VAULT },
      ],
    })

    const firstTransfer = calls.findIndex(
      (c) => c.target === USDC && c.data.startsWith('0xa9059cbb'),
    )
    const lastWithdrawal = calls.map((c) => c.target).lastIndexOf(EURC_VAULT)
    expect(lastWithdrawal).toBeLessThan(firstTransfer)
  })

  it('should match token addresses case-insensitively', () => {
    const { withdrawals } = build({
      payments: [
        { token: USDC.toUpperCase() as Address, to: PAYEE, amount: 10n },
      ],
      balances: [{ token: USDC, balance: 4n }],
      vaults: [{ token: USDC, vault: USDC_VAULT }],
    })

    expect(withdrawals).toEqual([withdraw(USDC_VAULT, 6n)])
  })

  it('should fail closed when a short token has no adopted vault', () => {
    expect(() =>
      build({
        payments: [{ token: EURC, to: PAYEE, amount: 1n }],
        balances: [],
        vaults: [{ token: USDC, vault: USDC_VAULT }],
      }),
    ).toThrow(/no adopted vault/)
  })

  it('should not need a vault for a token that is already liquid', () => {
    const { calls } = build({
      payments: [{ token: EURC, to: PAYEE, amount: 1n }],
      balances: [{ token: EURC, balance: 1n }],
      vaults: [],
    })

    expect(calls).toEqual([transfer(EURC, PAYEE, 1n)])
  })

  it('should keep a zero-amount payment as a transfer and source nothing', () => {
    const { withdrawals, transfers } = build({
      payments: [{ token: USDC, to: PAYEE, amount: 0n }],
      balances: [],
    })

    expect(withdrawals).toEqual([])
    expect(transfers).toEqual([transfer(USDC, PAYEE, 0n)])
  })

  it('should reject a negative amount', () => {
    expect(() =>
      build({ payments: [{ token: USDC, to: PAYEE, amount: -1n }] }),
    ).toThrow(/negative amount/)
  })

  // Cross-check against the on-chain proof: contracts/test/bufi/v0.7/session/SpendFromVault.t.sol builds the
  // same two calls in Solidity. If viem's erc4626Abi ever diverges from withdraw(uint256,address,address), the
  // SDK would silently emit calldata the session key's access list rejects at validation.
  it('should emit the canonical withdraw and transfer selectors', () => {
    const { withdrawals, transfers } = build({
      payments: [{ token: USDC, to: PAYEE, amount: 250_000_000n }],
      balances: [],
    })

    expect(withdrawals[0]?.data.slice(0, 10)).toBe('0xb460af94') // withdraw(uint256,address,address)
    expect(transfers[0]?.data.slice(0, 10)).toBe('0xa9059cbb') // transfer(address,uint256)
  })

  it('should return empty output for no payments', () => {
    const { calls, withdrawals, transfers, sourced } = build({ payments: [] })

    expect(calls).toEqual([])
    expect(withdrawals).toEqual([])
    expect(transfers).toEqual([])
    expect(sourced).toEqual([])
  })
})
