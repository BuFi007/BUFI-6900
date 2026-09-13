import { buildCspHeader } from './proxy';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

function connectSources(): string[] {
  const directive = buildCspHeader({ allowUnsafeEval: false })
    .split('; ')
    .find(value => value.startsWith('connect-src '));
  return directive?.slice('connect-src '.length).split(' ') ?? [];
}

/** Production API origins of Ledger's backends. Marketing / support links
 * (www, shop, support, go), icon CDN (img-src) and the staging tiers
 * (`*.stg.ldg-tech.com`, `ledger-test.com`) are deliberately excluded. */
const LEDGER_PRODUCTION_API_ORIGIN =
  /^(?:https|wss):\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.api\.(?:live\.)?ledger\.com$|^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.api\.aws\.prd\.ldg-tech\.com$/;

function ledgerBundleApiOrigins(): string[] {
  const bundlePath = createRequire(import.meta.url).resolve('@ledgerhq/ledger-wallet-provider');
  const bundle = readFileSync(bundlePath, 'utf8');
  const origins = new Set<string>();
  for (const match of bundle.matchAll(/(?:https|wss):\/\/[A-Za-z0-9.-]+/g)) {
    const origin = match[0].toLowerCase();
    if (LEDGER_PRODUCTION_API_ORIGIN.test(origin)) origins.add(origin);
  }
  return [...origins].sort();
}

describe('Ledger Wallet Provider CSP', () => {
  test('allows the Ledger API origins used from initialization through Ledger Sync and signing', () => {
    expect(connectSources()).toEqual(
      expect.arrayContaining([
        // initialization
        'https://ledgerb.api.ledger.com',
        'https://countervalues.live.ledger.com',
        // Ledger Sync — 2026-09-05: without trustchain the SDK died at
        // `LKRP authentication failed` after the desktop activation step.
        'https://trustchain.api.live.ledger.com',
        'https://cloud-sync-backend.api.aws.prd.ldg-tech.com',
        // accounts + signing
        'https://explorers.api.live.ledger.com',
        'https://web3checks-backend.api.ledger.com',
        'wss://scriptrunner.api.live.ledger.com',
      ])
    );
  });

  test('every production API origin in the installed provider bundle is allowed (drift guard)', () => {
    const bundleOrigins = ledgerBundleApiOrigins();
    // Guard against a vacuous pass if the bundle moves or the regex rots.
    expect(bundleOrigins.length).toBeGreaterThanOrEqual(5);

    const allowed = new Set(connectSources());
    const missing = bundleOrigins.filter(origin => !allowed.has(origin));
    expect(missing).toEqual([]);
  });
});
