import { buildAgenticEnsName, buildFaceEnsName, buildWorkspaceEnsName } from './ens-name';

/**
 * BUFI Tags — human names for every wallet face (Plan 204).
 *
 * The cross-surface contract for the off-chain tag registry that abstracts
 * blockchain addresses behind `<name>.bufi` handles. Shared by BOTH the shiva
 * `/wallet-tags` routes (server) and the desk web + expo clients, so format
 * validation, the reserved list, and the wire shapes can never disagree.
 *
 * Modelled on Uniswap's off-chain Unitag registry (look, never copy — upstream
 * is GPL-3.0):
 *   github.com/Uniswap/interface/tree/main/packages/uniswap/src/features/unitags
 * Key divergences: our custodial wallets are Supabase-JWT-bound, so a JWT
 * replaces Unitag's wallet `signMessage` proof; workspace tags are claimed ONCE
 * atomically at team creation and face subtags (`operations`/`treasury`/`agent`)
 * derive from the workspace tag rather than being separately claimable.
 *
 * Tags are UX; addresses are truth. A tag must NEVER become the payload identity
 * on a money path — resolution yields the real address, and that address is what
 * enters any transfer/allowlist check (Plan 204 STOP condition).
 */

/** The public suffix every BUFI tag renders with (`acme.bufi`). */
export const BUFI_TAG_SUFFIX = 'bufi';

/** Registry row kinds. */
export type WalletTagKind = 'personal' | 'workspace' | 'face';

/** Which team face a `kind: 'face'` tag binds to. */
export type WalletTagFace = 'treasury' | 'agent';

/**
 * A face a tag row may still CARRY but that no longer routes. Plan 327
 * (founder, 2026-09-06) retired the operations wallet; `<name>.operations.bufi`
 * rows minted before that stay in the registry for display and history and
 * resolve to nothing — money must never reach a retired wallet through a
 * correct-looking tag.
 */
export type LegacyWalletTagFace = 'operations';

/**
 * Every derived face, in canonical order — the SINGLE source of the face set
 * for both the server derivation (`deriveWorkspaceTagSet`) and the client
 * renderers. Two faces since plan 327 (treasury, agent); there is no `wallet`
 * face, and `wallet` stays in {@link RESERVED_TAG_NAMES}.
 */
export const WALLET_TAG_FACES: readonly WalletTagFace[] = ['treasury', 'agent'] as const;
export const LEGACY_WALLET_TAG_FACES: readonly LegacyWalletTagFace[] = ['operations'] as const;

/**
 * Runtime narrowing for a persisted `face` column (typed `string | null` by the
 * generated DB types). Used on the resolve money path so an unrecognised OR
 * retired face value can never be treated as a routable face — it falls
 * through to the fail-closed 404 instead of being cast into the union.
 */
export function isWalletTagFace(value: unknown): value is WalletTagFace {
  return typeof value === 'string' && (WALLET_TAG_FACES as readonly string[]).includes(value);
}

/** A retired face value on a persisted row — renderable, never routable. */
export function isLegacyWalletTagFace(value: unknown): value is LegacyWalletTagFace {
  return (
    typeof value === 'string' && (LEGACY_WALLET_TAG_FACES as readonly string[]).includes(value)
  );
}

/** Lifecycle status. `tombstoned` blocks instant re-registration sniping. */
export type WalletTagStatus = 'active' | 'tombstoned';

/**
 * Min/max length of the claimable label (the part before `.bufi`, and before
 * any face subtag). Matches the shared regex below.
 */
export const WALLET_TAG_MIN_LENGTH = 3;
export const WALLET_TAG_MAX_LENGTH = 32;

/**
 * Shared format regex — the ONLY source of truth for the claimable label shape,
 * imported client-side (inline validation) and server-side (route + DB guard).
 * Lowercase alphanumerics only, 3–32 chars. Normalize (NFKC + lowercase) BEFORE
 * testing — this regex does not itself normalize.
 */
export const WALLET_TAG_LABEL_REGEX = /^[a-z0-9]{3,32}$/;

/**
 * Reserved labels — rejected at both the format layer and the DB check
 * constraint. Covers face subtags, brand/infra names, and rails so a workspace
 * can never shadow a derived face tag or an infrastructure host.
 */
export const RESERVED_TAG_NAMES: readonly string[] = [
  // face subtags (derived, never separately claimable)
  'operations',
  'treasury',
  'agent',
  // brand / infra
  'admin',
  'bufi',
  'bu',
  'www',
  'api',
  'app',
  'root',
  'support',
  'help',
  'wallet',
  'team',
  'workspace',
  'personal',
  // rails / brand names
  'circle',
  'bridge',
  'alfred',
  'usdc',
  'eurc',
  'ens',
  'uniswap',
  // agentic discovery faces (Plan 313) — never separately claimable
  'mcp',
  'webmcp',
  'x402',
] as const;

/**
 * NFKC-normalize + lowercase + trim a raw input into the canonical label form.
 * Does NOT validate — callers must then test {@link isValidTagLabel}. Runs the
 * same way client and server so a claim can't normalize differently than its
 * availability check.
 */
export function normalizeTagLabel(raw: string): string {
  return raw.normalize('NFKC').trim().toLowerCase();
}

/** Format-only validity (assumes already normalized). */
export function isValidTagLabel(normalized: string): boolean {
  return WALLET_TAG_LABEL_REGEX.test(normalized);
}

/**
 * Slugify an arbitrary display name (e.g. "Acme Corp") into a candidate tag
 * label ("acmecorp"): NFKD-fold to strip diacritics, lowercase, drop every
 * non-`[a-z0-9]` char, cap at the max length. The result may still be too short
 * to be valid — callers MUST re-check {@link isValidTagLabel} / reserved. Used
 * at team creation so the workspace name IS the tag, slugified (Plan 204), with
 * the raw display name kept separately on the team row.
 */
export function slugifyTagLabel(raw: string): string {
  return raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, WALLET_TAG_MAX_LENGTH);
}

/**
 * Seed a workspace handle from the TEAM, never the person.
 * Prefer `legal_name` (the business) over display `name`. The person's
 * full name is only used to avoid claiming `{username}.bufi` when the
 * team row was auto-named after them and no legal name exists.
 *
 * EVERY candidate is filtered through {@link isClaimableTagLabel}, and the
 * function returns `''` when none survives. This is not defensive tidying —
 * it is the whole correctness condition of the claim step. A user only ever
 * REACHES that step because `createTeamAction` refused to auto-claim the
 * slugified name (too short, all punctuation, or reserved), so suggesting the
 * same slug back prefills a handle whose Claim button can never enable: the
 * availability hook reports `reserved`/`format`, `canClaim` stays false, and
 * the card has no skip. An empty field is recoverable; a poisoned one is a
 * dead end that looks like a working form.
 */
export function resolveWorkspaceTagSuggestedLabel(input: {
  teamName?: string | null;
  legalName?: string | null;
  userFullName?: string | null;
}): string {
  const legal = slugifyTagLabel(input.legalName ?? '');
  const team = slugifyTagLabel(input.teamName ?? '');
  const person = slugifyTagLabel(input.userFullName ?? '');
  // Same preference order as before — business name first, and never the
  // person alone — with each rung now required to be claimable.
  const candidates = [legal !== person ? legal : '', team !== person ? team : '', legal, team];
  return candidates.find(candidate => isClaimableTagLabel(candidate)) ?? '';
}

/** Reserved-name check (assumes already normalized). */
export function isReservedTagName(normalized: string): boolean {
  return RESERVED_TAG_NAMES.includes(normalized);
}

/**
 * Could this already-normalized label be claimed at all? Format plus reserved,
 * the two verdicts that are knowable WITHOUT asking the server — "taken" is
 * not, and stays the live availability check's job.
 *
 * The single home for that pair. `createTeamAction` uses it to decide whether
 * to auto-claim at team creation, and {@link resolveWorkspaceTagSuggestedLabel}
 * uses it to decide what to prefill. Those two answers must never disagree:
 * when creation refuses a slug and the suggestion offers it back, the user
 * lands on a claim screen prefilled with the one handle that cannot work.
 */
export function isClaimableTagLabel(label: string): boolean {
  return isValidTagLabel(label) && !isReservedTagName(label);
}

/**
 * The single client+server gate for a claimable workspace/personal label:
 * normalizes, then rejects bad format or reserved names. Returns the canonical
 * normalized label on success so callers persist exactly what was validated.
 */
export function validateTagLabel(
  raw: string
): { ok: true; label: string } | { ok: false; reason: 'format' | 'reserved' } {
  const label = normalizeTagLabel(raw);
  if (!isValidTagLabel(label)) return { ok: false, reason: 'format' };
  if (isReservedTagName(label)) return { ok: false, reason: 'reserved' };
  return { ok: true, label };
}

/** Compose the full personal/workspace tag (`acme.bufi`). */
export function buildRootTag(label: string): string {
  return `${label}.${BUFI_TAG_SUFFIX}`;
}

/**
 * Compose a face subtag from a workspace label
 * (`buildFaceTag('acme', 'treasury')` → `acme.treasury.bufi`). Face subtags are
 * derived, never separately claimed.
 */
export function buildFaceTag(workspaceLabel: string, face: WalletTagFace): string {
  return `${workspaceLabel}.${face}.${BUFI_TAG_SUFFIX}`;
}

/**
 * One row of the derived workspace tag set. Deliberately DB-agnostic — it
 * carries only the four fields that are also the public {@link WalletTag}
 * shape, so `@bu/supabase` can consume it structurally without taking a
 * dependency on this package (and without duplicating the tag scheme).
 */
export interface DerivedWalletTagRow {
  tag: string;
  label: string;
  kind: Extract<WalletTagKind, 'workspace' | 'face'>;
  face: WalletTagFace | null;
}

/**
 * Derive the COMPLETE set a workspace claim must persist: the workspace root
 * (`acme.bufi`) followed by one row per face (`acme.operations.bufi`,
 * `acme.treasury.bufi`, `acme.agent.bufi`), in {@link WALLET_TAG_FACES} order.
 *
 * Face subtags are derived, never separately claimable — `POST /wallet-tags/claim`
 * only accepts `personal | workspace`, and the reserved list blocks a workspace
 * from ever shadowing a face name. Persisting the whole set in ONE insert is
 * what makes the four rows all-or-nothing (see
 * `claimWorkspaceTagWithFaces` in `@bu/supabase/mutations/wallet-tags`).
 *
 * `label` MUST already be normalized + validated (see {@link validateTagLabel}).
 */
export function deriveWorkspaceTagSet(label: string): DerivedWalletTagRow[] {
  return [
    { tag: buildRootTag(label), label, kind: 'workspace', face: null },
    ...WALLET_TAG_FACES.map(face => ({
      tag: buildFaceTag(label, face),
      label,
      kind: 'face' as const,
      face,
    })),
  ];
}

/** Discovery faces under `agent` — MCP / WebMCP / x402. Not wallet-tag rows. */
export const AGENTIC_FACES = ['mcp', 'webmcp', 'x402'] as const;
export type AgenticFace = (typeof AGENTIC_FACES)[number];

export interface DerivedAgenticFace {
  label: string;
  face: AgenticFace;
  tag: string;
  ensName: string;
}

/** `mcp.agent.acme.bufi` / `mcp.agent.acme.bufi.eth` — preview metadata only. */
export function deriveAgenticFaceSet(label: string): DerivedAgenticFace[] {
  return AGENTIC_FACES.map(face => ({
    label,
    face,
    tag: `${face}.agent.${label}.${BUFI_TAG_SUFFIX}`,
    ensName: buildAgenticEnsName(label, face),
  }));
}

export interface Ensv2PreviewName {
  tag: string;
  ensName: string;
  face: WalletTagFace | AgenticFace | null;
  kind: 'workspace' | 'face' | 'agentic';
}

/**
 * Map off-chain tags + agentic faces to Sepolia ENSv2 preview names.
 * Product string `*.bufi.eth` is only shown after mint (see `minted`).
 *
 * `ensName` is NOT `tag + '.eth'`. ENS labels are hierarchical right to left,
 * so a face name has to put the face FIRST (`operations.acme.bufi.eth`) or the
 * workspace ends up parented to its own face. See `./ens-name`.
 */
export function mapWorkspaceToEnsv2Preview(label: string): Ensv2PreviewName[] {
  return [
    ...deriveWorkspaceTagSet(label).map(row => ({
      tag: row.tag,
      ensName: row.face ? buildFaceEnsName(row.label, row.face) : buildWorkspaceEnsName(row.label),
      face: row.face,
      kind: row.face ? ('face' as const) : ('workspace' as const),
    })),
    ...deriveAgenticFaceSet(label).map(row => ({
      tag: row.tag,
      ensName: row.ensName,
      face: row.face,
      kind: 'agentic' as const,
    })),
  ];
}

export function toEnsv2PreviewInserts(teamId: string, label: string) {
  return mapWorkspaceToEnsv2Preview(label).map(row => ({
    team_id: teamId,
    label,
    tag: row.tag,
    ens_name: row.ensName,
    kind: row.kind,
    face: row.face,
    network: 'sepolia' as const,
    // 'reserved' is the only honest starting state: the row exists, the name
    // resolves nowhere. It may only become 'resolvable' after a live
    // resolution actually returned our address (migration 20260901030000).
    resolution_state: 'reserved' as const,
  }));
}

/** A registry row as returned to clients (no internal-only columns). */
export interface WalletTag {
  tag: string;
  kind: WalletTagKind;
  face: WalletTagFace | null;
  status: WalletTagStatus;
}

/**
 * `GET /wallet-tags/availability?tag=` response. Opaque about the owner — never
 * leaks who holds a taken name, only that it is unavailable and (when free) the
 * kind a claim of it would create.
 */
export interface WalletTagAvailability {
  tag: string;
  available: boolean;
  /** Present when available — the kind a claim would create. */
  kind?: WalletTagKind;
  /** Present when unavailable — 'taken' | 'reserved' | 'format'. */
  reason?: 'taken' | 'reserved' | 'format';
}

/**
 * `GET /wallet-tags/resolve?tag=` response. FAIL-CLOSED: an unknown tag is a
 * 404, never a fuzzy match. `address` is the money-path truth the caller must
 * use — the tag is display only.
 */
export interface WalletTagResolution {
  tag: string;
  address: string;
  chain: string;
  face: WalletTagFace | null;
  kind: WalletTagKind;
}

/** `GET /wallet-tags/reverse?address=` response (display only). */
export interface WalletTagReverse {
  address: string;
  tag: string | null;
}

/** `POST /wallet-tags/claim` request body. */
export interface WalletTagClaimRequest {
  /** Raw label (pre-normalization); the server re-validates + normalizes. */
  label: string;
  kind: Extract<WalletTagKind, 'personal' | 'workspace'>;
  /** Required for workspace claims; the caller must own the team. */
  teamId?: string;
  /** Optional wallet binding for personal claims. */
  walletId?: string;
}

/** `POST /wallet-tags/claim` response. */
export interface WalletTagClaimResponse {
  tag: WalletTag;
}
