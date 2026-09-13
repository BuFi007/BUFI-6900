import { BigInt } from '@graphprotocol/graph-ts';

import { Agent, AgentMetricPoint } from '../../generated/schema';

export const METRIC_SETTLED_AS_PROVIDER = 'SETTLED_AS_PROVIDER';
export const METRIC_SETTLED_AS_CLIENT = 'SETTLED_AS_CLIENT';
export const METRIC_REFUNDED_AS_CLIENT = 'REFUNDED_AS_CLIENT';

/**
 * BUFI: one timeseries point per settlement or refund, per workspace. The
 * `AgentDailyMetric` aggregation sums them into daily volume and count; graph
 * node assigns `id` and `timestamp` for timeseries entities.
 */
export function recordAgentMetric(
  agent: Agent,
  kind: string,
  amount: BigInt,
  timestamp: BigInt
): void {
  const point = new AgentMetricPoint(0);
  point.timestamp = timestamp.toI64();
  point.agent = agent.id;
  point.kind = kind;
  point.amount = amount;
  point.save();
}
