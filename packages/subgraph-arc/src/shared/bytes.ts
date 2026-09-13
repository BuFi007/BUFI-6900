import { Bytes } from '@graphprotocol/graph-ts';

/**
 * True when every byte is zero, e.g. an unset bytes32 content hash.
 */
export function isZeroHash(value: Bytes): boolean {
  return value.equals(Bytes.fromUint8Array(new Uint8Array(value.length)));
}
