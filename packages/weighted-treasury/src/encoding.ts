// SPDX-License-Identifier: Apache-2.0
/** Full 256-bit big-endian encoding (all four 64-bit words), as Circle's Solana burn-intent layout expects. */
export function u256be(v: bigint): Uint8Array {
  if (v < 0n || v >> 256n !== 0n) throw new RangeError(`value ${v} does not fit in uint256`)
  const out = new Uint8Array(32)
  const view = new DataView(out.buffer)
  for (let i = 0; i < 4; i++) view.setBigUint64(i * 8, (v >> BigInt(64 * (3 - i))) & 0xffffffffffffffffn, false)
  return out
}
