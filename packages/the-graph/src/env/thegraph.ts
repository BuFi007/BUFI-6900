/**
 * The Graph — gateway credentials and subgraph references (plan 342).
 *
 * Env vars:
 *   GRAPH_GATEWAY_API_KEY — Subgraph Studio gateway (QUERY) key. Required for
 *     every gateway query. The Studio DEPLOY key is a different credential
 *     that never enters an app runtime (`graph auth` on an operator machine).
 *   THEGRAPH_<KIND>_<CHAIN>_SUBGRAPH_ID / THEGRAPH_<KIND>_<CHAIN>_DEPLOYMENT_ID —
 *     optional per-subgraph, per-chain overrides, e.g.
 *     THEGRAPH_ERC8183_ARC_TESTNET_SUBGRAPH_ID. A deployment id (Qm…) pins one
 *     immutable version so a consumer's types cannot drift under it; a
 *     subgraph id follows the latest published version. Setting EITHER
 *     override replaces BOTH defaults for that ref, so a BUFI subgraph id can
 *     never be silently shadowed by a default deployment pin.
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

/** `THEGRAPH_ERC8183_ARC_TESTNET_SUBGRAPH_ID` for ('erc8183', 'arc-testnet', 'SUBGRAPH_ID'). */
export function subgraphEnvKey(
  kind: TheGraphSubgraphKind,
  chain: TheGraphChain,
  field: SubgraphEnvField
): string {
  return `THEGRAPH_${kind.toUpperCase()}_${chain.toUpperCase().replace(/-/g, '_')}_${field}`;
}

export function getSubgraphRef(
  kind: TheGraphSubgraphKind,
  chain: TheGraphChain = 'arc-testnet'
): SubgraphRef {
  const base = { kind, chain, chainId: THEGRAPH_CHAIN_IDS[chain] };
  const envSubgraphId = resolve(subgraphEnvKey(kind, chain, 'SUBGRAPH_ID'));
  const envDeploymentId = resolve(subgraphEnvKey(kind, chain, 'DEPLOYMENT_ID'));
  if (envSubgraphId || envDeploymentId) {
    return {
      ...base,
      subgraphId: envSubgraphId || null,
      deploymentId: envDeploymentId || null,
    };
  }
  return { ...base, ...DEFAULT_REFS[chain][kind] };
}

/** Thrown when a ref has neither a default nor an env override. */
export class MissingSubgraphError extends Error {
  readonly code = 'THEGRAPH_SUBGRAPH_NOT_CONFIGURED';
  constructor(readonly ref: Pick<SubgraphRef, 'kind' | 'chain'>) {
    super(
      `[env] No ${ref.kind} subgraph configured for ${ref.chain}. Set ` +
        `${subgraphEnvKey(ref.kind, ref.chain, 'SUBGRAPH_ID')} or ` +
        `${subgraphEnvKey(ref.kind, ref.chain, 'DEPLOYMENT_ID')} (plan 342 S3).`
    );
    this.name = 'MissingSubgraphError';
  }
}

/** Gateway URL for a ref: a deployment pin wins over a subgraph id. */
export function subgraphQueryUrl(ref: SubgraphRef): string {
  if (ref.deploymentId) return `${THEGRAPH_GATEWAY_URL}/deployments/id/${ref.deploymentId}`;
  if (ref.subgraphId) return `${THEGRAPH_GATEWAY_URL}/subgraphs/id/${ref.subgraphId}`;
  throw new MissingSubgraphError(ref);
}
