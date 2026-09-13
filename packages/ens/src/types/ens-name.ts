import type { AgenticFace, WalletTagFace } from './wallet-tags';

/**
 * The ENS parent every BUFI name hangs off. ONE definition, deliberately.
 *
 * Which parent we end up owning is an open founder decision (`bufi.eth` on
 * mainnet vs `bu.finance` via DNSSEC import), so changing it must be a one-line
 * edit here and nowhere else. Never write `` `${tag}.eth` `` at a call site.
 */
export const ENS_PARENT = 'bufi.eth';

/**
 * ENS labels are hierarchical RIGHT TO LEFT: in `a.b.c.eth`, `a` is a child of
 * `b.c.eth`. A `.bufi` TAG is a flat handle string and carries no such meaning,
 * which is why the two shapes legitimately differ:
 *
 *   buildFaceTag('acme', 'treasury')     -> 'acme.treasury.bufi'
 *   buildFaceEnsName('acme', 'treasury') -> 'treasury.acme.bufi.eth'
 *
 * The tag reads "acme's treasury handle". Appending `.eth` to it would read
 * "acme is a child of treasury.bufi.eth" — the workspace parented to its own
 * face, which inverts the hierarchy and is unfixable once anything is minted.
 * The `.bufi` tag scheme is frozen (plan 204); only this ENS projection is
 * being corrected.
 */

/** `acme` -> `acme.bufi.eth`. The workspace itself. */
export function buildWorkspaceEnsName(label: string): string {
  return `${label}.${ENS_PARENT}`;
}

/** `acme` + `treasury` -> `treasury.acme.bufi.eth`. A face OF the workspace. */
export function buildFaceEnsName(label: string, face: WalletTagFace): string {
  return `${face}.${label}.${ENS_PARENT}`;
}

/** `acme` + `mcp` -> `mcp.agent.acme.bufi.eth`. A discovery face under `agent`. */
export function buildAgenticEnsName(label: string, face: AgenticFace): string {
  return `${face}.agent.${label}.${ENS_PARENT}`;
}
