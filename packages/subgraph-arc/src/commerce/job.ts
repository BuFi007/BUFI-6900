import { Address, BigInt, Bytes, ethereum, log } from '@graphprotocol/graph-ts';

import {
  AgenticCommerce as AgenticCommerceContract,
  BudgetSet,
  JobCompleted,
  JobCreated,
  JobExpired,
  JobFunded,
  JobRejected,
  JobSubmitted,
  ProviderSet,
} from '../../generated/AgenticCommerce/AgenticCommerce';
import { Agent, Job, JobEvent } from '../../generated/schema';
import { getOrCreateEngagement } from '../bufi/engagement';
import { resolveAgentByWallet } from '../bufi/wallet-binding';
import { getOrCreateAccount } from '../shared/account';
import { toTimestampSeconds } from '../shared/timestamp';
import {
  contextChainId,
  contextPaymentToken,
  getOrCreateAgenticCommerce,
} from './agentic-commerce';
import { markSettledIfPaid } from './settlement';

/** `Job` entity ID: UTF-8 bytes of "<chainId>:<contract address>:<jobId>". */
export function jobEntityId(chainId: BigInt, contract: Address, jobId: BigInt): Bytes {
  return Bytes.fromUTF8(chainId.toString() + ':' + contract.toHexString() + ':' + jobId.toString());
}

export function getJob(id: Bytes): Job | null {
  const job = Job.load(id);
  if (job == null) log.warning('Event for unknown job {}', [id.toString()]);
  return job;
}

export function touchJob(job: Job, event: ethereum.Event): void {
  job.updatedAt = event.block.timestamp.toI64();
  job.updatedAtBlock = event.block.number;
  job.updatedAtTransaction = event.transaction.hash;
}

export function createJobEvent(event: ethereum.Event, job: Job, kind: string): JobEvent {
  const record = new JobEvent(event.transaction.hash.concatI32(event.logIndex.toI32()));
  record.agenticCommerce = job.agenticCommerce;
  record.job = job.id;
  record.kind = kind;
  record.blockNumber = event.block.number;
  record.timestamp = event.block.timestamp.toI64();
  record.transactionHash = event.transaction.hash;
  record.logIndex = event.logIndex;
  return record;
}

function eventJob(event: ethereum.Event, jobId: BigInt): Job | null {
  return getJob(jobEntityId(contextChainId(), event.address, jobId));
}

/**
 * BUFI: link the job to the workspaces behind its party addresses and open
 * the client→provider engagement the first time both are known.
 */
function linkWorkspaces(job: Job, event: ethereum.Event): void {
  let clientAgent: Agent | null = null;
  if (!job.clientAgent) {
    clientAgent = resolveAgentByWallet(Address.fromBytes(job.client));
    if (clientAgent != null) job.clientAgent = clientAgent.id;
  } else {
    clientAgent = Agent.load(job.clientAgent!);
  }

  let providerAgent: Agent | null = null;
  if (job.provider) {
    if (!job.providerAgent) {
      providerAgent = resolveAgentByWallet(Address.fromBytes(job.provider!));
      if (providerAgent != null) job.providerAgent = providerAgent.id;
    } else {
      providerAgent = Agent.load(job.providerAgent!);
    }
  }

  if (job.engagement) return;
  if (clientAgent == null || providerAgent == null) return;

  const engagement = getOrCreateEngagement(clientAgent, providerAgent, event.block.timestamp);
  engagement.jobCount = engagement.jobCount.plus(BigInt.fromI32(1));
  engagement.updatedAt = event.block.timestamp.toI64();
  engagement.save();
  job.engagement = engagement.id;

  clientAgent.jobsAsClient = clientAgent.jobsAsClient.plus(BigInt.fromI32(1));
  clientAgent.save();
  providerAgent.jobsAsProvider = providerAgent.jobsAsProvider.plus(BigInt.fromI32(1));
  providerAgent.save();
}

export function handleJobCreated(event: JobCreated): void {
  const agenticCommerce = getOrCreateAgenticCommerce(event);
  const client = getOrCreateAccount(event.params.client);
  const evaluator = getOrCreateAccount(event.params.evaluator);

  const job = new Job(jobEntityId(agenticCommerce.chainId, event.address, event.params.jobId));
  job.agenticCommerce = agenticCommerce.id;
  job.jobId = event.params.jobId;
  job.status = 'OPEN';
  job.client = client.id;
  job.evaluator = evaluator.id;
  // Clamped: uint64 max ("never expires") wraps to -1 through toI64() and a
  // negative Timestamp is a deterministic store error (see shared/timestamp.ts).
  job.expiresAt = toTimestampSeconds(event.params.expiredAt);
  job.budget = BigInt.zero();
  job.paymentToken = contextPaymentToken();
  job.description = '';
  job.providerPayment = BigInt.zero();
  job.evaluatorFeePaid = BigInt.zero();
  job.refundedAmount = BigInt.zero();
  job.settled = false;
  job.createdAt = event.block.timestamp.toI64();
  job.createdAtBlock = event.block.number;
  job.createdAtTransaction = event.transaction.hash;
  touchJob(job, event);

  if (!event.params.provider.equals(Address.zero())) {
    job.provider = getOrCreateAccount(event.params.provider).id;
  }
  if (!event.params.hook.equals(Address.zero())) job.hook = event.params.hook;

  // The description is not in the event. The manifest declares this call so
  // graph-node prefetches it alongside the block (specVersion 1.2+).
  const result = AgenticCommerceContract.bind(event.address).try_getJob(event.params.jobId);
  if (!result.reverted) {
    job.description = result.value.description;
    if (job.budget.isZero()) job.budget = result.value.budget;
  }

  linkWorkspaces(job, event);
  job.save();

  agenticCommerce.jobCount = agenticCommerce.jobCount.plus(BigInt.fromI32(1));
  agenticCommerce.updatedAt = event.block.timestamp.toI64();
  agenticCommerce.save();

  const record = createJobEvent(event, job, 'CREATED');
  record.actor = client.id;
  record.address = event.params.provider;
  record.save();
}

export function handleProviderSet(event: ProviderSet): void {
  const job = eventJob(event, event.params.jobId);
  if (job == null) return;
  const provider = getOrCreateAccount(event.params.provider);
  job.provider = provider.id;
  job.providerAgent = null;
  linkWorkspaces(job, event);
  touchJob(job, event);
  job.save();

  const record = createJobEvent(event, job, 'PROVIDER_SET');
  record.actor = provider.id;
  record.address = event.params.provider;
  record.save();
}

export function handleBudgetSet(event: BudgetSet): void {
  const job = eventJob(event, event.params.jobId);
  if (job == null) return;
  job.budget = event.params.amount;
  touchJob(job, event);
  job.save();

  const record = createJobEvent(event, job, 'BUDGET_SET');
  record.amount = event.params.amount;
  record.save();
}

export function handleJobFunded(event: JobFunded): void {
  const job = eventJob(event, event.params.jobId);
  if (job == null) return;
  job.status = 'FUNDED';
  touchJob(job, event);
  job.save();

  const record = createJobEvent(event, job, 'FUNDED');
  record.actor = getOrCreateAccount(event.params.client).id;
  record.amount = event.params.amount;
  record.save();
}

export function handleJobSubmitted(event: JobSubmitted): void {
  const job = eventJob(event, event.params.jobId);
  if (job == null) return;
  job.status = 'SUBMITTED';
  job.submittedAt = event.block.timestamp.toI64();
  job.deliverable = event.params.deliverable;
  touchJob(job, event);
  job.save();

  const record = createJobEvent(event, job, 'SUBMITTED');
  record.actor = getOrCreateAccount(event.params.provider).id;
  record.data = event.params.deliverable;
  record.save();
}

export function handleJobCompleted(event: JobCompleted): void {
  const job = eventJob(event, event.params.jobId);
  if (job == null) return;
  job.status = 'COMPLETED';
  job.completionReason = event.params.reason;
  touchJob(job, event);
  // PaymentReleased may precede or follow JobCompleted in the same
  // transaction; settlement is declared by whichever comes last.
  markSettledIfPaid(job, event);
  job.save();

  const record = createJobEvent(event, job, 'COMPLETED');
  record.actor = getOrCreateAccount(event.params.evaluator).id;
  record.data = event.params.reason;
  record.save();
}

export function handleJobRejected(event: JobRejected): void {
  const job = eventJob(event, event.params.jobId);
  if (job == null) return;
  job.status = 'REJECTED';
  job.rejectionReason = event.params.reason;
  touchJob(job, event);
  job.save();

  const record = createJobEvent(event, job, 'REJECTED');
  record.actor = getOrCreateAccount(event.params.rejector).id;
  record.data = event.params.reason;
  record.save();
}

export function handleJobExpired(event: JobExpired): void {
  const job = eventJob(event, event.params.jobId);
  if (job == null) return;
  job.status = 'EXPIRED';
  touchJob(job, event);
  job.save();
  createJobEvent(event, job, 'EXPIRED').save();
}
