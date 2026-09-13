'use client';

import type { WalletSetupApiClient } from '@bu/wallets/wallet-setup';
import { isAddress, stringToHex } from 'viem';

import type { LedgerSignerPhase } from './ledger-signer-phase';

export type LedgerEip1193Provider = {
  request(args: { method: string; params?: readonly unknown[] | object }): Promise<unknown>;
  isLedgerButton?: boolean;
  isLedgerLive?: boolean;
};

export type LedgerProviderDetail = {
  info: { uuid: string; name: string; icon: string; rdns: string };
  provider: LedgerEip1193Provider;
};

let initialization: Promise<void> | null = null;

export function isLedgerProviderDetail(detail: unknown): detail is LedgerProviderDetail {
  if (!detail || typeof detail !== 'object') return false;
  const candidate = detail as Partial<LedgerProviderDetail>;
  if (!candidate.provider || !candidate.info) return false;
  return Boolean(
    candidate.provider.isLedgerButton ||
      candidate.provider.isLedgerLive ||
      /ledger/i.test(`${candidate.info.name} ${candidate.info.rdns}`)
  );
}

/** Initialize Ledger's official browser provider once. Ledger Wallet/Discover
 * can also inject an EIP-6963 provider, so missing partner config is not fatal. */
export function initializeLedgerProvider(): Promise<void> {
  if (initialization) return initialization;

  initialization = (async () => {
    if (typeof window === 'undefined') return;
    const apiKey = process.env.NEXT_PUBLIC_LEDGER_WALLET_PROVIDER_API_KEY;
    const dAppIdentifier = process.env.NEXT_PUBLIC_LEDGER_WALLET_PROVIDER_DAPP_ID;
    // Without BUFI's own Ledger partner credentials the SDK runs on its stub
    // dApp config, which is Ledger's 1inch fixture (`appDependencies: 1inch +
    // Ethereum`) — that is why the device asks to open the 1inch app in dev.
    // The stub flag is boolean-only (core `diTypes.d.ts`), so this cannot be
    // customised; it goes away the day the two env vars above are set.
    const useDevelopmentConfig =
      process.env.NODE_ENV !== 'production' && (!apiKey || !dAppIdentifier);
    if (!useDevelopmentConfig && (!apiKey || !dAppIdentifier)) return;
    const { initializeLedgerProvider: initialize } = await import(
      '@ledgerhq/ledger-wallet-provider'
    );
    initialize({
      ...(apiKey ? { apiKey } : {}),
      dAppIdentifier: dAppIdentifier || '1inch',
      ...(useDevelopmentConfig ? { devConfig: { stub: { dAppConfig: true } } } : {}),
      hideButton: true,
      loggerLevel: 'error',
    });
  })();

  return initialization;
}

function accountsFrom(result: unknown): `0x${string}`[] {
  const values = Array.isArray(result)
    ? result
    : result &&
        typeof result === 'object' &&
        Array.isArray((result as { accounts?: unknown }).accounts)
      ? (result as { accounts: unknown[] }).accounts
      : [];
  return values
    .filter((value): value is string => typeof value === 'string' && isAddress(value))
    .map(value => value as `0x${string}`);
}

export async function connectLedgerProvider(timeoutMs = 8_000): Promise<
  LedgerProviderDetail & {
    address: `0x${string}`;
  }
> {
  if (typeof window === 'undefined')
    throw new Error('Ledger setup is only available in a browser.');

  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (detail?: LedgerProviderDetail, error?: Error) => {
      window.removeEventListener('eip6963:announceProvider', onAnnounce as EventListener);
      if (timer) clearTimeout(timer);
      if (error) {
        reject(error);
        return;
      }
      if (detail) {
        void detail.provider
          .request({ method: 'eth_requestAccounts', params: [] })
          .then(result => {
            const address = accountsFrom(result)[0];
            if (!address) throw new Error('Ledger did not return an Ethereum account.');
            resolve({ ...detail, address });
          })
          .catch(reject);
      }
    };
    const onAnnounce = (event: CustomEvent<LedgerProviderDetail>) => {
      if (isLedgerProviderDetail(event.detail)) finish(event.detail);
    };

    window.addEventListener('eip6963:announceProvider', onAnnounce as EventListener);
    void initializeLedgerProvider()
      .then(() => {
        window.dispatchEvent(new Event('eip6963:requestProvider'));
        timer = setTimeout(
          () =>
            finish(
              undefined,
              new Error(
                'Ledger is unavailable. Open this page in Ledger Wallet, or use desktop Chrome after BUFI Ledger access is configured.'
              )
            ),
          timeoutMs
        );
      })
      .catch(error => finish(undefined, error instanceof Error ? error : new Error(String(error))));
  });
}

export async function signLedgerProof(
  provider: LedgerEip1193Provider,
  address: `0x${string}`,
  message: string
): Promise<`0x${string}`> {
  const signature = await provider.request({
    method: 'personal_sign',
    params: [stringToHex(message), address],
  });
  if (typeof signature !== 'string' || !/^0x[0-9a-f]+$/i.test(signature)) {
    throw new Error('Ledger returned an invalid signature.');
  }
  return signature as `0x${string}`;
}

export async function registerTreasuryLedgerSigner(
  apiClient: WalletSetupApiClient,
  options?: {
    inviteCode?: string;
    /** Fires as the flow advances so a button can say what it is waiting on.
     * `registering` is the long phase — the server adds the owner on every
     * configured treasury chain, one userOp at a time (~50s for seven). */
    onPhase?: (phase: LedgerSignerPhase) => void;
  }
) {
  if (!apiClient.requestSignerChallenge || !apiClient.registerTeamSigner) {
    throw new Error('Treasury signer registration is unavailable.');
  }

  options?.onPhase?.('connecting');
  const ledger = await connectLedgerProvider();
  const challenge = await apiClient.requestSignerChallenge();
  if (!challenge.ledgerMessage) throw new Error('Could not prepare Ledger verification.');

  options?.onPhase?.('signing');
  const signature = await signLedgerProof(ledger.provider, ledger.address, challenge.ledgerMessage);
  options?.onPhase?.('registering');
  return apiClient.registerTeamSigner({
    type: 'ledger',
    ownerAddress: ledger.address,
    signature,
    providerName: ledger.info.name,
    providerRdns: ledger.info.rdns,
    ...(options?.inviteCode ? { inviteCode: options.inviteCode } : {}),
  });
}
