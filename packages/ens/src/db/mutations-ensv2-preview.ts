import { createLogger } from '@bufinance/logger';

import type { Client, TablesInsert } from '../types';

const logger = createLogger({ prefix: 'ensv2-preview' });

/**
 * Persist Sepolia ENSv2 preview names after a workspace claim.
 * Non-fatal. Does not mint. Does not touch Arc money.
 * Caller maps names via `mapWorkspaceToEnsv2Preview` — this package
 * must not import `@bu/api-types`.
 */
export async function recordEnsv2PreviewNames(
  client: Client,
  rows: TablesInsert<'ensv2_preview_names'>[]
): Promise<void> {
  if (rows.length === 0) return;
  const { error } = await client.from('ensv2_preview_names').upsert(rows, {
    onConflict: 'team_id,ens_name',
    ignoreDuplicates: true,
  });
  if (error) {
    logger.warn('ENSv2 preview dual-write failed (non-fatal)', { error: error.message });
  }
}
