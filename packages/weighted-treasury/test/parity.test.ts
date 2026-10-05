// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from 'bun:test'
import {
  compileEvm,
  compileSquads,
  isWinning,
  minimalWinningCoalitions,
  SpecNotExpressible,
  type WeightedTreasurySpec,
} from '../src'

const SOL = [
  '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
  '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
  'GQ6x9QZ1yYbJkJ5hY6gH6k6wJ8xQ5Zt2bYhXr8uUPd3V',
  'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH',
  'Fe3s8nNGFfQzeiDu5vRPfaXR7sGKqvB4Xc6r2HdKiXzS',
  '2Zt8RZ8kmE3a7d5hNaB4wXb5yq9vjqY1dBxQpWZ3VmcN',
]
const recipientSol = 'AQoKYV7tYpTrFZN6P5oUufbQKAUr9mNYGe1TTJC9wajM'
const recipientEvm = '0x00000000000000000000000000000000000000aa'
const evmOf = (i: number) => `0x${(i + 1).toString(16).padStart(40, '0')}`
const USDC_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'

function spec(weights: number[], thresholdWeight: number, extra: Partial<WeightedTreasurySpec> = {}): WeightedTreasurySpec {
  return {
    version: 1,
    owners: weights.map((weight, i) => ({ id: `o${i}`, weight, evm: evmOf(i), solana: SOL[i] })),
    thresholdWeight,
    allowlist: [{ label: 'payroll', evm: recipientEvm, solana: recipientSol }],
    assets: [{ symbol: 'USDC', solanaMint: USDC_DEVNET, solanaDecimals: 6 }],
    adminTimelockSeconds: 86_400,
    ...extra,
  }
}

/** Every subset of owners; the reference rule (EVM) vs. "some Squads policy's signers ⊆ subset". */
function assertParity(weights: number[], threshold: number) {
  const s = spec(weights, threshold)
  const plan = compileSquads(s)
  const members = s.owners
  for (let mask = 0; mask < 1 << members.length; mask++) {
    const ids = new Set(members.filter((_, i) => mask & (1 << i)).map((m) => m.id))
    const keys = new Set(members.filter((m) => ids.has(m.id)).map((m) => m.solana!))
    const evmAccepts = isWinning(members, threshold, ids)
    const squadsAccepts = plan.policies.some((p) => p.signers.every((sig) => keys.has(sig.key)) && p.signers.length >= p.threshold)
    expect({ mask, accepts: squadsAccepts }).toEqual({ mask, accepts: evmAccepts })
  }
}

describe('weighted rule ⇔ Squads policies, every owner subset', () => {
  test('uniform 2-of-3', () => assertParity([1, 1, 1], 2))
  test('skewed A=2,B=1,C=1 @3', () => assertParity([2, 1, 1], 3))
  test('dominant owner A=3,B=1,C=1 @3 (A alone wins)', () => assertParity([3, 1, 1], 3))
  test('five owners mixed weights', () => assertParity([5, 3, 2, 2, 1], 7))
  test('six owners, threshold 1 of total', () => assertParity([1, 2, 3, 4, 5, 6], 1))
  test('unanimous', () => assertParity([4, 1, 1, 1], 7))

  test('randomised: 200 specs up to 6 owners', () => {
    let seed = 42
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    for (let run = 0; run < 200; run++) {
      const n = 1 + rand(6)
      const weights = Array.from({ length: n }, () => 1 + rand(10))
      const total = weights.reduce((a, b) => a + b, 0)
      assertParity(weights, 1 + rand(total))
    }
  })
})

describe('coalitions', () => {
  test('uniform weights collapse to one group per k-subset', () => {
    expect(minimalWinningCoalitions([{ id: 'a', weight: 1 }, { id: 'b', weight: 1 }, { id: 'c', weight: 1 }], 2)).toEqual([
      ['a', 'b'],
      ['a', 'c'],
      ['b', 'c'],
    ])
  })
  test('A=2,B=1,C=1 @3 → {A,B} and {A,C}; {B,C} is not winning', () => {
    expect(minimalWinningCoalitions([{ id: 'a', weight: 2 }, { id: 'b', weight: 1 }, { id: 'c', weight: 1 }], 3)).toEqual([
      ['a', 'b'],
      ['a', 'c'],
    ])
  })
})

describe('allowlist binds every policy, and empty never reaches Squads', () => {
  test('every policy carries the full, non-empty allowlist', () => {
    const plan = compileSquads(spec([2, 1, 1], 3))
    for (const p of plan.policies) expect(p.payload.fields[0].destinations).toEqual([recipientSol])
  })
  test('empty allowlist is refused (Squads would read it as "anyone")', () => {
    expect(() => compileSquads(spec([1, 1], 2, { allowlist: [] }))).toThrow(SpecNotExpressible)
    expect(() => compileEvm(spec([1, 1], 2, { allowlist: [] }))).toThrow(SpecNotExpressible)
  })
})

describe('reject, never weaken', () => {
  test('a budget cannot compile to EVM (no plugin enforces it)', () => {
    const s = spec([1, 1], 2, {
      assets: [{ symbol: 'USDC', solanaMint: USDC_DEVNET, budget: { maxPerPeriod: 1_000_000n, period: 'daily' } }],
    })
    expect(() => compileEvm(s)).toThrow(/budgets have no EVM enforcement/)
    expect(compileSquads(s).policies[0]!.payload.fields[0].quantityConstraints.maxPerPeriod).toBe(1_000_000n)
  })
  test('policy explosion past the cap is refused, not truncated', () => {
    // 8 uniform owners @4 → C(8,4) = 70 groups > 64
    expect(() => compileSquads(spec([1, 1, 1, 1, 1, 1], 3), { maxPolicies: 19 })).toThrow(/over the cap/)
  })
  test('owner without a Solana key is refused for Squads but fine for EVM', () => {
    const s = spec([1, 1], 2)
    const owners = [s.owners[0]!, { ...s.owners[1]!, solana: undefined }]
    expect(() => compileSquads({ ...s, owners })).toThrow(/no Solana key/)
    expect(compileEvm({ ...s, owners }).owners).toHaveLength(2)
  })
  test('threshold above total weight is refused', () => {
    expect(() => compileSquads(spec([1, 1], 3))).toThrow(SpecNotExpressible)
  })
})

describe('shapes', () => {
  test('EVM output matches the treasury-kit fields', () => {
    const evm = compileEvm(spec([2, 1, 1], 3))
    expect(evm.thresholdWeight).toBe(3n)
    expect(evm.owners.map((o) => o.weight)).toEqual([2n, 1n, 1n])
    expect(evm.allowlist).toEqual([recipientEvm])
  })
  test('Squads settings: all owners, unanimous admin, timelock carried', () => {
    const plan = compileSquads(spec([2, 1, 1], 3))
    expect(plan.settings.threshold).toBe(3)
    expect(plan.settings.timeLock).toBe(86_400)
    expect(plan.settings.signers.every((s) => s.permissions.mask === 7)).toBe(true)
    expect(plan.policies).toHaveLength(2)
    expect(plan.policies.map((p) => p.threshold)).toEqual([2, 2])
  })
})
