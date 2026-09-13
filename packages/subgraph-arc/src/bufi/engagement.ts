import { BigInt, Bytes, crypto } from '@graphprotocol/graph-ts';

import { Agent, Engagement } from '../../generated/schema';

/**
 * BUFI: one edge of the reputation graph, from a client workspace to a
 * provider workspace. Jobs, settlements, refunds and ratings between the two
 * accumulate here, so "have these two settled work before?" is one load.
 */
export function engagementId(client: Agent, provider: Agent): Bytes {
  return Bytes.fromByteArray(crypto.keccak256(client.id.concat(provider.id)));
}

export function getOrCreateEngagement(
  client: Agent,
  provider: Agent,
  timestamp: BigInt
): Engagement {
  const id = engagementId(client, provider);
  let engagement = Engagement.load(id);
  if (engagement != null) return engagement;

  engagement = new Engagement(id);
  engagement.client = client.id;
  engagement.provider = provider.id;
  engagement.jobCount = BigInt.zero();
  engagement.settledJobCount = BigInt.zero();
  engagement.settledVolume = BigInt.zero();
  engagement.refundedVolume = BigInt.zero();
  engagement.feedbackCount = BigInt.zero();
  engagement.verifiedFeedbackCount = BigInt.zero();
  engagement.firstSeenAt = timestamp.toI64();
  engagement.updatedAt = timestamp.toI64();
  return engagement;
}
