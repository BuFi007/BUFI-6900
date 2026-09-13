import {
  configureCREClient,
  resetCREClientForTests,
  triggerBalanceAttestation,
  triggerFeeReconciliation,
  triggerPayrollAttestation,
  triggerRampVerification,
  triggerReportAttestation,
  triggerTransferVerification,
} from './client';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

const BASE_URL = 'https://cre.example.com';

// Hold the original fetch so we can restore it after each test
const originalFetch = globalThis.fetch;

describe('CRE Trigger Client', () => {
  let mockFetch: ReturnType<typeof mock>;

  beforeEach(() => {
    mockFetch = mock(() => Promise.resolve(new Response('ok', { status: 200 })));
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    // Reset client config for every test by re-configuring
    configureCREClient({ baseUrl: BASE_URL });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // --------------------------------------------------------------------------
  // 1. configureCREClient sets the client config
  // --------------------------------------------------------------------------
  test('configureCREClient sets the client config', async () => {
    configureCREClient({ baseUrl: 'https://other.example.com' });
    await triggerTransferVerification({
      transferId: 't1',
      txHash: '0xabc',
      chainId: 1,
      amount: '100',
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const calledUrl = mockFetch.mock.calls[0]![0] as string;
    expect(calledUrl).toStartWith('https://other.example.com/');
  });

  // --------------------------------------------------------------------------
  // 2. Throws when not configured
  // --------------------------------------------------------------------------
  test('triggerCREWorkflow throws when not configured', async () => {
    // Explicit test-only singleton reset. (The previous approach — a query-string
    // cache-bust dynamic re-import — hangs on bun 1.1.x, the CI runtime, and only
    // worked on newer local bun versions.)
    resetCREClientForTests();
    await expect(
      triggerTransferVerification({
        transferId: 't1',
        txHash: '0xabc',
        chainId: 1,
        amount: '100',
      })
    ).rejects.toThrow('CRE client not configured');
  });

  // --------------------------------------------------------------------------
  // 3. triggerTransferVerification — correct URL and body
  // --------------------------------------------------------------------------
  test('triggerTransferVerification calls correct endpoint with JSON body', async () => {
    const payload = {
      transferId: 't1',
      txHash: '0xabc',
      chainId: 1,
      amount: '100',
    };

    const result = await triggerTransferVerification(payload);

    expect(result).toEqual({ success: true });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe(`${BASE_URL}/workflow-transfer-verify`);
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual(payload);
  });

  // --------------------------------------------------------------------------
  // 4. triggerBalanceAttestation — correct endpoint
  // --------------------------------------------------------------------------
  test('triggerBalanceAttestation calls correct endpoint', async () => {
    await triggerBalanceAttestation({
      teamId: 'team1',
      walletAddresses: ['0x1', '0x2'],
      chainIds: [1, 137],
    });

    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toBe(`${BASE_URL}/workflow-balance-attestation`);
  });

  // --------------------------------------------------------------------------
  // 6. triggerPayrollAttestation — correct endpoint
  // --------------------------------------------------------------------------
  test('triggerPayrollAttestation calls correct endpoint', async () => {
    await triggerPayrollAttestation({
      evidenceToken: 'opaque-payroll-evidence',
    });

    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toBe(`${BASE_URL}/workflow-payroll-attest`);
  });

  // --------------------------------------------------------------------------
  // 7. triggerReportAttestation — correct endpoint
  // --------------------------------------------------------------------------
  test('triggerReportAttestation calls correct endpoint', async () => {
    await triggerReportAttestation({
      evidenceToken: 'opaque-report-evidence',
    });

    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toBe(`${BASE_URL}/workflow-report-verify`);
  });

  // --------------------------------------------------------------------------
  // 8. triggerFeeReconciliation — correct endpoint
  // --------------------------------------------------------------------------
  test('triggerFeeReconciliation calls correct endpoint', async () => {
    await triggerFeeReconciliation({
      periodStart: '2026-01-01',
      periodEnd: '2026-01-31',
      feeRecipientAddresses: ['0xfee'],
    });

    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toBe(`${BASE_URL}/workflow-fee-reconciliation`);
  });

  // --------------------------------------------------------------------------
  // 9. triggerRampVerification — correct endpoint
  // --------------------------------------------------------------------------
  test('triggerRampVerification calls correct endpoint', async () => {
    await triggerRampVerification({
      rampId: 'ramp1',
      rampType: 'onramp',
      expectedAmount: '1000',
      depositAddress: '0xdep',
    });

    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toBe(`${BASE_URL}/workflow-ramp-verify`);
  });

  // --------------------------------------------------------------------------
  // 10. Handles fetch failure (network error)
  // --------------------------------------------------------------------------
  test('handles fetch failure with success: false', async () => {
    mockFetch = mock(() => Promise.reject(new Error('Network down')));
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const result = await triggerTransferVerification({
      transferId: 't1',
      txHash: '0xabc',
      chainId: 1,
      amount: '100',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Network down');
    expect(result.error).toContain('workflow-transfer-verify');
  });

  // --------------------------------------------------------------------------
  // 11. Handles non-ok response (e.g. 500)
  // --------------------------------------------------------------------------
  test('handles non-ok response with success: false', async () => {
    mockFetch = mock(() =>
      Promise.resolve(
        new Response('Internal Server Error', {
          status: 500,
          statusText: 'Internal Server Error',
        })
      )
    );
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const result = await triggerBalanceAttestation({
      teamId: 'team1',
      walletAddresses: ['0x1'],
      chainIds: [1],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('500');
    expect(result.error).toContain('workflow-balance-attestation');
  });

  // --------------------------------------------------------------------------
  // 12. Sends auth token when configured
  // --------------------------------------------------------------------------
  test('sends Authorization header when authToken is configured', async () => {
    configureCREClient({ baseUrl: BASE_URL, authToken: 'secret-token-123' });

    await triggerTransferVerification({
      transferId: 't1',
      txHash: '0xabc',
      chainId: 1,
      amount: '100',
    });

    const [, init] = mockFetch.mock.calls[0]!;
    expect(init.headers.Authorization).toBe('Bearer secret-token-123');
  });

  test('omits Authorization header when authToken is not set', async () => {
    configureCREClient({ baseUrl: BASE_URL });

    await triggerTransferVerification({
      transferId: 't1',
      txHash: '0xabc',
      chainId: 1,
      amount: '100',
    });

    const [, init] = mockFetch.mock.calls[0]!;
    expect(init.headers.Authorization).toBeUndefined();
  });
});
