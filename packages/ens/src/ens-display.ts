/**
 * The single gate on rendering a `*.bufi.eth` string as a real name.
 *
 * Replaces the old `ensv2DisplayName(name, minted)`. A boolean was the wrong
 * shape: it let a name display as a live identity on the strength of an
 * assertion, with no requirement that a resolution had ever been attempted.
 * The gate is now the MEASURED `resolution_state` (see migration
 * 20260901030000) — a name shows only after a live resolution returned our
 * address.
 *
 * No `*.bufi.eth` name resolves anywhere today, so in practice this returns
 * null everywhere. That is the correct behaviour, not a bug: wiring the read
 * path while it renders nothing is exactly the point.
 */

/** Measured resolution state of a stored name. Mirrors the DB CHECK. */
export type EnsResolutionState = 'reserved' | 'resolvable' | 'revoked';

/** The suffix a BUFI product name renders with. */
export const ENS_PRODUCT_SUFFIX = '.bufi.eth';

/**
 * Return the name ONLY when it has been measured resolvable. Any other state —
 * including an unrecognised one — yields null, so an unknown value can never
 * fall through into "show it".
 */
export function ensDisplayName(
  ensName: string | null | undefined,
  resolutionState: EnsResolutionState | string | null | undefined
): string | null {
  if (!ensName) return null;
  return resolutionState === 'resolvable' ? ensName : null;
}

/** Whether a string is one of our product names at all. */
export function isEnsProductName(ensName: string): boolean {
  return ensName.endsWith(ENS_PRODUCT_SUFFIX);
}
