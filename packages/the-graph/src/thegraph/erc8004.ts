/**
 * Typed reads over the ERC-8004 identity + reputation subgraph (plan 342).
 *
 * Rules learned against the live deployment (2026-09-13):
 *  - Never select `registration { … }` without `where: { registration_not: null }`:
 *    the interface field errors at the store when null and the gateway reports
 *    it as "bad indexers". `getAgent` therefore never touches `registration`;
 *    `getAgentProfile` filters and uses an inline fragment.
 *  - Entity timestamps are unix SECONDS; aggregation bucket timestamps are
 *    MICROSECONDS. `getAgentFeedbackStats` normalises to seconds.
 *  - `agentId`, counts and BigDecimals travel as strings end to end (uint256).
 *  - Paginate by `id_gt`, never `skip` (gateway caps skip at 5000).
 */

import { getSubgraphRef, type SubgraphRef } from '@bu/env/thegraph';
import { z } from 'zod';

import { queryTheGraph, type TheGraphQueryOptions } from './client';
import { agentEntityId, type ChainScopedIdPart } from './ids';

const bigIntString = z.string().regex(/^-?\d+$/, 'expected an integer string');
const decimalString = z.string().regex(/^-?\d+(\.\d+)?$/, 'expected a decimal string');
const account = z.object({ id: z.string() });

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
  createdAt: bigIntString,
  createdAtTransaction: z.string(),
  updatedAt: bigIntString,
});
export type SubgraphAgent = z.infer<typeof agentSchema>;

const AGENT_FIELDS = `
  id agentId owner { id } agentWallet isBurned agentURI agentURIKind
  feedbackCount activeFeedbackCount responseCount
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
 * URI the subgraph does not parse (anything but `data:` today — which is every
 * BUFI identity until plan 342 D5 lands).
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
  if (input.afterId) where.id_gt = input.afterId;

  const data = await queryTheGraph<{ feedbacks: unknown[] }>(
    refFor(options),
    `query AgentFeedback($first: Int!, $where: Feedback_filter) {
      feedbacks(first: $first, orderBy: id, orderDirection: asc, where: $where) {
        id feedbackIndex client { id } value valueDecimals normalizedValue
        tag1 tag2 endpoint feedbackURI feedbackURIKind hasFeedbackHash isRevoked
        responseCount createdAt createdAtTransaction
      }
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
