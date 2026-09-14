/**
 * The Graph — gateway credentials and subgraph references (plan 342).
 *
 * Env vars:
 *   GRAPH_GATEWAY_API_KEY — Subgraph Studio gateway (QUERY) key. Required for
 *     every gateway query. The Studio DEPLOY key is a different credential
 *     that never enters an app runtime (`graph auth` on an operator machine).
 *   THEGRAPH_<CHAIN>_SUBGRAPH_ID / THEGRAPH_<CHAIN>_DEPLOYMENT_ID — the BUFI
 *     Arc subgraph for a chain (e.g. THEGRAPH_ARC_TESTNET_SUBGRAPH_ID). BUFI
 *     indexes identity, reputation AND commerce on ONE graph
 *     (`packages/subgraph-arc`), so one id serves every kind.
 *   THEGRAPH_<CHAIN>_QUERY_URL — a verbatim query endpoint that wins over ids:
 *     the Subgraph Studio dev endpoint
 *     (https://api.studio.thegraph.com/query/<user>/<slug>/<version>) serves a
 *     deployed-but-unpublished subgraph without a gateway key, which is the
 *     testnet-preview path until the subgraph is published to the network.
 *   THEGRAPH_<KIND>_<CHAIN>_SUBGRAPH_ID / …_DEPLOYMENT_ID — optional per-kind
 *     overrides on top, e.g. THEGRAPH_ERC8183_ARC_TESTNET_SUBGRAPH_ID, for the
 *     day a kind is split out. A deployment id (Qm…) pins one immutable
 *     version so a consumer's types cannot drift under it; a subgraph id
 *     follows the latest published version. Setting EITHER field at a level
 *     replaces BOTH values from the level below, so a BUFI subgraph id can
 *     never be silently shadowed by a stale deployment pin.
 *
 * Defaults are BUFI-OWNED deployments only. Until plan 342 S3 deploys
 * `bufi-arc-testnet`, every ref is unconfigured and `subgraphQueryUrl` throws
 * `MissingSubgraphError` naming the env var. A third-party subgraph is never a
 * default: the founder's rule (2026-09-13) is that BUFI indexes its own
 * business logic on its own deployment, and a foreign index that happens to
 * cover the same registries today can change schema, contract or ownership
 * tomorrow without anyone here noticing.
 */

import { required, resolve } from './core';

export const THEGRAPH_GATEWAY_URL = 'https://gateway.thegraph.com/api';

export type TheGraphSubgraphKind = 'erc8004' | 'erc8183';

/** Network ids exactly as The Graph's networks registry spells them. */
export type TheGraphChain = 'arc-testnet' | 'arc';

/** eip155 chain ids per The Graph networks registry (v0.7.120, 2026-09-13). */
export const THEGRAPH_CHAIN_IDS: Record<TheGraphChain, number> = {
  'arc-testnet': 5042002,
  arc: 5042,
};

export interface SubgraphRef {
  kind: TheGraphSubgraphKind;
  chain: TheGraphChain;
  chainId: number;
  /** Follows the latest published version of the subgraph. */
  subgraphId: string | null;
  /** Pins one immutable deployment; preferred over `subgraphId` when set. */
  deploymentId: string | null;
  /** A verbatim query endpoint (Studio dev URL); wins over both ids when set. */
  queryUrl: string | null;
}

type RefDefaults = Pick<SubgraphRef, 'subgraphId' | 'deploymentId'>;

const NONE: RefDefaults = { subgraphId: null, deploymentId: null };

/** Filled in by plan 342 S3 once `bufi-arc-testnet` is published. */
const DEFAULT_REFS: Record<TheGraphChain, Record<TheGraphSubgraphKind, RefDefaults>> = {
  'arc-testnet': { erc8004: NONE, erc8183: NONE },
  arc: { erc8004: NONE, erc8183: NONE },
};

export function getGraphGatewayApiKey(override?: string): string {
  return required('GRAPH_GATEWAY_API_KEY', override);
}

export function hasGraphGatewayApiKey(): boolean {
  return Boolean(resolve('GRAPH_GATEWAY_API_KEY'));
}

export type SubgraphEnvField = 'SUBGRAPH_ID' | 'DEPLOYMENT_ID';

/** `THEGRAPH_ARC_TESTNET_SUBGRAPH_ID` for ('arc-testnet', 'SUBGRAPH_ID'): the combined BUFI graph. */
export function chainSubgraphEnvKey(chain: TheGraphChain, field: SubgraphEnvField): string {
  return `THEGRAPH_${chain.toUpperCase().replace(/-/g, '_')}_${field}`;
}

/** `THEGRAPH_ERC8183_ARC_TESTNET_SUBGRAPH_ID` for ('erc8183', 'arc-testnet', 'SUBGRAPH_ID'). */
export function subgraphEnvKey(
  kind: TheGraphSubgraphKind,
  chain: TheGraphChain,
  field: SubgraphEnvField
): string {
  return `THEGRAPH_${kind.toUpperCase()}_${chain.toUpperCase().replace(/-/g, '_')}_${field}`;
}

function envLevel(subgraphKey: string, deploymentKey: string): RefDefaults | null {
  const subgraphId = resolve(subgraphKey);
  const deploymentId = resolve(deploymentKey);
  if (!subgraphId && !deploymentId) return null;
  return { subgraphId: subgraphId || null, deploymentId: deploymentId || null };
}

/** `THEGRAPH_ARC_TESTNET_QUERY_URL` for 'arc-testnet'. */
export function chainQueryUrlEnvKey(chain: TheGraphChain): string {
  return `THEGRAPH_${chain.toUpperCase().replace(/-/g, '_')}_QUERY_URL`;
}

export function getSubgraphRef(
  kind: TheGraphSubgraphKind,
  chain: TheGraphChain = 'arc-testnet'
): SubgraphRef {
  const base = {
    kind,
    chain,
    chainId: THEGRAPH_CHAIN_IDS[chain],
    queryUrl: resolve(chainQueryUrlEnvKey(chain)) || null,
  };
  const perKind = envLevel(
    subgraphEnvKey(kind, chain, 'SUBGRAPH_ID'),
    subgraphEnvKey(kind, chain, 'DEPLOYMENT_ID')
  );
  if (perKind) return { ...base, ...perKind };
  const perChain = envLevel(
    chainSubgraphEnvKey(chain, 'SUBGRAPH_ID'),
    chainSubgraphEnvKey(chain, 'DEPLOYMENT_ID')
  );
  if (perChain) return { ...base, ...perChain };
  return { ...base, ...DEFAULT_REFS[chain][kind] };
}

/** Thrown when a ref has neither a default nor an env override. */
export class MissingSubgraphError extends Error {
  readonly code = 'THEGRAPH_SUBGRAPH_NOT_CONFIGURED';
  constructor(readonly ref: Pick<SubgraphRef, 'kind' | 'chain'>) {
    super(
      `[env] No ${ref.kind} subgraph configured for ${ref.chain}. Set ` +
        `${chainQueryUrlEnvKey(ref.chain)} (Studio endpoint), ` +
        `${chainSubgraphEnvKey(ref.chain, 'SUBGRAPH_ID')} (the BUFI Arc graph) or ` +
        `${subgraphEnvKey(ref.kind, ref.chain, 'SUBGRAPH_ID')} (plan 342 S3).`
    );
    this.name = 'MissingSubgraphError';
  }
}

/** Query URL for a ref: a verbatim endpoint wins, then a deployment pin, then the subgraph id. */
export function subgraphQueryUrl(ref: SubgraphRef): string {
  if (ref.queryUrl) return ref.queryUrl;
  if (ref.deploymentId) return `${THEGRAPH_GATEWAY_URL}/deployments/id/${ref.deploymentId}`;
  if (ref.subgraphId) return `${THEGRAPH_GATEWAY_URL}/subgraphs/id/${ref.subgraphId}`;
  throw new MissingSubgraphError(ref);
}

/**
 * Whether this URL is billed through the decentralised gateway, and therefore
 * needs `GRAPH_GATEWAY_API_KEY`.
 *
 * A Subgraph Studio endpoint (`api.studio.thegraph.com/query/...`) and a local
 * graph-node serve without any key, so requiring one there couples a keyless
 * read to an unrelated secret and throws in exactly the environment that
 * deliberately has no key — production, which holds none until a mainnet
 * subgraph exists.
 */
export function subgraphQueryUrlNeedsApiKey(url: string): boolean {
  return url.startsWith(THEGRAPH_GATEWAY_URL);
}
