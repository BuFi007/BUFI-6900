import type { SubgraphRef } from '@bu/env/thegraph';

import { getAgent, getAgentFeedbackStats, getAgentProfile, listAgentFeedback } from './erc8004';
import { agentEntityId } from './ids';
import { describe, expect, test } from 'bun:test';

const REF: SubgraphRef = {
  kind: 'erc8004',
  chain: 'arc-testnet',
  chainId: 5042002,
  subgraphId: 'Sub',
  deploymentId: null,
};
const IDENTITY_REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
const LOCATOR = { chainId: 5042002, identityRegistry: IDENTITY_REGISTRY, agentId: '894551' };

// Shape of a live `agent` row on 2026-09-13 (BUFI's newest identity).
const LIVE_AGENT = {
  id: agentEntityId(5042002, IDENTITY_REGISTRY, '894551'),
  agentId: '894551',
  owner: { id: '0x89875ccb15770e1ba344818002f08a44ecb8fae2' },
  agentWallet: '0x89875ccb15770e1ba344818002f08a44ecb8fae2',
  isBurned: false,
  agentURI: 'https://desk.bu.finance/api/agents/ebdf1018-34b6-4469-a853-1d322c1c01f9/metadata.json',
  agentURIKind: 'HTTPS',
  feedbackCount: '0',
  activeFeedbackCount: '0',
  responseCount: '0',
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
  test('parses a live-shaped row and queries by the chain-scoped id', async () => {
    const sent: Sent[] = [];
    const agent = await getAgent(LOCATOR, opts({ agent: LIVE_AGENT }, sent));
    expect(agent?.agentId).toBe('894551');
    expect(agent?.agentURIKind).toBe('HTTPS');
    expect(sent[0]?.variables.id).toBe(LIVE_AGENT.id);
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
                name: 'Web Intel Agent',
                description: null,
                image: null,
                active: true,
                x402Support: null,
                services: [{ name: 'mcp', kind: 'MCP', endpoint: 'https://x/mcp', version: null }],
              },
            },
          ],
        },
        sent
      )
    );
    expect(profile?.name).toBe('Web Intel Agent');
    expect(profile?.services[0]?.kind).toBe('MCP');
    expect(sent[0]?.query).toContain('registration_not: null');
    expect(sent[0]?.query).toContain('... on AgentRegistration');
  });

  test('returns null when the agent has no parsed registration (every HTTPS-URI identity today)', async () => {
    expect(await getAgentProfile(LOCATOR, opts({ agents: [] }))).toBeNull();
  });
});

describe('listAgentFeedback', () => {
  const row = (id: string) => ({
    id,
    feedbackIndex: '0',
    client: { id: '0xb6da223c9699dede435ee3a4938dcf124efb4473' },
    value: '100',
    valueDecimals: 0,
    normalizedValue: '100',
    tag1: 'invoice',
    tag2: 'arc_testnet',
    endpoint: '',
    feedbackURI: '',
    feedbackURIKind: 'NONE',
    hasFeedbackHash: true,
    isRevoked: false,
    responseCount: '0',
    createdAt: '1789211893',
    createdAtTransaction: '0xdef',
  });

  test('filters by agent id, excludes revoked by default, and paginates by id_gt', async () => {
    const sent: Sent[] = [];
    const page = await listAgentFeedback(
      { ...LOCATOR, first: 2, afterId: '0x01' },
      opts({ feedbacks: [row('0x02'), row('0x03')] }, sent)
    );
    const where = sent[0]?.variables.where as Record<string, unknown>;
    expect(where.agent).toBe(LIVE_AGENT.id);
    expect(where.isRevoked).toBe(false);
    expect(where.id_gt).toBe('0x01');
    expect(sent[0]?.variables.first).toBe(2);
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBe('0x03');
  });

  test('a short page ends the cursor; includeRevoked drops the isRevoked filter; first is clamped', async () => {
    const sent: Sent[] = [];
    const page = await listAgentFeedback(
      { ...LOCATOR, first: 5000, includeRevoked: true },
      opts({ feedbacks: [row('0x02')] }, sent)
    );
    const where = sent[0]?.variables.where as Record<string, unknown>;
    expect(where.isRevoked).toBeUndefined();
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
              tag1: 'successful_trade',
              tag2: '',
              feedbackCount: '43',
              valueSum: '3870',
            },
          ],
        },
        sent
      )
    );
    expect(sent[0]?.query).toContain('agentFeedbackStats_collection(interval: $interval');
    expect(sent[0]?.variables.interval).toBe('day');
    expect(buckets[0]?.timestamp).toBe(1789171200);
    expect(buckets[0]?.feedbackCount).toBe('43');
    expect(buckets[0]?.valueSum).toBe('3870');
  });
});
