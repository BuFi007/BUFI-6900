/**
 * Minimal Graph gateway client (plan 342, D4).
 *
 * A fetch wrapper, not graphql-request: Shiva is on a bundle budget (plan 329)
 * and the two subgraphs need a dozen hand-written queries, so no GraphQL
 * dependency enters the tree. Every query is `POST <gateway url>` with a
 * Bearer gateway key; errors surface as `TheGraphQueryError` carrying the
 * gateway's own messages (a "bad indexers" store error, a schema mismatch), so
 * a caller can decide between fallback and 502 instead of reading a zero.
 */

import {
  getGraphGatewayApiKey,
  getSubgraphRef,
  type SubgraphRef,
  subgraphQueryUrl,
} from '@bu/env/thegraph';

export interface TheGraphErrorEntry {
  message: string;
}

export class TheGraphQueryError extends Error {
  readonly code = 'THEGRAPH_QUERY_FAILED';
  constructor(
    message: string,
    readonly status: number | null,
    readonly errors: readonly TheGraphErrorEntry[]
  ) {
    super(message);
    this.name = 'TheGraphQueryError';
  }
}

export interface TheGraphQueryOptions {
  /** Overrides `GRAPH_GATEWAY_API_KEY`. */
  apiKey?: string;
  signal?: AbortSignal;
  /** Default 10 s; the hosted MCP uses 120 s for complex queries, ours are point reads. */
  timeoutMs?: number;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
}

export const DEFAULT_TIMEOUT_MS = 10_000;

interface GatewayBody<TData> {
  data?: TData | null;
  errors?: TheGraphErrorEntry[];
}

function combineSignals(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeout]);
  return signal;
}

/**
 * Runs one GraphQL document against a subgraph ref and returns its `data`.
 * Throws `MissingSubgraphError` (from `@bu/env/thegraph`) when the ref has no
 * id, and `TheGraphQueryError` for HTTP failures, gateway errors and empty data.
 */
export async function queryTheGraph<TData>(
  ref: SubgraphRef,
  query: string,
  variables: Record<string, unknown> = {},
  options: TheGraphQueryOptions = {}
): Promise<TData> {
  const url = subgraphQueryUrl(ref);
  const apiKey = getGraphGatewayApiKey(options.apiKey);
  const fetchImpl = options.fetchImpl ?? fetch;
  const label = `${ref.kind}/${ref.chain}`;

  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
    signal: combineSignals(options.signal, options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new TheGraphQueryError(
      `The Graph gateway answered ${response.status} for ${label}`,
      response.status,
      []
    );
  }

  const body = (await response.json()) as GatewayBody<TData>;
  if (body.errors && body.errors.length > 0) {
    throw new TheGraphQueryError(
      `The Graph query failed for ${label}: ${body.errors.map(e => e.message).join('; ')}`,
      response.status,
      body.errors
    );
  }
  if (body.data === null || body.data === undefined) {
    throw new TheGraphQueryError(`The Graph returned no data for ${label}`, response.status, []);
  }
  return body.data;
}

export interface SubgraphMeta {
  blockNumber: number;
  /** Unix seconds. */
  blockTimestamp: number | null;
  deployment: string;
  hasIndexingErrors: boolean;
}

const META_QUERY = `query Meta {
  _meta { block { number timestamp } deployment hasIndexingErrors }
}`;

interface MetaData {
  _meta: {
    block: { number: number; timestamp: number | null };
    deployment: string;
    hasIndexingErrors: boolean;
  };
}

/** Indexing head of a ref: the smoke test after every deploy, and a health probe. */
export async function getSubgraphMeta(
  ref: SubgraphRef,
  options: TheGraphQueryOptions = {}
): Promise<SubgraphMeta> {
  const data = await queryTheGraph<MetaData>(ref, META_QUERY, {}, options);
  return {
    blockNumber: data._meta.block.number,
    blockTimestamp: data._meta.block.timestamp ?? null,
    deployment: data._meta.deployment,
    hasIndexingErrors: data._meta.hasIndexingErrors,
  };
}

export { getSubgraphRef };
export type { SubgraphRef };
