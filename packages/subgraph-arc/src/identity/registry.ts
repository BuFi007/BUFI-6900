import { Address, BigInt, Bytes } from '@graphprotocol/graph-ts';

/**
 * Builds the shared `IdentityRegistry`/`ReputationRegistry` entity ID: UTF-8
 * bytes of "<chainId>:<registry address>" (schema.graphql's `IdentityRegistry`
 * comment). Same reasoning as `agentEntityId` in ./agent.ts: both registry
 * contracts redeploy at the same address on several chains (see
 * chain.config.json), so cross-deployment consumers would otherwise collide
 * on byte-identical IDs.
 */
export function registryEntityId(chainId: BigInt, address: Address): Bytes {
  return Bytes.fromUTF8(chainId.toString() + ':' + address.toHexString());
}
