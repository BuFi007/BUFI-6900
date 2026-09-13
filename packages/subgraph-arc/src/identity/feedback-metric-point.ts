import { BigDecimal, BigInt, Bytes } from '@graphprotocol/graph-ts';

import { FeedbackMetricPoint } from '../../generated/schema';

/**
 * Writes one timeseries point for the FeedbackMetricPoint-sourced
 * aggregations. New feedback writes a positive point; revocation writes the
 * inverse point, so cumulative sums describe active feedback (see
 * `FeedbackMetricPoint` in schema.graphql).
 */
export function createFeedbackMetricPoint(
  timestamp: BigInt,
  registryId: Bytes,
  agentId: Bytes,
  tag1: string,
  tag2: string,
  feedbackCountDelta: BigInt,
  valueDelta: BigDecimal
): void {
  const point = new FeedbackMetricPoint(0);
  point.timestamp = timestamp.toI64();
  point.registry = registryId;
  point.agent = agentId;
  point.tag1 = tag1;
  point.tag2 = tag2;
  point.feedbackCountDelta = feedbackCountDelta;
  point.valueDelta = valueDelta;
  point.save();
}
