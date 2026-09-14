import { BigInt } from '@graphprotocol/graph-ts';

/**
 * 9999-12-31T23:59:59Z. Contract timestamps are uint256 and third parties
 * pass "never expires" as uint64 max (18446744073709551615 — job 85652 on
 * Arc testnet, block 45306949). `BigInt.toI64()` does not trap on that value:
 * it keeps the low eight bytes and yields -1, and graph-node refuses a
 * negative `Timestamp`, which stopped the v0.1.0 index at that block. Every
 * timestamp read from EVENT PARAMS goes through `toTimestampSeconds` so the
 * stored value is always inside the range graph-node accepts; block
 * timestamps never need it.
 */
export const MAX_TIMESTAMP_SECONDS: i64 = 253402300799;

const MAX_TIMESTAMP = BigInt.fromI64(MAX_TIMESTAMP_SECONDS);

export function toTimestampSeconds(value: BigInt): i64 {
  if (value.lt(BigInt.zero())) return 0;
  if (value.gt(MAX_TIMESTAMP)) return MAX_TIMESTAMP_SECONDS;
  return value.toI64();
}
