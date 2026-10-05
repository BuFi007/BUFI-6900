// SPDX-License-Identifier: Apache-2.0
// Regression: ISSUE-003 — the admin timelock countdown used the browser's clock, so it read "elapsed" while the
// program (which uses the chain's Clock sysvar) still answered TimeLockNotReleased on a lagging localnet.
// Found by /qa on 2026-10-05
// Report: .gstack/qa-reports/run-20261005T005145Z/qa-report-localhost-2026-10-05.md
import { expect, test } from 'bun:test'
import { timelockRemaining } from '../src'

test.each([
  ['chain clock behind the wall clock: still locked', { approvedAt: 1000, timeLock: 10, chainNow: 1004 }, 6],
  ['exactly at unlock', { approvedAt: 1000, timeLock: 10, chainNow: 1010 }, 0],
  ['past unlock', { approvedAt: 1000, timeLock: 10, chainNow: 1030 }, 0],
  ['no timelock', { approvedAt: 1000, timeLock: 0, chainNow: 1000 }, 0],
] as const)('%s', (_name, input, remaining) => {
  expect(timelockRemaining(input)).toBe(remaining)
})
