import type { WalletSetupApiClient } from '@bu/wallets/wallet-setup';
import { afterEach, describe, expect, it, vi } from 'vitest';

const initialize = vi.hoisted(() => vi.fn(() => () => {}));

vi.mock('@ledgerhq/ledger-wallet-provider', () => ({
  initializeLedgerProvider: initialize,
}));

describe('Ledger browser provider', () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    initialize.mockClear();
  });

  it('uses Ledger local dApp config for direct-device development without partner credentials', async () => {
    vi.stubEnv('NEXT_PUBLIC_LEDGER_WALLET_PROVIDER_API_KEY', '');
    vi.stubEnv('NEXT_PUBLIC_LEDGER_WALLET_PROVIDER_DAPP_ID', '');
    vi.stubEnv('NODE_ENV', 'development');

    const ledger = await import('./ledger-provider');
    await ledger.initializeLedgerProvider();

    expect(initialize).toHaveBeenCalledOnce();
    expect(initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        dAppIdentifier: '1inch',
        devConfig: { stub: { dAppConfig: true } },
        hideButton: true,
        loggerLevel: 'error',
      })
    );
  });

  it('does not initialize Ledger Wallet Provider without production partner credentials', async () => {
    vi.stubEnv('NEXT_PUBLIC_LEDGER_WALLET_PROVIDER_API_KEY', '');
    vi.stubEnv('NEXT_PUBLIC_LEDGER_WALLET_PROVIDER_DAPP_ID', '');
    vi.stubEnv('NODE_ENV', 'production');

    const ledger = await import('./ledger-provider');
    await ledger.initializeLedgerProvider();

    expect(initialize).not.toHaveBeenCalled();
  });

  // Regression: after "Message successfully signed" the server still spends
  // ~50s adding the owner on every treasury chain; the button must be able to
  // say so instead of "Check Ledger…" (founder report, 2026-09-05).
  it('reports connecting → signing → registering while linking a treasury signer', async () => {
    vi.stubEnv('NEXT_PUBLIC_LEDGER_WALLET_PROVIDER_API_KEY', '');
    vi.stubEnv('NEXT_PUBLIC_LEDGER_WALLET_PROVIDER_DAPP_ID', '');
    vi.stubEnv('NODE_ENV', 'development');

    const address = '0x0000000000000000000000000000000000000001';
    const request = vi.fn(async ({ method }: { method: string }) =>
      method === 'eth_requestAccounts' ? [address] : '0xabc123'
    );
    const announce = () =>
      window.dispatchEvent(
        new CustomEvent('eip6963:announceProvider', {
          detail: {
            info: {
              uuid: '1',
              name: 'Ledger Wallet',
              icon: '',
              rdns: 'com.ledger.wallet.provider',
            },
            provider: { isLedgerButton: true, request },
          },
        })
      );
    window.addEventListener('eip6963:requestProvider', announce);

    const phases: string[] = [];
    const apiClient = {
      requestSignerChallenge: vi.fn(async () => ({
        challenge: 'c',
        challengeToken: 't',
        ledgerMessage: 'BUFI treasury signer\nNonce: k3Jd9pQx7Lm2Ab4c',
      })),
      registerTeamSigner: vi.fn(async () => ({ approvalRequired: false })),
    };

    try {
      const ledger = await import('./ledger-provider');
      await ledger.registerTreasuryLedgerSigner(apiClient as unknown as WalletSetupApiClient, {
        onPhase: phase => {
          phases.push(phase);
        },
      });
    } finally {
      window.removeEventListener('eip6963:requestProvider', announce);
    }

    expect(phases).toEqual(['connecting', 'signing', 'registering']);
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'personal_sign', params: [expect.any(String), address] })
    );
    expect(apiClient.registerTeamSigner).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ledger', ownerAddress: address, signature: '0xabc123' })
    );
  });
});
