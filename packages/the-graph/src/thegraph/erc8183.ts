/**
 * Typed reads over the ERC-8183 side of BUFI's Arc subgraph (plan 342).
 *
 * The indexed escrow is Circle's Arc contract
 * (`getBuAgenticCommerceAddress(5042002)` in `@bu/env/ace`), shared with every
 * other party on it; readers filter by their own agent wallet addresses or by
 * the workspace links the subgraph resolves (`clientAgent` / `providerAgent`).
 * `jobId` is a uint256: strings end to end, never Number.
 *
 * `Job.status` only flips to EXPIRED on-chain when someone calls `claimRefund`,
 * so a job past its deadline still reads OPEN / FUNDED / SUBMITTED. Use
 * `effectiveJobStatus` for anything user-facing. `Job.settled` is the
 * subgraph's own verdict: COMPLETED and the provider paid.
 */

import { getSubgraphRef, type SubgraphRef } from '@bu/env/thegraph';
import { z } from 'zod';

import { queryTheGraph, type TheGraphQueryOptions } from './client';
import { type ChainScopedIdPart, jobEntityId, registryEntityId } from './ids';

export const JOB_STATUSES = [
  'OPEN',
  'FUNDED',
  'SUBMITTED',
  'COMPLETED',
  'REJECTED',
  'EXPIRED',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

const bigIntString = z.string().regex(/^-?\d+$/, 'expected an integer string');
const account = z.object({ id: z.string() });
const agentRef = z.object({ agentId: bigIntString });

export const jobEventSchema = z.object({
  id: z.string(),
  kind: z.string(),
  actor: account.nullable(),
  amount: bigIntString.nullable(),
  /** Unix seconds. */
  timestamp: bigIntString,
  transactionHash: z.string(),
  logIndex: bigIntString,
});
export type SubgraphJobEvent = z.infer<typeof jobEventSchema>;

export const jobSchema = z.object({
  id: z.string(),
  jobId: bigIntString,
  status: z.enum(JOB_STATUSES),
  client: account,
  provider: account.nullable(),
  evaluator: account,
  /** BUFI: the workspaces behind the party addresses, via WalletBinding. */
  clientAgent: agentRef.nullable(),
  providerAgent: agentRef.nullable(),
  engagement: z.object({ id: z.string() }).nullable(),
  /** Unix seconds. */
  expiresAt: bigIntString,
  submittedAt: bigIntString.nullable(),
  budget: bigIntString,
  paymentToken: z.string(),
  hook: z.string().nullable(),
  description: z.string(),
  providerPayment: bigIntString,
  evaluatorFeePaid: bigIntString,
  refundedAmount: bigIntString,
  /** BUFI: COMPLETED and the provider was paid; a refund never counts. */
  settled: z.boolean(),
  settledAt: bigIntString.nullable(),
  deliverable: z.string().nullable(),
  completionReason: z.string().nullable(),
  rejectionReason: z.string().nullable(),
  createdAt: bigIntString,
  createdAtTransaction: z.string(),
  updatedAt: bigIntString,
  updatedAtTransaction: z.string(),
  events: z.array(jobEventSchema),
});
export type SubgraphJob = z.infer<typeof jobSchema>;

const JOB_FIELDS = `
  id jobId status client { id } provider { id } evaluator { id }
  clientAgent { agentId } providerAgent { agentId } engagement { id }
  expiresAt submittedAt budget paymentToken hook description
  providerPayment evaluatorFeePaid refundedAmount settled settledAt
  deliverable completionReason rejectionReason
  createdAt createdAtTransaction updatedAt updatedAtTransaction
  events(first: 200, orderBy: logIndex, orderDirection: asc) {
    id kind actor { id } amount timestamp transactionHash logIndex
  }`;

export interface JobLocator {
  chainId: ChainScopedIdPart;
  /** The escrow contract the job lives on. */
  contract: string;
  jobId: ChainScopedIdPart;
}

export interface Erc8183ReadOptions extends TheGraphQueryOptions {
  ref?: SubgraphRef;
}

function refFor(options: Erc8183ReadOptions): SubgraphRef {
  return options.ref ?? getSubgraphRef('erc8183');
}

/** One job with its full event timeline, or null when the id was never created. */
export async function getJob(
  locator: JobLocator,
  options: Erc8183ReadOptions = {}
): Promise<SubgraphJob | null> {
  const data = await queryTheGraph<{ job: unknown }>(
    refFor(options),
    `query Job($id: ID!) { job(id: $id) { ${JOB_FIELDS} } }`,
    { id: jobEntityId(locator.chainId, locator.contract, locator.jobId) },
    options
  );
  return data.job === null ? null : jobSchema.parse(data.job);
}

export type JobRole = 'client' | 'provider' | 'evaluator';

export interface ListJobsInput {
  chainId: ChainScopedIdPart;
  contract: string;
  /** Filter by the address playing this role. */
  address: string;
  role: JobRole;
  /** 1..1000, default 50. */
  first?: number;
  afterId?: string | null;
  status?: JobStatus;
  /** Only settled jobs (COMPLETED and provider paid). */
  settledOnly?: boolean;
}

export interface JobPage {
  items: SubgraphJob[];
  nextCursor: string | null;
}

export const JOB_PAGE_MAX = 1000;

/** Jobs where `address` plays `role` on this contract, in id order, cursor-paginated. */
export async function listJobs(
  input: ListJobsInput,
  options: Erc8183ReadOptions = {}
): Promise<JobPage> {
  const first = Math.min(Math.max(input.first ?? 50, 1), JOB_PAGE_MAX);
  const where: Record<string, unknown> = {
    agenticCommerce: registryEntityId(input.chainId, input.contract),
    [input.role]: input.address.toLowerCase(),
  };
  if (input.status) where.status = input.status;
  if (input.settledOnly) where.settled = true;
  if (input.afterId) where.id_gt = input.afterId;

  const data = await queryTheGraph<{ jobs: unknown[] }>(
    refFor(options),
    `query Jobs($first: Int!, $where: Job_filter) {
      jobs(first: $first, orderBy: id, orderDirection: asc, where: $where) { ${JOB_FIELDS} }
    }`,
    { first, where },
    options
  );
  const items = z.array(jobSchema).parse(data.jobs);
  return {
    items,
    nextCursor: items.length === first ? (items[items.length - 1]?.id ?? null) : null,
  };
}

/** The contract's evaluation window after `expiresAt` during which a SUBMITTED job can still complete. */
export const EVALUATION_GRACE_PERIOD_SECONDS = 3600;

/**
 * Status as a person would understand it: OPEN / FUNDED past the deadline and
 * SUBMITTED past the deadline plus the grace period read as EXPIRED even
 * before anyone claims the refund on-chain.
 */
export function effectiveJobStatus(
  job: Pick<SubgraphJob, 'status' | 'expiresAt'>,
  nowSeconds: number
): JobStatus {
  const expiresAt = Number(job.expiresAt);
  if ((job.status === 'OPEN' || job.status === 'FUNDED') && expiresAt <= nowSeconds) {
    return 'EXPIRED';
  }
  if (job.status === 'SUBMITTED' && expiresAt + EVALUATION_GRACE_PERIOD_SECONDS <= nowSeconds) {
    return 'EXPIRED';
  }
  return job.status;
}

/**
 * A job counts as a settled payment only when it completed AND the provider
 * was actually paid. A refunded job is not a settlement (marketplace audit P1,
 * 2026-09-12). The subgraph carries the same verdict as `settled`; this is the
 * client-side restatement for rows read without that field.
 */
export function isSettledPayment(
  job: Pick<SubgraphJob, 'status' | 'providerPayment'> & { settled?: boolean }
): boolean {
  if (typeof job.settled === 'boolean') return job.settled;
  return job.status === 'COMPLETED' && BigInt(job.providerPayment) > 0n;
}
