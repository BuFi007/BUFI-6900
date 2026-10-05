// SPDX-License-Identifier: Apache-2.0
// Regression: UT-8 — the Solana burn-intent encoder wrote only the low 128 bits of uint256 fields.
// Found by the 2026-10-05 security review (docs/SECURITY-REVIEW-GATEWAY.md).
import { expect, test } from 'bun:test'
import { u256be } from '../src'

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')

test.each([0n, 1n, 2_010_000n, (1n << 64n) + 5n, (1n << 128n) + 9n, (1n << 200n) + 7n, (1n << 256n) - 1n])('u256be(%p) is the full 32-byte big-endian value', (v) => {
  expect(hex(u256be(v))).toBe(v.toString(16).padStart(64, '0'))
})

test('values outside uint256 are refused, not truncated', () => {
  expect(() => u256be(1n << 256n)).toThrow(RangeError)
  expect(() => u256be(-1n)).toThrow(RangeError)
})
