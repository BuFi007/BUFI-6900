/**
 * ERC-8004 agent registration document as a `data:` URI (plan 342, D5).
 *
 * Why inline and not a URL: every BUFI identity minted so far points at
 * `https://desk.bu.finance/api/agents/<teamId>/metadata.json`, a route that
 * was never built (403 behind Cloudflare, no handler in the app), and the
 * ERC-8004 subgraph only parses `data:` agent URIs anyway — graph-node cannot
 * fetch HTTPS. An inline document is the only form that is both resolvable by
 * anyone with an RPC and searchable on The Graph.
 *
 * Shape: the community "8004scan" agent metadata profile the subgraph's
 * `resolveAgentRegistration` reads — `type`, `name`, `description`, `image`,
 * `active`, `services[]` (`name` classifies the kind: web / a2a / mcp / x402
 * / …), `registrations[]` (CAIP-10 registry + agentId, once known) and
 * `supportedTrust[]`. Unknown fields are kept by the parser as attributes, so
 * this can grow without a schema change on the index side.
 *
 * Kept pure: the mint path and the backfill script both call it, and the
 * on-chain string must be byte-identical for the same inputs (the backfill
 * compares against `tokenURI` to skip identities that are already current).
 */

import { toBase64 } from './base64';

export const AGENT_REGISTRATION_TYPE = 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1';

/** Hard cap on the encoded URI: it is calldata and an indexed string. */
export const AGENT_REGISTRATION_MAX_BYTES = 4096;

export interface AgentRegistrationService {
  /** `web`, `a2a`, `mcp`, `x402`, … — the subgraph classifies on this. */
  name: string;
  endpoint: string;
  version?: string;
}

export interface AgentRegistrationInput {
  /** Workspace display name; required by the profile. */
  name: string;
  description?: string | null;
  /** Absolute https URL only; storage paths and signed URLs are dropped. */
  image?: string | null;
  /** Desk origin, e.g. https://desk.bu.finance (no trailing slash needed). */
  appUrl: string;
  teamId: string;
  /** eip155 chain id of the identity registry; with `identityRegistry` yields `registrations[]`. */
  chainId?: number;
  identityRegistry?: string;
  /** Known after the mint; the backfill sets it, the mint omits it. */
  agentId?: string | null;
  /** Extra services beyond the public desk surfaces. */
  services?: AgentRegistrationService[];
}

export interface AgentRegistrationDocument {
  type: string;
  name: string;
  description?: string;
  image?: string;
  active: boolean;
  services: AgentRegistrationService[];
  registrations: Array<{ agentRegistry: string; agentId?: string }>;
  supportedTrust: string[];
}

const HTTPS_URL = /^https:\/\/[^\s"]+$/;
const MAX_DESCRIPTION = 500;

function cleanText(value: string | null | undefined, max: number): string | undefined {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The public desk surfaces every workspace exposes (`/api/public/agents/<teamId>/<surface>`). */
export function deskAgentServices(appUrl: string, teamId: string): AgentRegistrationService[] {
  const base = `${appUrl.replace(/\/+$/, '')}/api/public/agents/${teamId}`;
  return [
    { name: 'web', endpoint: `${base}/profile` },
    { name: 'a2a', endpoint: `${base}/agent-card.json` },
    { name: 'x402', endpoint: `${base}/x402` },
  ];
}

export function buildAgentRegistrationDocument(
  input: AgentRegistrationInput
): AgentRegistrationDocument {
  const name = cleanText(input.name, 120);
  if (!name) throw new Error('ERC8004_REGISTRATION_NAME_REQUIRED');

  const registrations: AgentRegistrationDocument['registrations'] = [];
  if (input.chainId && input.identityRegistry) {
    registrations.push({
      agentRegistry: `eip155:${input.chainId}:${input.identityRegistry.toLowerCase()}`,
      ...(input.agentId ? { agentId: String(input.agentId) } : {}),
    });
  }

  const description = cleanText(input.description, MAX_DESCRIPTION);
  const image = input.image && HTTPS_URL.test(input.image) ? input.image : undefined;

  return {
    type: AGENT_REGISTRATION_TYPE,
    name,
    ...(description ? { description } : {}),
    ...(image ? { image } : {}),
    active: true,
    services: [...deskAgentServices(input.appUrl, input.teamId), ...(input.services ?? [])],
    registrations,
    supportedTrust: ['reputation'],
  };
}

/** `data:application/json;base64,<document>` — the string that goes on-chain. */
export function buildAgentRegistrationDataUri(input: AgentRegistrationInput): string {
  const json = JSON.stringify(buildAgentRegistrationDocument(input));
  const uri = `data:application/json;base64,${toBase64(json)}`;
  if (uri.length > AGENT_REGISTRATION_MAX_BYTES) {
    throw new Error(
      `ERC8004_REGISTRATION_TOO_LARGE: ${uri.length} > ${AGENT_REGISTRATION_MAX_BYTES}`
    );
  }
  return uri;
}

export function isAgentRegistrationDataUri(uri: string): boolean {
  return uri.startsWith('data:application/json;base64,');
}
