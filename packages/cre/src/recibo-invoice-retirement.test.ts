import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';

const repositoryFile = (path: string) =>
  readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');

describe('legacy embedded Recibo invoice retirement', () => {
  test('does not expose the embedded workflow through Shiva', () => {
    const shivaTrigger = repositoryFile('apps/shiva/src/services/cre-trigger.service.ts');

    expect(shivaTrigger).not.toContain('recibo_invoice_attest');
    expect(shivaTrigger).not.toContain("'workflow-recibo-invoice'");
  });

  test('has no embedded handler or deployable target in Desk', () => {
    for (const file of ['handlers.ts', 'workflow.yaml', '.cre_build_tmp.js']) {
      expect(
        existsSync(new URL(`../../../apps/cre/workflow-recibo-invoice/${file}`, import.meta.url))
      ).toBe(false);
    }
  });

  test('keeps the generic embedded invoice-settle workflow out of factoring and deployment', () => {
    for (const file of ['handlers.ts', 'workflow.yaml', '.cre_build_tmp.js']) {
      expect(
        existsSync(new URL(`../../../apps/cre/workflow-invoice-settle/${file}`, import.meta.url))
      ).toBe(false);
    }
  });

  test('does not embed the standalone factoring lifecycle in Desk', () => {
    const embeddedFactoringPath = new URL(
      '../../../apps/cre/workflow-factoring-lifecycle',
      import.meta.url
    );
    expect(existsSync(embeddedFactoringPath)).toBe(false);
  });
});
