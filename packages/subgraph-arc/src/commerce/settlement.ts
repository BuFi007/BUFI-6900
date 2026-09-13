import { BigInt, Bytes, ethereum } from '@graphprotocol/graph-ts';

import { Agent, AgenticCommerce, Engagement, Job } from '../../generated/schema';
import {
  METRIC_REFUNDED_AS_CLIENT,
  METRIC_SETTLED_AS_CLIENT,
  METRIC_SETTLED_AS_PROVIDER,
  recordAgentMetric,
} from '../bufi/metrics';

/**
 * BUFI: a job is a settlement only when it COMPLETED and the provider was
 * actually paid. A refunded job never is (marketplace audit P1, 2026-09-12:
 * refunded agreements were counting as settled). Idempotent — the two events
 * that can complete the condition arrive in either order.
 */
export function markSettledIfPaid(job: Job, event: ethereum.Event): void {
  if (job.settled) return;
  if (job.status != 'COMPLETED') return;
  if (job.providerPayment.isZero()) return;

  job.settled = true;
  job.settledAt = event.block.timestamp.toI64();
  const amount = job.providerPayment;
  const timestamp = event.block.timestamp;

  const agenticCommerce = AgenticCommerce.load(job.agenticCommerce);
  if (agenticCommerce != null) {
    agenticCommerce.settledJobCount = agenticCommerce.settledJobCount.plus(BigInt.fromI32(1));
    agenticCommerce.settledVolume = agenticCommerce.settledVolume.plus(amount);
    agenticCommerce.updatedAt = timestamp.toI64();
    agenticCommerce.save();
  }

  if (job.providerAgent) {
    const provider = Agent.load(job.providerAgent!);
    if (provider != null) {
      provider.settledAsProvider = provider.settledAsProvider.plus(BigInt.fromI32(1));
      provider.settledVolumeAsProvider = provider.settledVolumeAsProvider.plus(amount);
      provider.save();
      recordAgentMetric(provider, METRIC_SETTLED_AS_PROVIDER, amount, timestamp);
    }
  }
  if (job.clientAgent) {
    const client = Agent.load(job.clientAgent!);
    if (client != null) {
      client.settledAsClient = client.settledAsClient.plus(BigInt.fromI32(1));
      client.settledVolumeAsClient = client.settledVolumeAsClient.plus(amount);
      client.save();
      recordAgentMetric(client, METRIC_SETTLED_AS_CLIENT, amount, timestamp);
    }
  }
  if (job.engagement) {
    const engagement = Engagement.load(job.engagement!);
    if (engagement != null) {
      engagement.settledJobCount = engagement.settledJobCount.plus(BigInt.fromI32(1));
      engagement.settledVolume = engagement.settledVolume.plus(amount);
      engagement.lastSettledJob = job.id;
      engagement.lastSettledAt = timestamp.toI64();
      engagement.updatedAt = timestamp.toI64();
      engagement.save();
    }
  }
}

/** BUFI: a refund is money that went back, tracked apart from settlements. */
export function recordRefund(job: Job, amount: BigInt, event: ethereum.Event): void {
  const timestamp = event.block.timestamp;
  const agenticCommerce = AgenticCommerce.load(job.agenticCommerce);
  if (agenticCommerce != null) {
    agenticCommerce.refundedVolume = agenticCommerce.refundedVolume.plus(amount);
    agenticCommerce.updatedAt = timestamp.toI64();
    agenticCommerce.save();
  }
  if (job.clientAgent) {
    const client = Agent.load(job.clientAgent!);
    if (client != null) {
      client.refundedVolumeAsClient = client.refundedVolumeAsClient.plus(amount);
      client.save();
      recordAgentMetric(client, METRIC_REFUNDED_AS_CLIENT, amount, timestamp);
    }
  }
  if (job.engagement) {
    const engagement = Engagement.load(job.engagement!);
    if (engagement != null) {
      engagement.refundedVolume = engagement.refundedVolume.plus(amount);
      engagement.updatedAt = timestamp.toI64();
      engagement.save();
    }
  }
}
