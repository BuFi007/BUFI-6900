/**
 * Entity ids for the ERC-8004 and ERC-8183 subgraphs (plan 342).
 *
 * Both subgraphs scope every id by chain so the same contract address on two
 * chains never collides: the id is the UTF-8 bytes of
 * `"<chainId>:<contract, lowercased>[:<part>…]"`, sent to the gateway as a
 * `0x`-hex `Bytes` value. Verified against live ids on 2026-09-13, e.g. the
 * Arc Testnet identity registry
 * `0x353034323030323a3078383030346138313862666239313232333363343931383731623364383463383961343934626439`
 * decodes to `5042002:0x8004a818bfb912233c491871b3d84c89a494bd9e`.
 */

import type { HexString } from '@bu/types/evm';
import { concatHex, keccak256 } from 'viem';

export type ChainScopedIdPart = string | number | bigint;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const DECODED_RE = /^(\d+):(0x[0-9a-f]{40})((?::[^:]+)*)$/;

export class InvalidEntityIdInputError extends Error {
  readonly code = 'THEGRAPH_INVALID_ENTITY_ID_INPUT';
  constructor(message: string) {
    super(message);
    this.name = 'InvalidEntityIdInputError';
  }
}

function utf8ToHex(text: string): string {
  let out = '';
  for (const byte of new TextEncoder().encode(text)) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

function hexToUtf8(hex: string): string {
  const body = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (body.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(body)) {
    throw new InvalidEntityIdInputError(`Not a hex string: ${hex}`);
  }
  const bytes = new Uint8Array(body.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
  }
  return new TextDecoder().decode(bytes);
}

function requireAddress(address: string): string {
  if (!ADDRESS_RE.test(address)) {
    throw new InvalidEntityIdInputError(`Not an EVM address: ${address}`);
  }
  return address.toLowerCase();
}

function requireChainId(chainId: ChainScopedIdPart): string {
  const text = String(chainId);
  if (!/^\d+$/.test(text)) {
    throw new InvalidEntityIdInputError(`Not a chain id: ${text}`);
  }
  return text;
}

/** `"<chainId>:<address>[:<part>…]"` as `0x`-hex Bytes. */
export function chainScopedEntityId(
  chainId: ChainScopedIdPart,
  address: string,
  ...parts: ChainScopedIdPart[]
): HexString {
  const text = [requireChainId(chainId), requireAddress(address), ...parts.map(String)].join(':');
  return `0x${utf8ToHex(text)}`;
}

/** `IdentityRegistry` / `ReputationRegistry` / `AgenticCommerce` entity id. */
export function registryEntityId(chainId: ChainScopedIdPart, registry: string): HexString {
  return chainScopedEntityId(chainId, registry);
}

/** ERC-8004 `Agent` entity id: chain, identity registry, agentId. */
export function agentEntityId(
  chainId: ChainScopedIdPart,
  identityRegistry: string,
  agentId: ChainScopedIdPart
): HexString {
  return chainScopedEntityId(chainId, identityRegistry, agentId);
}

/** ERC-8004 `Feedback` entity id: chain, reputation registry, agentId, client, feedbackIndex. */
export function feedbackEntityId(
  chainId: ChainScopedIdPart,
  reputationRegistry: string,
  agentId: ChainScopedIdPart,
  client: string,
  feedbackIndex: ChainScopedIdPart
): HexString {
  return chainScopedEntityId(
    chainId,
    reputationRegistry,
    agentId,
    requireAddress(client),
    feedbackIndex
  );
}

/** ERC-8183 `Job` entity id: chain, escrow contract, jobId (uint256 as a string). */
export function jobEntityId(
  chainId: ChainScopedIdPart,
  contract: string,
  jobId: ChainScopedIdPart
): HexString {
  return chainScopedEntityId(chainId, contract, jobId);
}

export interface DecodedChainScopedId {
  chainId: number;
  address: string;
  parts: string[];
}

/** Inverse of `chainScopedEntityId`; throws on anything that is not one. */
export function decodeChainScopedEntityId(id: string): DecodedChainScopedId {
  const text = hexToUtf8(id);
  const match = DECODED_RE.exec(text);
  if (!match) throw new InvalidEntityIdInputError(`Not a chain-scoped entity id: ${text}`);
  // The pattern guarantees groups 1 and 2; the fallbacks only satisfy the
  // stricter consumer tsconfigs (noUncheckedIndexedAccess) that walk this source.
  const chainId = match[1] ?? '';
  const address = match[2] ?? '';
  const rest = match[3] ?? '';
  return {
    chainId: Number(chainId),
    address,
    parts: rest ? rest.slice(1).split(':') : [],
  };
}

/**
 * BUFI `Engagement` entity id: keccak256 of the client agent id bytes followed
 * by the provider agent id bytes — directed, so client→provider and
 * provider→client are two edges. Mirrors `engagementId` in
 * `packages/subgraph-arc/src/bufi/engagement.ts`.
 */
export function engagementEntityId(
  clientAgentId: HexString,
  providerAgentId: HexString
): HexString {
  return keccak256(concatHex([clientAgentId, providerAgentId]));
}
