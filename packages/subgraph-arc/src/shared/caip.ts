import { Address, BigInt } from '@graphprotocol/graph-ts';

/** The parts of a CAIP-10 account/contract identifier: `namespace:chainId:reference`. */
export class Caip10 {
  namespace: string | null;
  chainId: string | null;
  reference: string | null;

  constructor(namespace: string | null, chainId: string | null, reference: string | null) {
    this.namespace = namespace;
    this.chainId = chainId;
    this.reference = reference;
  }
}

/**
 * Splits a CAIP-10 identifier such as `eip155:11155111:0x8004...` into its
 * namespace, chain ID, and reference. Missing parts are null rather than
 * guessed: agent-supplied values are not guaranteed to be well formed.
 */
export function parseCaip10(value: string): Caip10 {
  const parts = value.split(':');
  if (parts.length < 3) return new Caip10(null, null, null);

  // A reference may itself contain ":" (unlikely for eip155, but CAIP-10
  // does not forbid it for other namespaces), so join everything after the
  // second segment back together.
  const reference = parts.slice(2).join(':');
  return new Caip10(parts[0], parts[1], reference);
}

/** Formats an EVM chain's identity registry as a CAIP-10 `eip155` identifier. */
export function toEip155Caip10(chainId: BigInt, address: Address): string {
  return 'eip155:' + chainId.toString() + ':' + address.toHexString();
}
