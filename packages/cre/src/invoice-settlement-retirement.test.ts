import { ATTESTATION_OP_TYPES, CRE_WORKFLOW_NAMES } from './constants';
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';

const repositoryFile = (path: string) =>
  readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');

describe('legacy embedded invoice settlement retirement', () => {
  test('keeps the protocol attestation enum without exposing a triggerable workflow', () => {
    expect(ATTESTATION_OP_TYPES.invoice_settle).toBe(2);
    expect(CRE_WORKFLOW_NAMES).not.toHaveProperty('INVOICE_SETTLE');
    expect(repositoryFile('packages/cre/src/client.ts')).not.toContain('triggerInvoiceSettlement');
    expect(repositoryFile('packages/cre/src/index.ts')).not.toContain('triggerInvoiceSettlement');
    expect(repositoryFile('apps/shiva/src/services/cre-trigger.service.ts')).not.toContain(
      "invoice_settle: 'workflow-invoice-settle'"
    );
  });

  test('does not retain an in-repository CRE engine or simulation entry point', () => {
    for (const path of [
      'apps/cre/README.md',
      'apps/cre/SIMULATION-GUIDE.md',
      'apps/cre/simulate-all.sh',
    ]) {
      expect(existsSync(new URL(`../../../${path}`, import.meta.url))).toBe(false);
    }
  });

  test('has no embedded handler, deployment manifest, or stale build artifact', () => {
    for (const file of ['handlers.ts', 'workflow.yaml', '.cre_build_tmp.js']) {
      expect(
        existsSync(new URL(`../../../apps/cre/workflow-invoice-settle/${file}`, import.meta.url))
      ).toBe(false);
    }
  });
});
