// SPDX-License-Identifier: Apache-2.0
// Regression: ISSUE-004 — a spend larger than the vault balance was judged "allow" by the EVM rule, so the
// playground showed a false MISMATCH, and the token program's InsufficientFunds surfaced as "custom error 0x1".
// Found by /qa on 2026-10-05
// Report: .gstack/qa-reports/run-20261005T005145Z/qa-report-localhost-2026-10-05.md
import { describe, expect, test } from 'bun:test'
import { expectedSpendOutcome, programErrorName } from '../src'

const owners = [
  { id: 'A', weight: 2 },
  { id: 'B', weight: 1 },
  { id: 'C', weight: 1 },
]
const base = { owners, thresholdWeight: 3, destinationAllowlisted: true, amount: 10n, available: 970n }

describe('expectedSpendOutcome (what EVM weighted multisig + AddressBook + ERC-20 would do)', () => {
  test.each([
    ['winning group, allowlisted, funded', { approvers: ['A', 'B'] }, true, 'weight reached, R is allowlisted'],
    ['losing group', { approvers: ['B', 'C'] }, false, 'weight 2 < 3'],
    ['not allowlisted', { approvers: ['A', 'B'], destinationAllowlisted: false }, false, 'not on the allowlist'],
    ['more than the vault holds', { approvers: ['A', 'B'], amount: 5000n }, false, 'vault holds 970'],
    ['exactly the vault balance', { approvers: ['A', 'B'], amount: 970n }, true, 'weight reached'],
  ] as const)('%s', (_name, patch, pass, why) => {
    const out = expectedSpendOutcome({ ...base, ...patch, approvers: new Set(patch.approvers) })
    expect(out.pass).toBe(pass)
    expect(out.why).toContain(why)
  })
})

describe('programErrorName', () => {
  test('SPL token InsufficientFunds is named, not "custom error 0x1"', () => {
    const err = { logs: ['Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [2]', 'Program log: Error: insufficient funds'], message: 'custom program error: 0x1' }
    expect(programErrorName(err)).toBe('InsufficientFunds')
  })
  test('anchor error codes still win', () => {
    expect(programErrorName({ logs: ['Program log: AnchorError occurred. Error Code: InvalidDestination.'] })).toBe('InvalidDestination')
  })
})
