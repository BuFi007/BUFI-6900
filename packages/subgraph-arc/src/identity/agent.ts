import { Address, BigInt, Bytes, log } from '@graphprotocol/graph-ts';

import { Agent } from '../../generated/schema';

/**
 * Builds the `Agent` entity ID: UTF-8 bytes of
 * "<chainId>:<identity registry address>:<agentId>" (schema.graphql's `Agent`
 * comment). The chain ID makes the ID globally unique: the ERC-8004 registries
 * are deployed at the same address on several chains (see chain.config.json),
 * so cross-deployment consumers would otherwise collide on byte-identical IDs.
 *
 * The parts are joined with ":" rather than concatenated as raw bytes:
 * `chainId` and `agentId` are variable-length decimal strings, so a delimiter
 * keeps the encoding unambiguous. The result also reads as a CAIP-10-style
 * account ID, matching how ERC-8004 registration documents reference agents.
 */
export function agentEntityId(chainId: BigInt, registry: Address, agentId: BigInt): Bytes {
  return Bytes.fromUTF8(
    chainId.toString() + ':' + registry.toHexString() + ':' + agentId.toString()
  );
}

/**
 * Loads an `Agent` by entity ID (build it with `agentEntityId`), logging a
 * warning when the agent was never registered so handlers can simply return.
 */
export function getAgent(id: Bytes): Agent | null {
  const agent = Agent.load(id);
  if (agent == null) log.warning('Event for unknown agent {}', [id.toString()]);
  return agent;
}
