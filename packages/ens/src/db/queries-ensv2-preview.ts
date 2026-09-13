import type { Client } from '../types';

/**
 * Names this team has that a live resolution actually returned our address for.
 *
 * Replaces `listMintedEnsv2Names`, which filtered on the `minted` boolean —
 * an assertion anyone could set, not evidence. The filter is now the measured
 * `resolution_state` (migration 20260901030000).
 *
 * Expect this to return EMPTY for every team today: no `*.bufi.eth` name
 * resolves anywhere yet. A non-empty result means something wrote
 * 'resolvable', which may only happen after a real resolution probe.
 */
export async function listResolvableEnsNames(client: Client, teamId: string) {
  const { data, error } = await client
    .from('ensv2_preview_names')
    .select('ens_name, tag, kind, face, network, resolution_state, verified_resolvable_at')
    .eq('team_id', teamId)
    .eq('resolution_state', 'resolvable');
  if (error) throw error;
  return data ?? [];
}

/**
 * Every name reserved for a team, whatever its state. Use this for anything
 * that must show the workspace's `.bufi` tags without claiming the `.eth`
 * projection resolves — pair it with `ensDisplayName` from `@bu/utils/ens-display`,
 * which returns null unless the row is measured resolvable.
 */
export async function listEnsNamesForTeam(client: Client, teamId: string) {
  const { data, error } = await client
    .from('ensv2_preview_names')
    .select('ens_name, tag, kind, face, network, resolution_state, verified_resolvable_at')
    .eq('team_id', teamId);
  if (error) throw error;
  return data ?? [];
}
