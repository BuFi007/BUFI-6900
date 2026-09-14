import { BigInt } from '@graphprotocol/graph-ts';
import { assert, describe, test } from 'matchstick-as';

import { MAX_TIMESTAMP_SECONDS, toTimestampSeconds } from '../src/shared/timestamp';

// The value that stopped v0.1.0: job 85652's expiredAt, Arc testnet block
// 45306949 (uint64 max, a third party's "never expires").
const UINT64_MAX = BigInt.fromString('18446744073709551615');
const UINT256_MAX = BigInt.fromString(
  '115792089237316195423570985008687907853269984665640564039457584007913129639935'
);

describe('toTimestampSeconds', () => {
  test('toI64 alone wraps uint64 max to -1 — the negative Timestamp graph-node refused', () => {
    assert.assertTrue(UINT64_MAX.toI64() == -1);
  });

  test('clamps anything past year 9999 to the maximum instead of wrapping', () => {
    assert.assertTrue(toTimestampSeconds(UINT64_MAX) == MAX_TIMESTAMP_SECONDS);
    assert.assertTrue(toTimestampSeconds(UINT256_MAX) == MAX_TIMESTAMP_SECONDS);
    assert.assertTrue(
      toTimestampSeconds(BigInt.fromI64(MAX_TIMESTAMP_SECONDS + 1)) == MAX_TIMESTAMP_SECONDS
    );
  });

  test('passes an ordinary deadline through unchanged', () => {
    assert.assertTrue(toTimestampSeconds(BigInt.fromI32(1780575154)) == 1780575154);
    assert.assertTrue(
      toTimestampSeconds(BigInt.fromI64(MAX_TIMESTAMP_SECONDS)) == MAX_TIMESTAMP_SECONDS
    );
    assert.assertTrue(toTimestampSeconds(BigInt.zero()) == 0);
  });
});
