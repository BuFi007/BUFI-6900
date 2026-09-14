#!/usr/bin/env bun

/**
 * Live assertions against BUFI's Arc subgraph (plan 342).
 *
 * One command instead of re-deriving the entity ids and the expectations every
 * time. It answers three questions in order, and says which one it is on:
 *
 *  1. Is the index healthy and how far behind is it? (`_meta`, chain head)
 *  2. Is BUFI's own history in range yet? Every BUFI identity and job was
 *     created on or after 2026-08-30 — block ~59.5M — so an index below that
 *     is SYNCING, not broken, and reports `pending` rather than a failure.
 *  3. Do the known-good fixtures read correctly? Agent 894551, the proven W2W
 *     job 182422 (`settled: true`), and the "Nice Team" profile + fulltext
 *     search (tsquery syntax: `Nice & Team`, never a bare space).
 *
 * Usage:
 *   bun packages/subgraph-arc/scripts/assert-live.ts [--url <query url>] [--json]
 *
 * Reads `THEGRAPH_ARC_TESTNET_QUERY_URL` when `--url` is absent. Read-only.
 */

const DEFAULT_URL = 'https://api.studio.thegraph.com/query/1760286/bufi-eth-online/version/latest';
const RPC = 'https://rpc.testnet.arc.network';
const CHAIN_ID = 5042002;
const IDENTITY_REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
const ESCROW = '0x0747EEf0706327138c69792bF28Cd525089e4583';
/**
 * BUFI's first Arc identity was minted 2026-08-30 03:25 UTC; its first job the
 * same day. The index itself starts at 59,400,000 (see `INDEX_FLOOR` in
 * scripts/generate-chain-config.ts).
 */
const BUFI_HISTORY_START_BLOCK = 59_500_000;
const FIXTURE_AGENT_ID = '894551';
const FIXTURE_JOB_ID = '182422';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const url = arg('--url') ?? process.env.THEGRAPH_ARC_TESTNET_QUERY_URL ?? DEFAULT_URL;
const asJson = process.argv.includes('--json');

/** Entity ids are the UTF-8 bytes of `<chainId>:<contract lowercased>[:<n>]`, hex-encoded. */
function entityId(...parts: (string | number)[]): string {
  const text = parts.map(part => (typeof part === 'string' ? part.toLowerCase() : part)).join(':');
  return `0x${Buffer.from(text, 'utf8').toString('hex')}`;
}

async function query<T>(document: string, variables: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: document, variables }),
  });
  const body = (await response.json()) as { data?: T; errors?: { message: string }[] };
  if (!body.data) throw new Error(body.errors?.map(e => e.message).join('; ') ?? 'no data');
  return body.data;
}

async function chainHead(): Promise<number | null> {
  try {
    const response = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'curl/8.7.1' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
    });
    const body = (await response.json()) as { result?: string };
    return body.result ? Number.parseInt(body.result, 16) : null;
  } catch {
    return null;
  }
}

type Check = { name: string; state: 'pass' | 'fail' | 'pending'; detail: string };
const checks: Check[] = [];
const record = (name: string, state: Check['state'], detail: string) =>
  checks.push({ name, state, detail });

const meta = await query<{
  _meta: { block: { number: number }; hasIndexingErrors: boolean; deployment: string };
}>('{ _meta(subgraphError: allow) { block { number } hasIndexingErrors deployment } }');

const indexed = meta._meta.block.number;
const head = await chainHead();
const behind = head === null ? null : head - indexed;

record(
  'index health',
  meta._meta.hasIndexingErrors ? 'fail' : 'pass',
  `${meta._meta.deployment} at block ${indexed.toLocaleString()}${
    behind === null ? '' : `, ${behind.toLocaleString()} behind head`
  }${meta._meta.hasIndexingErrors ? ' — HAS INDEXING ERRORS' : ''}`
);

/**
 * The fixtures are only meaningful once the index is essentially live, not
 * merely past the first BUFI block. BUFI's history spans 2026-08-30 to now —
 * the identities were minted across two weeks and their agent URIs were
 * repaired TODAY — so an index at 59.6M legitimately shows an identity with
 * its ORIGINAL uri kind and no recent rating. `CAUGHT_UP_TOLERANCE` is about
 * an hour of Arc blocks.
 */
const CAUGHT_UP_TOLERANCE = 250_000;
const reachedBufi = indexed >= BUFI_HISTORY_START_BLOCK;
const caughtUp = reachedBufi && (behind === null || behind <= CAUGHT_UP_TOLERANCE);
record(
  'caught up to the chain',
  caughtUp ? 'pass' : 'pending',
  !reachedBufi
    ? `${(BUFI_HISTORY_START_BLOCK - indexed).toLocaleString()} blocks short of ${BUFI_HISTORY_START_BLOCK.toLocaleString()}, where BUFI's history starts — still syncing, not broken`
    : caughtUp
      ? 'within an hour of head'
      : `past BUFI's first block but ${behind?.toLocaleString()} behind head — recent writes (rating, agent-URI repair) are not in yet`
);

const registries = await query<{
  identityRegistries: { agentCount: string }[];
  agenticCommerces: { jobCount: string; settledJobCount: string; settledVolume: string }[];
}>(
  '{ identityRegistries { agentCount } agenticCommerces { jobCount settledJobCount settledVolume } }'
);
// A registry entity only exists once the index has seen its first event, so an
// empty result during the first sync is pending, not a failure.
record(
  'registry counters',
  registries.identityRegistries.length > 0 ? 'pass' : caughtUp ? 'fail' : 'pending',
  registries.identityRegistries.length > 0
    ? `${registries.identityRegistries[0]?.agentCount ?? 0} agents, ${
        registries.agenticCommerces[0]?.jobCount ?? 0
      } jobs (${registries.agenticCommerces[0]?.settledJobCount ?? 0} settled)`
    : 'no registry seen yet'
);

const agent = await query<{
  agent: { agentId: string; agentURIKind: string; verifiedFeedbackCount: string } | null;
}>('query($id: ID!) { agent(id: $id) { agentId agentURIKind verifiedFeedbackCount } }', {
  id: entityId(CHAIN_ID, IDENTITY_REGISTRY, FIXTURE_AGENT_ID),
});
record(
  `agent ${FIXTURE_AGENT_ID}`,
  agent.agent ? 'pass' : caughtUp ? 'fail' : 'pending',
  agent.agent
    ? `uri ${agent.agent.agentURIKind}, ${agent.agent.verifiedFeedbackCount} verified ratings`
    : 'not indexed yet'
);

const job = await query<{
  job: { status: string; settled: boolean; providerPayment: string } | null;
}>('query($id: ID!) { job(id: $id) { status settled providerPayment } }', {
  id: entityId(CHAIN_ID, ESCROW, FIXTURE_JOB_ID),
});
record(
  `job ${FIXTURE_JOB_ID}`,
  job.job?.settled ? 'pass' : caughtUp ? 'fail' : 'pending',
  job.job
    ? `${job.job.status}, settled=${job.job.settled}, paid ${job.job.providerPayment}`
    : 'not indexed yet'
);

// tsquery syntax: a multi-word term must be `A & B`; a bare space is an error.
const search = await query<{ agentProfileSearch: { name: string | null }[] }>(
  '{ agentProfileSearch(text: "Nice & Team", first: 5) { name } }'
).catch(error => {
  record('fulltext search', 'fail', (error as Error).message);
  return null;
});
if (search) {
  const names = search.agentProfileSearch.map(row => row.name).filter(Boolean);
  record(
    'fulltext search',
    names.length > 0 ? 'pass' : caughtUp ? 'fail' : 'pending',
    names.length > 0 ? names.join(', ') : 'no match yet'
  );
}

if (asJson) {
  console.log(JSON.stringify({ url, indexed, head, behind, checks }, null, 2));
} else {
  const mark = { pass: '✔', fail: '✘', pending: '…' } as const;
  console.log(`\n${url}\n`);
  for (const check of checks) console.log(`  ${mark[check.state]} ${check.name}: ${check.detail}`);
  const failed = checks.filter(check => check.state === 'fail').length;
  const pending = checks.filter(check => check.state === 'pending').length;
  console.log(
    `\n${checks.length - failed - pending} passed, ${pending} pending (still syncing), ${failed} failed\n`
  );
}

process.exit(checks.some(check => check.state === 'fail') ? 1 : 0);
