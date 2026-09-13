import type { SubgraphRef } from '@bu/env/thegraph';

import {
  getAgent,
  getAgentDailyMetrics,
  getAgentFeedbackStats,
  getAgentProfile,
  getEngagement,
  listAgentFeedback,
} from './erc8004';
import { agentEntityId, engagementEntityId } from './ids';
import { describe, expect, test } from 'bun:test';

const REF: SubgraphRef = {
  kind: 'erc8004',
  chain: 'arc-testnet',
  chainId: 5042002,
  subgraphId: 'Sub',
  deploymentId: null,
  queryUrl: null,
};
const IDENTITY_REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
const LOCATOR = { chainId: 5042002, identityRegistry: IDENTITY_REGISTRY, agentId: '894551' };

// Shape of an `agent` row on the BUFI Arc subgraph (packages/subgraph-arc).
const LIVE_AGENT = {
  id: agentEntityId(5042002, IDENTITY_REGISTRY, '894551'),
  agentId: '894551',
  owner: { id: '0x89875ccb15770e1ba344818002f08a44ecb8fae2' },
  agentWallet: '0x89875ccb15770e1ba344818002f08a44ecb8fae2',
  isBurned: false,
  agentURI: 'data:application/json;base64,eyJ0eXBlIjoi',
  agentURIKind: 'DATA',
  feedbackCount: '0',
  activeFeedbackCount: '0',
  responseCount: '0',
  verifiedFeedbackCount: '0',
  bufiScore: '742',
  bufiScoreVersion: '1',
  bufiScoreDate: '2026-09-12',
  bufiScoreHash: '0xabc',
  bufiScoreUpdatedAt: '1789211893',
  jobsAsClient: '1',
  jobsAsProvider: '0',
  settledAsClient: '1',
  settledAsProvider: '0',
  settledVolumeAsClient: '1000000',
  settledVolumeAsProvider: '0',
  refundedVolumeAsClient: '0',
  createdAt: '1789211893',
  createdAtTransaction: '0xabc',
  updatedAt: '1789211893',
};

interface Sent {
  query: string;
  variables: Record<string, unknown>;
}

function respond(data: unknown, sent: Sent[] = []): typeof fetch {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as Sent);
    return new Response(JSON.stringify({ data }), { status: 200 });
  }) as typeof fetch;
}

const opts = (data: unknown, sent: Sent[] = []) => ({
  ref: REF,
  apiKey: 'k',
  fetchImpl: respond(data, sent),
});

describe('getAgent', () => {
  test('parses a BUFI-shaped row including the score attestation and commerce counters', async () => {
    const sent: Sent[] = [];
    const agent = await getAgent(LOCATOR, opts({ agent: LIVE_AGENT }, sent));
    expect(agent?.agentId).toBe('894551');
    expect(agent?.bufiScore).toBe('742');
    expect(agent?.settledVolumeAsClient).toBe('1000000');
    expect(sent[0]?.variables.id).toBe(LIVE_AGENT.id);
    expect(sent[0]?.query).toContain('bufiScore');
    // Never selects `registration` — it errors at the store when null.
    expect(sent[0]?.query).not.toContain('registration');
  });

  test('returns null for an unregistered id', async () => {
    expect(await getAgent(LOCATOR, opts({ agent: null }))).toBeNull();
  });

  test('rejects a row that drifted from the schema', async () => {
    const error = await getAgent(
      LOCATOR,
      opts({ agent: { ...LIVE_AGENT, feedbackCount: 3 } })
    ).catch(e => e);
    expect(error).toBeInstanceOf(Error);
  });
});

describe('getAgentProfile', () => {
  test('filters on registration_not: null and reads through the inline fragment', async () => {
    const sent: Sent[] = [];
    const profile = await getAgentProfile(
      LOCATOR,
      opts(
        {
          agents: [
            {
              registration: {
                name: 'Nice Team',
                description: null,
                image: null,
                active: true,
                x402Support: null,
                services: [
                  { name: 'x402', kind: 'X402', endpoint: 'https://x/x402', version: null },
                ],
              },
            },
          ],
        },
        sent
      )
    );
    expect(profile?.name).toBe('Nice Team');
    expect(profile?.services[0]?.kind).toBe('X402');
    expect(sent[0]?.query).toContain('registration_not: null');
    expect(sent[0]?.query).toContain('... on AgentRegistration');
  });

  test('returns null when the agent has no parsed registration', async () => {
    expect(await getAgentProfile(LOCATOR, opts({ agents: [] }))).toBeNull();
  });
});

describe('listAgentFeedback', () => {
  const row = (id: string, verified = false) => ({
    id,
    feedbackIndex: '0',
    client: { id: '0xb6da223c9699dede435ee3a4938dcf124efb4473' },
    clientAgent: verified ? { agentId: '888210' } : null,
    verified,
    evidence: verified ? { id: '0xjob', jobId: '182422' } : null,
    value: '100',
    valueDecimals: 0,
    normalizedValue: '100',
    tag1: 'invoice',
    tag2: '',
    endpoint: 'Paid on time.',
    feedbackURI: '',
    feedbackURIKind: 'NONE',
    hasFeedbackHash: true,
    isRevoked: false,
    responseCount: '0',
    createdAt: '1789211893',
    createdAtTransaction: '0xdef',
  });

  test('filters by agent id, excludes revoked by default, paginates by id_gt, carries evidence', async () => {
    const sent: Sent[] = [];
    const page = await listAgentFeedback(
      { ...LOCATOR, first: 2, afterId: '0x01' },
      opts({ feedbacks: [row('0x02', true), row('0x03')] }, sent)
    );
    const where = sent[0]?.variables.where as Record<string, unknown>;
    expect(where.agent).toBe(LIVE_AGENT.id);
    expect(where.isRevoked).toBe(false);
    expect(where.id_gt).toBe('0x01');
    expect(where.verified).toBeUndefined();
    expect(page.items[0]?.verified).toBe(true);
    expect(page.items[0]?.evidence?.jobId).toBe('182422');
    expect(page.items[1]?.evidence).toBeNull();
    expect(page.nextCursor).toBe('0x03');
  });

  test('verifiedOnly adds the filter; includeRevoked drops the revoked filter; first is clamped', async () => {
    const sent: Sent[] = [];
    const page = await listAgentFeedback(
      { ...LOCATOR, first: 5000, includeRevoked: true, verifiedOnly: true },
      opts({ feedbacks: [row('0x02', true)] }, sent)
    );
    const where = sent[0]?.variables.where as Record<string, unknown>;
    expect(where.isRevoked).toBeUndefined();
    expect(where.verified).toBe(true);
    expect(sent[0]?.variables.first).toBe(1000);
    expect(page.nextCursor).toBeNull();
  });
});

describe('getAgentFeedbackStats', () => {
  test('queries the aggregation collection and normalises microsecond buckets to seconds', async () => {
    const sent: Sent[] = [];
    const buckets = await getAgentFeedbackStats(
      { ...LOCATOR, interval: 'day', first: 1 },
      opts(
        {
          agentFeedbackStats_collection: [
            {
              id: '265472602875625472',
              timestamp: '1789171200000000',
              tag1: 'invoice',
              tag2: '',
              feedbackCount: '3',
              valueSum: '260',
            },
          ],
        },
        sent
      )
    );
    expect(sent[0]?.query).toContain('agentFeedbackStats_collection(interval: $interval');
    expect(buckets[0]?.timestamp).toBe(1789171200);
    expect(buckets[0]?.valueSum).toBe('260');
  });
});

describe('getAgentDailyMetrics', () => {
  test('reads the BUFI daily aggregation, kind-filtered, seconds-normalised', async () => {
    const sent: Sent[] = [];
    const days = await getAgentDailyMetrics(
      { ...LOCATOR, kind: 'SETTLED_AS_PROVIDER', first: 2 },
      opts(
        {
          agentDailyMetric_collection: [
            {
              id: '1',
              timestamp: '1789171200000000',
              kind: 'SETTLED_AS_PROVIDER',
              volume: '2000000',
              count: 2,
            },
          ],
        },
        sent
      )
    );
    const where = sent[0]?.variables.where as Record<string, unknown>;
    expect(where.kind).toBe('SETTLED_AS_PROVIDER');
    expect(days[0]).toEqual({
      id: '1',
      timestamp: 1789171200,
      kind: 'SETTLED_AS_PROVIDER',
      volume: '2000000',
      count: '2',
    });
  });
});

describe('getEngagement', () => {
  test('looks up the directed client→provider edge by its keccak id', async () => {
    const sent: Sent[] = [];
    const engagement = await getEngagement(
      {
        chainId: 5042002,
        identityRegistry: IDENTITY_REGISTRY,
        clientAgentId: '888210',
        providerAgentId: '894551',
      },
      opts(
        {
          engagement: {
            id: '0xe',
            client: { agentId: '888210' },
            provider: { agentId: '894551' },
            jobCount: '2',
            settledJobCount: '1',
            settledVolume: '980000',
            refundedVolume: '0',
            lastSettledJob: { id: '0xjob', jobId: '182422' },
            lastSettledAt: '1789200000',
            feedbackCount: '1',
            verifiedFeedbackCount: '1',
            lastFeedbackAt: '1789210000',
            firstSeenAt: '1789100000',
            updatedAt: '1789210000',
          },
        },
        sent
      )
    );
    const expectedId = engagementEntityId(
      agentEntityId(5042002, IDENTITY_REGISTRY, '888210'),
      agentEntityId(5042002, IDENTITY_REGISTRY, '894551')
    );
    expect(sent[0]?.variables.id).toBe(expectedId);
    expect(expectedId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(engagement?.settledJobCount).toBe('1');
    expect(engagement?.lastSettledJob?.jobId).toBe('182422');
  });

  test('the edge is directed', () => {
    const a = agentEntityId(5042002, IDENTITY_REGISTRY, '1');
    const b = agentEntityId(5042002, IDENTITY_REGISTRY, '2');
    expect(engagementEntityId(a, b)).not.toBe(engagementEntityId(b, a));
  });

  test('returns null when the two workspaces never met', async () => {
    expect(
      await getEngagement(
        {
          chainId: 5042002,
          identityRegistry: IDENTITY_REGISTRY,
          clientAgentId: '1',
          providerAgentId: '2',
        },
        opts({ engagement: null })
      )
    ).toBeNull();
  });
});
