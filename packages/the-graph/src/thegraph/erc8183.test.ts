import type { SubgraphRef } from '../env/thegraph';

import {
  EVALUATION_GRACE_PERIOD_SECONDS,
  effectiveJobStatus,
  getJob,
  isSettledPayment,
  listJobs,
} from './erc8183';
import { jobEntityId, registryEntityId } from './ids';
import { describe, expect, test } from 'bun:test';

const REF: SubgraphRef = {
  kind: 'erc8183',
  chain: 'arc-testnet',
  chainId: 5042002,
  subgraphId: 'Sub',
  deploymentId: null,
  queryUrl: null,
};
const CIRCLE_8183 = '0x0747EEf0706327138c69792bF28Cd525089e4583';
const AGENT_DCW = '0x89875CCB15770E1BA344818002F08A44ECB8FAE2';

// Shape of a `job` row on the BUFI Arc subgraph (packages/subgraph-arc).
const LIVE_JOB = {
  id: jobEntityId(5042002, CIRCLE_8183, '182422'),
  jobId: '182422',
  status: 'COMPLETED',
  client: { id: AGENT_DCW.toLowerCase() },
  provider: { id: '0x1708f1004a87370fe31040338a6bea6a579896dc' },
  evaluator: { id: AGENT_DCW.toLowerCase() },
  clientAgent: { agentId: '894551' },
  providerAgent: { agentId: '893198' },
  engagement: { id: '0xe' },
  expiresAt: '1756600000',
  submittedAt: '1756590000',
  budget: '1000000',
  paymentToken: '0x3600000000000000000000000000000000000000',
  hook: null,
  description: 'Arc native W2W job',
  providerPayment: '980000',
  evaluatorFeePaid: '10000',
  refundedAmount: '0',
  settled: true,
  settledAt: '1756595000',
  deliverable: '0xdeadbeef',
  completionReason: '0x01',
  rejectionReason: null,
  createdAt: '1756580000',
  createdAtTransaction: '0xaaa',
  updatedAt: '1756595000',
  updatedAtTransaction: '0xbbb',
  events: [
    {
      id: '0xe1',
      kind: 'CREATED',
      actor: { id: AGENT_DCW.toLowerCase() },
      amount: null,
      timestamp: '1756580000',
      transactionHash: '0xaaa',
      logIndex: '3',
    },
  ],
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

describe('getJob', () => {
  test('queries by the chain-scoped job id and keeps uint256 fields as strings', async () => {
    const sent: Sent[] = [];
    const job = await getJob(
      { chainId: 5042002, contract: CIRCLE_8183, jobId: '182422' },
      opts({ job: LIVE_JOB }, sent)
    );
    expect(sent[0]?.variables.id).toBe(LIVE_JOB.id);
    expect(job?.jobId).toBe('182422');
    expect(typeof job?.budget).toBe('string');
    expect(job?.clientAgent?.agentId).toBe('894551');
    expect(job?.settled).toBe(true);
    expect(job?.events[0]?.kind).toBe('CREATED');
  });

  test('returns null for a job that was never created', async () => {
    expect(
      await getJob({ chainId: 5042002, contract: CIRCLE_8183, jobId: '1' }, opts({ job: null }))
    ).toBeNull();
  });
});

describe('listJobs', () => {
  test('scopes to the contract entity and the role address, lowercased', async () => {
    const sent: Sent[] = [];
    const page = await listJobs(
      { chainId: 5042002, contract: CIRCLE_8183, address: AGENT_DCW, role: 'client', first: 10 },
      opts({ jobs: [LIVE_JOB] }, sent)
    );
    const where = sent[0]?.variables.where as Record<string, unknown>;
    expect(where.agenticCommerce).toBe(registryEntityId(5042002, CIRCLE_8183));
    expect(where.client).toBe(AGENT_DCW.toLowerCase());
    expect(where.provider).toBeUndefined();
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
  });

  test('adds status, settledOnly and id_gt filters when given', async () => {
    const sent: Sent[] = [];
    await listJobs(
      {
        chainId: 5042002,
        contract: CIRCLE_8183,
        address: AGENT_DCW,
        role: 'provider',
        status: 'COMPLETED',
        settledOnly: true,
        afterId: '0x01',
      },
      opts({ jobs: [] }, sent)
    );
    const where = sent[0]?.variables.where as Record<string, unknown>;
    expect(where.provider).toBe(AGENT_DCW.toLowerCase());
    expect(where.status).toBe('COMPLETED');
    expect(where.settled).toBe(true);
    expect(where.id_gt).toBe('0x01');
  });
});

describe('effectiveJobStatus', () => {
  const at = 1_000_000;
  test.each([
    ['OPEN', at + 1, 'OPEN'],
    ['OPEN', at, 'EXPIRED'],
    ['FUNDED', at - 1, 'EXPIRED'],
    ['SUBMITTED', at - EVALUATION_GRACE_PERIOD_SECONDS + 1, 'SUBMITTED'],
    ['SUBMITTED', at - EVALUATION_GRACE_PERIOD_SECONDS, 'EXPIRED'],
    ['COMPLETED', at - 999_999, 'COMPLETED'],
    ['REJECTED', at - 999_999, 'REJECTED'],
  ] as const)('%s expiring at %d reads as %s', (status, expiresAt, expected) => {
    expect(effectiveJobStatus({ status, expiresAt: String(expiresAt) }, at)).toBe(expected);
  });
});

describe('isSettledPayment', () => {
  test("the subgraph's verdict wins when present", () => {
    expect(isSettledPayment({ status: 'COMPLETED', providerPayment: '0', settled: true })).toBe(
      true
    );
    expect(
      isSettledPayment({ status: 'COMPLETED', providerPayment: '980000', settled: false })
    ).toBe(false);
  });

  test('without it: completed AND paid counts; refunded or unpaid does not', () => {
    expect(isSettledPayment({ status: 'COMPLETED', providerPayment: '980000' })).toBe(true);
    expect(isSettledPayment({ status: 'COMPLETED', providerPayment: '0' })).toBe(false);
    expect(isSettledPayment({ status: 'EXPIRED', providerPayment: '0' })).toBe(false);
    expect(isSettledPayment({ status: 'REJECTED', providerPayment: '0' })).toBe(false);
  });
});
