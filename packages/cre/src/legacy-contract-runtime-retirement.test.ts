import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

const FORBIDDEN_RUNTIME_MARKERS = [
  'workflow-escrow-deploy',
  'workflow-escrow-dispute',
  'workflow-escrow-finalize',
  'workflow-escrow-yield',
  'escrow_yield_deposit',
  'escrow_yield_redeem',
] as const;

describe('legacy contract CRE runtime retirement', () => {
  test('keeps retired executor workflows out of Desk and Shiva runtime callers', async () => {
    const repo = resolve(import.meta.dir, '../../..');
    const grep = Bun.spawn(
      [
        'git',
        'grep',
        '--line-number',
        '--extended-regexp',
        FORBIDDEN_RUNTIME_MARKERS.join('|'),
        '--',
        'apps/app/src',
        'apps/shiva/src',
      ],
      { cwd: repo, stderr: 'pipe', stdout: 'pipe' }
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      grep.exited,
      new Response(grep.stdout).text(),
      new Response(grep.stderr).text(),
    ]);
    expect(stderr).toBe('');
    expect(exitCode === 1 ? '' : stdout).toBe('');
  });

  test('keeps contract execution authority in Shiva and CRE commitment-only', async () => {
    const repo = resolve(import.meta.dir, '../../..');
    const controller = await Bun.file(
      resolve(repo, 'apps/shiva/src/controllers/contracts.controller.ts')
    ).text();
    const settlementState = await Bun.file(
      resolve(repo, 'apps/shiva/src/services/contract-settlement-state.service.ts')
    ).text();
    const settlementMigration = await Bun.file(
      resolve(
        repo,
        'apps/api/supabase/migrations/20260719020000_contract_milestone_settlement_state.sql'
      )
    ).text();
    expect(controller).not.toContain('triggerCreWorkflowWithFallback');
    expect(controller).toContain('triggerContractLifecycleAttestation');
    expect(controller).toContain('completeMilestoneSettlement');
    expect(settlementState).toContain('complete_contract_milestone_settlement_v1');
    expect(settlementMigration).toContain(
      "'authority', CASE WHEN p_tx_hash IS NULL THEN 'shiva' ELSE 'erc8183' END"
    );
  });
});
