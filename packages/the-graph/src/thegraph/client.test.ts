import { MissingSubgraphError, type SubgraphRef } from '@bu/env/thegraph';

import { getSubgraphMeta, queryTheGraph, TheGraphQueryError } from './client';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

const REF: SubgraphRef = {
  kind: 'erc8004',
  chain: 'arc-testnet',
  chainId: 5042002,
  subgraphId: 'SubgraphId',
  deploymentId: null,
  queryUrl: null,
};

interface Captured {
  url: string;
  init: RequestInit;
}

function fakeFetch(status: number, body: unknown, captured: Captured[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

const savedKey = process.env.GRAPH_GATEWAY_API_KEY;
beforeEach(() => {
  process.env.GRAPH_GATEWAY_API_KEY = 'test-gateway-key';
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.GRAPH_GATEWAY_API_KEY;
  else process.env.GRAPH_GATEWAY_API_KEY = savedKey;
});

describe('queryTheGraph', () => {
  test('POSTs the document with a Bearer gateway key to the subgraph-id URL', async () => {
    const captured: Captured[] = [];
    const data = await queryTheGraph<{ ok: boolean }>(
      REF,
      'query { ok }',
      { a: 1 },
      { fetchImpl: fakeFetch(200, { data: { ok: true } }, captured) }
    );
    expect(data).toEqual({ ok: true });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe('https://gateway.thegraph.com/api/subgraphs/id/SubgraphId');
    const headers = captured[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer test-gateway-key');
    expect(JSON.parse(String(captured[0]?.init.body))).toEqual({
      query: 'query { ok }',
      variables: { a: 1 },
    });
  });

  test('prefers a deployment pin in the URL', async () => {
    const captured: Captured[] = [];
    await queryTheGraph(
      { ...REF, deploymentId: 'QmPinned' },
      'query { ok }',
      {},
      { fetchImpl: fakeFetch(200, { data: { ok: true } }, captured) }
    );
    expect(captured[0]?.url).toBe('https://gateway.thegraph.com/api/deployments/id/QmPinned');
  });

  test('an explicit apiKey option overrides the environment', async () => {
    const captured: Captured[] = [];
    await queryTheGraph(
      REF,
      'query { ok }',
      {},
      { apiKey: 'override-key', fetchImpl: fakeFetch(200, { data: { ok: true } }, captured) }
    );
    expect((captured[0]?.init.headers as Record<string, string>).authorization).toBe(
      'Bearer override-key'
    );
  });

  test('surfaces gateway errors (e.g. "bad indexers") as TheGraphQueryError with the messages', async () => {
    const fetchImpl = fakeFetch(200, {
      errors: [{ message: 'bad indexers: store error' }, { message: 'second' }],
    });
    const error = await queryTheGraph(REF, 'query { x }', {}, { fetchImpl }).catch(e => e);
    expect(error).toBeInstanceOf(TheGraphQueryError);
    expect((error as TheGraphQueryError).message).toContain('bad indexers: store error');
    expect((error as TheGraphQueryError).errors).toHaveLength(2);
    expect((error as TheGraphQueryError).status).toBe(200);
  });

  test('a non-2xx answer throws with the status, never returns a zero', async () => {
    const error = await queryTheGraph(
      REF,
      'query { x }',
      {},
      { fetchImpl: fakeFetch(401, {}) }
    ).catch(e => e);
    expect(error).toBeInstanceOf(TheGraphQueryError);
    expect((error as TheGraphQueryError).status).toBe(401);
  });

  test('null data throws', async () => {
    const error = await queryTheGraph(
      REF,
      'query { x }',
      {},
      { fetchImpl: fakeFetch(200, { data: null }) }
    ).catch(e => e);
    expect(error).toBeInstanceOf(TheGraphQueryError);
  });

  test('a ref with no id fails before any network call', async () => {
    const captured: Captured[] = [];
    const error = await queryTheGraph(
      { ...REF, kind: 'erc8183', subgraphId: null },
      'query { x }',
      {},
      { fetchImpl: fakeFetch(200, { data: {} }, captured) }
    ).catch(e => e);
    expect(error).toBeInstanceOf(MissingSubgraphError);
    expect(captured).toHaveLength(0);
  });

  test('a missing gateway key fails before any network call, naming the variable', async () => {
    delete process.env.GRAPH_GATEWAY_API_KEY;
    const captured: Captured[] = [];
    const error = await queryTheGraph(
      REF,
      'query { x }',
      {},
      {
        fetchImpl: fakeFetch(200, { data: {} }, captured),
      }
    ).catch(e => e);
    expect(String((error as Error).message)).toContain('GRAPH_GATEWAY_API_KEY');
    expect(captured).toHaveLength(0);
  });
});

describe('getSubgraphMeta', () => {
  test('flattens _meta into the indexing head', async () => {
    const meta = await getSubgraphMeta(REF, {
      fetchImpl: fakeFetch(200, {
        data: {
          _meta: {
            block: { number: 61905355, timestamp: 1789306139 },
            deployment: 'QmZaHT',
            hasIndexingErrors: false,
          },
        },
      }),
    });
    expect(meta).toEqual({
      blockNumber: 61905355,
      blockTimestamp: 1789306139,
      deployment: 'QmZaHT',
      hasIndexingErrors: false,
    });
  });
});
