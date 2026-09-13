/**
 * Typed reads over the identity + reputation side of BUFI's Arc subgraph
 * (`packages/subgraph-arc`, plan 342).
 *
 * Rules pinned by the schema and by what the gateway does:
 *  - Never select `registration { … }` without `where: { registration_not: null }`:
 *    the interface field errors at the store when null and the gateway reports
 *    it as "bad indexers". `getAgent` therefore never touches `registration`;
 *    `getAgentProfile` filters and uses an inline fragment.
 *  - Entity timestamps are unix SECONDS; aggregation bucket timestamps are
 *    MICROSECONDS. Stats readers normalise to seconds.
 *  - `agentId`, counts and BigDecimals travel as strings end to end (uint256).
 *  - Paginate by `id_gt`, never `skip` (gateway caps skip at 5000).
 */

import { getSubgraphRef, type SubgraphRef } from '@bu/env/thegraph';
import { z } from 'zod';

import { queryTheGraph, type TheGraphQueryOptions } from './client';
import { agentEntityId, type ChainScopedIdPart, engagementEntityId } from './ids';

const bigIntString = z.string().regex(/^-?\d+$/, 'expected an integer string');
const decimalString = z.string().regex(/^-?\d+(\.\d+)?$/, 'expected a decimal string');
const account = z.object({ id: z.string() });
const agentRef = z.object({ agentId: bigIntString });
const jobRef = z.object({ id: z.string(), jobId: bigIntString });

export const agentSchema = z.object({
  id: z.string(),
  agentId: bigIntString,
  owner: account.nullable(),
  agentWallet: z.string().nullable(),
  isBurned: z.boolean(),
  agentURI: z.string(),
  agentURIKind: z.string(),
  feedbackCount: bigIntString,
  activeFeedbackCount: bigIntString,
  responseCount: bigIntString,
  /** BUFI: ratings whose rater had settled a job with this workspace first. */
  verifiedFeedbackCount: bigIntString,
  /** BUFI: the bufi.score.v1 attestation, decoded; null until the workspace publishes one. */
  bufiScore: bigIntString.nullable(),
  bufiScoreVersion: bigIntString.nullable(),
  bufiScoreDate: z.string().nullable(),
  bufiScoreHash: z.string().nullable(),
  bufiScoreUpdatedAt: bigIntString.nullable(),
  /** BUFI: ERC-8183 activity joined through the agent wallet. */
  jobsAsClient: bigIntString,
  jobsAsProvider: bigIntString,
  settledAsClient: bigIntString,
  settledAsProvider: bigIntString,
  settledVolumeAsClient: bigIntString,
  settledVolumeAsProvider: bigIntString,
  refundedVolumeAsClient: bigIntString,
  createdAt: bigIntString,
  createdAtTransaction: z.string(),
  updatedAt: bigIntString,
});
export type SubgraphAgent = z.infer<typeof agentSchema>;

const AGENT_FIELDS = `
  id agentId owner { id } agentWallet isBurned agentURI agentURIKind
  feedbackCount activeFeedbackCount responseCount verifiedFeedbackCount
  bufiScore bufiScoreVersion bufiScoreDate bufiScoreHash bufiScoreUpdatedAt
  jobsAsClient jobsAsProvider settledAsClient settledAsProvider
  settledVolumeAsClient settledVolumeAsProvider refundedVolumeAsClient
  createdAt createdAtTransaction updatedAt`;

export interface AgentLocator {
  chainId: ChainScopedIdPart;
  /** The identity registry the agent was minted on (lowercased in the id). */
  identityRegistry: string;
  agentId: ChainScopedIdPart;
}

export interface Erc8004ReadOptions extends TheGraphQueryOptions {
  ref?: SubgraphRef;
}

function refFor(options: Erc8004ReadOptions): SubgraphRef {
  return options.ref ?? getSubgraphRef('erc8004');
}

/** Current on-chain state of one identity, or null when it was never registered. */
export async function getAgent(
  locator: AgentLocator,
  options: Erc8004ReadOptions = {}
): Promise<SubgraphAgent | null> {
  const data = await queryTheGraph<{ agent: unknown }>(
    refFor(options),
    `query Agent($id: ID!) { agent(id: $id) { ${AGENT_FIELDS} } }`,
    { id: agentEntityId(locator.chainId, locator.identityRegistry, locator.agentId) },
    options
  );
  return data.agent === null ? null : agentSchema.parse(data.agent);
}

export const agentServiceSchema = z.object({
  name: z.string(),
  kind: z.string(),
  endpoint: z.string(),
  version: z.string().nullable(),
});

export const agentProfileSchema = z.object({
  name: z.string().nullable(),
  description: z.string().nullable(),
  image: z.string().nullable(),
  active: z.boolean().nullable(),
  x402Support: z.boolean().nullable(),
  services: z.array(agentServiceSchema),
});
export type SubgraphAgentProfile = z.infer<typeof agentProfileSchema>;

/**
 * The parsed registration document, or null when the agent registered with a
 * URI the subgraph does not parse (anything but `data:`). Every BUFI identity
 * carries a `data:` document since the plan 342 D5 backfill.
 */
export async function getAgentProfile(
  locator: AgentLocator,
  options: Erc8004ReadOptions = {}
): Promise<SubgraphAgentProfile | null> {
  const data = await queryTheGraph<{ agents: Array<{ registration: unknown }> }>(
    refFor(options),
    `query AgentProfile($id: Bytes!) {
      agents(first: 1, where: { id: $id, registration_not: null }) {
        registration {
          ... on AgentRegistration {
            name description image active x402Support
            services(orderBy: position, orderDirection: asc) { name kind endpoint version }
          }
        }
      }
    }`,
    { id: agentEntityId(locator.chainId, locator.identityRegistry, locator.agentId) },
    options
  );
  const registration = data.agents[0]?.registration;
  return registration ? agentProfileSchema.parse(registration) : null;
}

export const feedbackSchema = z.object({
  id: z.string(),
  feedbackIndex: bigIntString,
  client: account,
  /** BUFI: the rater's workspace, when the rater is a bound agent wallet. */
  clientAgent: agentRef.nullable(),
  /** BUFI: the rater had settled a job with the rated workspace before rating. */
  verified: z.boolean(),
  /** BUFI: the settled job behind a verified rating. */
  evidence: jobRef.nullable(),
  value: bigIntString,
  valueDecimals: z.number().int(),
  normalizedValue: decimalString,
  tag1: z.string(),
  tag2: z.string(),
  endpoint: z.string(),
  feedbackURI: z.string(),
  feedbackURIKind: z.string(),
  hasFeedbackHash: z.boolean(),
  isRevoked: z.boolean(),
  responseCount: bigIntString,
  createdAt: bigIntString,
  createdAtTransaction: z.string(),
});
export type SubgraphFeedback = z.infer<typeof feedbackSchema>;

const FEEDBACK_FIELDS = `
  id feedbackIndex client { id } clientAgent { agentId } verified evidence { id jobId }
  value valueDecimals normalizedValue tag1 tag2 endpoint feedbackURI feedbackURIKind
  hasFeedbackHash isRevoked responseCount createdAt createdAtTransaction`;

export interface FeedbackPage {
  items: SubgraphFeedback[];
  /** Pass back as `afterId` for the next page; null when exhausted. */
  nextCursor: string | null;
}

export interface ListAgentFeedbackInput extends AgentLocator {
  /** 1..1000, default 100. */
  first?: number;
  afterId?: string | null;
  includeRevoked?: boolean;
  /** Only ratings backed by a settled job. */
  verifiedOnly?: boolean;
}

export const FEEDBACK_PAGE_MAX = 1000;

/** Feedback for one agent in id order, cursor-paginated. */
export async function listAgentFeedback(
  input: ListAgentFeedbackInput,
  options: Erc8004ReadOptions = {}
): Promise<FeedbackPage> {
  const first = Math.min(Math.max(input.first ?? 100, 1), FEEDBACK_PAGE_MAX);
  const where: Record<string, unknown> = {
    agent: agentEntityId(input.chainId, input.identityRegistry, input.agentId),
  };
  if (!input.includeRevoked) where.isRevoked = false;
  if (input.verifiedOnly) where.verified = true;
  if (input.afterId) where.id_gt = input.afterId;

  const data = await queryTheGraph<{ feedbacks: unknown[] }>(
    refFor(options),
    `query AgentFeedback($first: Int!, $where: Feedback_filter) {
      feedbacks(first: $first, orderBy: id, orderDirection: asc, where: $where) { ${FEEDBACK_FIELDS} }
    }`,
    { first, where },
    options
  );
  const items = z.array(feedbackSchema).parse(data.feedbacks);
  return {
    items,
    nextCursor: items.length === first ? (items[items.length - 1]?.id ?? null) : null,
  };
}

export type FeedbackStatsInterval = 'hour' | 'day';

export const feedbackStatsBucketSchema = z.object({
  id: z.string(),
  /** Unix seconds (normalised from the aggregation's microseconds). */
  timestamp: z.number().int(),
  tag1: z.string(),
  tag2: z.string(),
  /** Cumulative count of ACTIVE feedback up to this bucket. */
  feedbackCount: bigIntString,
  /** Cumulative sum of normalised values of ACTIVE feedback up to this bucket. */
  valueSum: decimalString,
});
export type FeedbackStatsBucket = z.infer<typeof feedbackStatsBucketSchema>;

export interface GetAgentFeedbackStatsInput extends AgentLocator {
  interval?: FeedbackStatsInterval;
  /** Newest-first bucket count, default 30, max 1000. */
  first?: number;
}

const MICROSECONDS = 1_000_000n;

function microsToSeconds(value: string | number): number {
  return Number(BigInt(String(value)) / MICROSECONDS);
}

/**
 * Cumulative per-tag stats for one agent, newest bucket first. Revocation
 * writes the inverse point upstream, so `feedbackCount` and `valueSum`
 * describe active feedback; average = valueSum / feedbackCount.
 */
export async function getAgentFeedbackStats(
  input: GetAgentFeedbackStatsInput,
  options: Erc8004ReadOptions = {}
): Promise<FeedbackStatsBucket[]> {
  const first = Math.min(Math.max(input.first ?? 30, 1), FEEDBACK_PAGE_MAX);
  const data = await queryTheGraph<{ agentFeedbackStats_collection: unknown[] }>(
    refFor(options),
    `query AgentFeedbackStats($interval: Aggregation_interval!, $first: Int!, $where: AgentFeedbackStats_filter) {
      agentFeedbackStats_collection(interval: $interval, first: $first, orderBy: timestamp, orderDirection: desc, where: $where) {
        id timestamp tag1 tag2 feedbackCount valueSum
      }
    }`,
    {
      interval: input.interval ?? 'day',
      first,
      where: { agent: agentEntityId(input.chainId, input.identityRegistry, input.agentId) },
    },
    options
  );
  const raw = z
    .array(
      z.object({
        id: z.string(),
        timestamp: z.union([z.string(), z.number()]),
        tag1: z.string(),
        tag2: z.string(),
        feedbackCount: bigIntString,
        valueSum: decimalString,
      })
    )
    .parse(data.agentFeedbackStats_collection);
  return raw.map(bucket =>
    feedbackStatsBucketSchema.parse({ ...bucket, timestamp: microsToSeconds(bucket.timestamp) })
  );
}

export const AGENT_METRIC_KINDS = [
  'SETTLED_AS_PROVIDER',
  'SETTLED_AS_CLIENT',
  'REFUNDED_AS_CLIENT',
] as const;
export type AgentMetricKind = (typeof AGENT_METRIC_KINDS)[number];

export const agentDailyMetricSchema = z.object({
  id: z.string(),
  /** Unix seconds, start of day. */
  timestamp: z.number().int(),
  kind: z.enum(AGENT_METRIC_KINDS),
  /** Raw token units settled/refunded that day. */
  volume: bigIntString,
  count: bigIntString,
});
export type AgentDailyMetric = z.infer<typeof agentDailyMetricSchema>;

export interface GetAgentDailyMetricsInput extends AgentLocator {
  kind?: AgentMetricKind;
  /** Newest-first day count, default 30, max 1000. */
  first?: number;
}

/** BUFI: settled and refunded volume per workspace per day. */
export async function getAgentDailyMetrics(
  input: GetAgentDailyMetricsInput,
  options: Erc8004ReadOptions = {}
): Promise<AgentDailyMetric[]> {
  const first = Math.min(Math.max(input.first ?? 30, 1), FEEDBACK_PAGE_MAX);
  const where: Record<string, unknown> = {
    agent: agentEntityId(input.chainId, input.identityRegistry, input.agentId),
  };
  if (input.kind) where.kind = input.kind;
  const data = await queryTheGraph<{ agentDailyMetric_collection: unknown[] }>(
    refFor(options),
    `query AgentDailyMetrics($first: Int!, $where: AgentDailyMetric_filter) {
      agentDailyMetric_collection(interval: day, first: $first, orderBy: timestamp, orderDirection: desc, where: $where) {
        id timestamp kind volume count
      }
    }`,
    { first, where },
    options
  );
  const raw = z
    .array(
      z.object({
        id: z.string(),
        timestamp: z.union([z.string(), z.number()]),
        kind: z.enum(AGENT_METRIC_KINDS),
        volume: bigIntString,
        count: z.union([z.string(), z.number()]),
      })
    )
    .parse(data.agentDailyMetric_collection);
  return raw.map(bucket =>
    agentDailyMetricSchema.parse({
      ...bucket,
      timestamp: microsToSeconds(bucket.timestamp),
      count: String(bucket.count),
    })
  );
}

export const engagementSchema = z.object({
  id: z.string(),
  client: agentRef,
  provider: agentRef,
  jobCount: bigIntString,
  settledJobCount: bigIntString,
  settledVolume: bigIntString,
  refundedVolume: bigIntString,
  lastSettledJob: jobRef.nullable(),
  lastSettledAt: bigIntString.nullable(),
  feedbackCount: bigIntString,
  verifiedFeedbackCount: bigIntString,
  lastFeedbackAt: bigIntString.nullable(),
  firstSeenAt: bigIntString,
  updatedAt: bigIntString,
});
export type SubgraphEngagement = z.infer<typeof engagementSchema>;

export interface EngagementLocator {
  chainId: ChainScopedIdPart;
  identityRegistry: string;
  clientAgentId: ChainScopedIdPart;
  providerAgentId: ChainScopedIdPart;
}

/**
 * BUFI: the edge between two workspaces, client → provider: have they settled
 * work, how much, how often, and how did the client rate it. Null when the two
 * have never shared a job or a rating.
 */
export async function getEngagement(
  locator: EngagementLocator,
  options: Erc8004ReadOptions = {}
): Promise<SubgraphEngagement | null> {
  const id = engagementEntityId(
    agentEntityId(locator.chainId, locator.identityRegistry, locator.clientAgentId),
    agentEntityId(locator.chainId, locator.identityRegistry, locator.providerAgentId)
  );
  const data = await queryTheGraph<{ engagement: unknown }>(
    refFor(options),
    `query Engagement($id: ID!) {
      engagement(id: $id) {
        id client { agentId } provider { agentId }
        jobCount settledJobCount settledVolume refundedVolume
        lastSettledJob { id jobId } lastSettledAt
        feedbackCount verifiedFeedbackCount lastFeedbackAt firstSeenAt updatedAt
      }
    }`,
    { id },
    options
  );
  return data.engagement === null ? null : engagementSchema.parse(data.engagement);
}
