import { Address, BigInt, Bytes, log } from '@graphprotocol/graph-ts';

import { Feedback } from '../../generated/schema';

/**
 * Builds the `Feedback` entity ID: UTF-8 bytes of
 * "<chainId>:<reputation registry address>:<agentId>:<client address>:
 * <feedbackIndex>". Same chain ID and ":" reasoning as `agentEntityId` in
 * ./agent.ts.
 */
export function feedbackEntityId(
  chainId: BigInt,
  registry: Address,
  agentId: BigInt,
  client: Address,
  feedbackIndex: BigInt
): Bytes {
  return Bytes.fromUTF8(
    chainId.toString() +
      ':' +
      registry.toHexString() +
      ':' +
      agentId.toString() +
      ':' +
      client.toHexString() +
      ':' +
      feedbackIndex.toString()
  );
}

/**
 * Loads a `Feedback` by entity ID (build it with `feedbackEntityId`), logging
 * a warning when the feedback was never recorded so handlers can simply
 * return.
 */
export function getFeedback(id: Bytes): Feedback | null {
  const feedback = Feedback.load(id);
  if (feedback == null) log.warning('Event for unknown feedback {}', [id.toString()]);
  return feedback;
}
