import {
  buildContractLifecycleEvidenceCommitments,
  buildPayrollEvidenceCommitments,
  buildProjectEvidenceCommitments,
  buildReimbursementEvidenceCommitments,
  buildReportEvidenceCommitments,
  createCreEvidenceToken,
  openCreEvidenceToken,
  parseCreEvidenceCommitments,
  stableStringify,
} from './evidence';
import { describe, expect, test } from 'bun:test';

const seal = (plaintext: string) =>
  Buffer.from([...plaintext].reverse().join(''), 'utf8').toString('base64');
const unseal = (ciphertext: string) =>
  [...Buffer.from(ciphertext, 'base64').toString('utf8')].reverse().join('');

describe('CRE evidence references', () => {
  test('seal only short-lived opaque references and enforce expiry', () => {
    const now = new Date('2026-07-18T20:00:00.000Z');
    const token = createCreEvidenceToken(
      { kind: 'payroll', entityId: 'payroll-private', teamId: 'team-private' },
      seal,
      { now, nonce: 'nonce-1', ttlSeconds: 60 }
    );

    expect(token).toStartWith('bufi_cre_evidence_v1.');
    expect(token).not.toContain('payroll-private');
    expect(token).not.toContain('team-private');
    expect(openCreEvidenceToken(token, unseal, new Date('2026-07-18T20:00:30.000Z'))).toMatchObject(
      {
        kind: 'payroll',
        entityId: 'payroll-private',
        teamId: 'team-private',
        nonce: 'nonce-1',
      }
    );
    expect(() => openCreEvidenceToken(token, unseal, new Date('2026-07-18T20:01:01.000Z'))).toThrow(
      'expired'
    );
  });

  test('rejects plaintext, oversized, and wrong-audience references', () => {
    expect(() => openCreEvidenceToken('payroll-private', unseal)).toThrow('invalid');
    const token = createCreEvidenceToken(
      { kind: 'report', entityId: 'report-1', teamId: 'team-1' },
      plaintext => seal(plaintext.replace('bufi-cre-evidence', 'some-other-audience')),
      { nonce: 'nonce-2' }
    );
    expect(() => openCreEvidenceToken(token, unseal)).toThrow('invalid');
  });
});

describe('CRE commitment envelopes', () => {
  test('canonical JSON is stable across key order', () => {
    expect(stableStringify({ z: 2, a: { d: 4, c: 3 } })).toBe(
      stableStringify({ a: { c: 3, d: 4 }, z: 2 })
    );
  });

  test('payroll commitments never contain recipients or money', () => {
    const evidence = buildPayrollEvidenceCommitments({
      payrollId: 'payroll-1',
      teamId: 'team-1',
      status: 'executed',
      payPeriodStart: '2026-07-01',
      payPeriodEnd: '2026-07-15',
      totalAmountUsdc: 1250,
      totalAmountEurc: 0,
      recipientCount: 1,
      recipients: { usdc: [{ amount: '1250', walletAddress: '0xprivate' }] },
      executedAt: '2026-07-16T00:00:00.000Z',
    });

    expect(parseCreEvidenceCommitments({ success: true, evidence })).toEqual(evidence);
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain('1250');
    expect(serialized).not.toContain('0xprivate');
    expect(serialized).not.toContain('payroll-1');
  });

  test('contract lifecycle commitments hide agreement, parties, and amounts', () => {
    const evidence = buildContractLifecycleEvidenceCommitments(
      {
        agreementId: 'agreement-private',
        teamId: 'team-private',
        status: 'active',
        agreementHash: 'agreement-hash-private',
        chainId: 11155111,
        totalAmount: '25000',
        fundedAmount: '25000',
        fundedAt: '2026-07-18T20:00:00.000Z',
        escrowAddress: '0xparty-private',
        updatedAt: '2026-07-18T20:01:00.000Z',
        agreement: {
          payer: 'alice-private',
          payee: 'bob-private',
          milestones: [{ amount: 25000, evidence: 'secret-deliverable' }],
        },
      },
      'contract_fund'
    );

    expect(parseCreEvidenceCommitments({ success: true, evidence })).toEqual(evidence);
    const serialized = JSON.stringify(evidence);
    for (const secret of [
      'agreement-private',
      'team-private',
      'agreement-hash-private',
      '25000',
      '0xparty-private',
      'alice-private',
      'bob-private',
      'secret-deliverable',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  test('contract lifecycle commitments fail closed when the event state is not ready', () => {
    const record = {
      agreementId: 'agreement-1',
      teamId: 'team-1',
      status: 'active',
      agreementHash: null,
      chainId: 11155111,
      totalAmount: '10',
      fundedAmount: '0',
      fundedAt: null,
      escrowAddress: null,
      updatedAt: '2026-07-18T20:01:00.000Z',
      agreement: { version: 1 },
    };
    expect(() => buildContractLifecycleEvidenceCommitments(record, 'contract_fund')).toThrow(
      'not ready'
    );
    expect(() => buildContractLifecycleEvidenceCommitments(record, 'contract_complete')).toThrow(
      'not ready'
    );
  });

  test('report commitments are deterministic across source object order', () => {
    const base = {
      reportId: 'report-1',
      teamId: 'team-1',
      reportNumber: 'R-001',
      status: 'completed',
      fromDate: '2026-07-01',
      toDate: '2026-07-15',
      createdAt: '2026-07-16T00:00:00.000Z',
      aiAnalysis: { finding: 'stable' },
    };
    const first = buildReportEvidenceCommitments({
      ...base,
      transactionsData: { b: 2, a: 1 },
      financialMetrics: { runway: 9, cash: 4 },
    });
    const second = buildReportEvidenceCommitments({
      ...base,
      transactionsData: { a: 1, b: 2 },
      financialMetrics: { cash: 4, runway: 9 },
    });
    expect(first).toEqual(second);
  });

  test('project commitments round-trip and never leak ids or item content', () => {
    const evidence = buildProjectEvidenceCommitments(
      {
        projectId: 'project-private',
        teamId: 'team-private',
        status: 'active',
        closedAt: null,
      },
      {
        phase: 'paid',
        itemCount: 3,
        itemsHash: 'b'.repeat(64),
        settledTotal: 125.5,
        settlementCount: 2,
      }
    );

    expect(evidence.kind).toBe('project');
    expect(evidence.phase).toBe('paid');
    expect(evidence.entityCommitment).toMatch(/^0x[0-9a-f]{64}$/);
    expect(evidence.projectCommitment).toMatch(/^0x[0-9a-f]{64}$/);
    expect(evidence.settlementCommitment).toMatch(/^0x[0-9a-f]{64}$/);
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain('project-private');
    expect(serialized).not.toContain('team-private');
    expect(serialized).not.toContain('125.5');
    // The strict parser accepts exactly what the builder emits (Shiva → DON).
    expect(parseCreEvidenceCommitments({ success: true, evidence })).toEqual(evidence);
  });

  test('project paid/closed evidence fails closed without settlement or close facts', () => {
    const record = {
      projectId: 'project-1',
      teamId: 'team-1',
      status: 'active',
      closedAt: null,
    };
    // paid without confirmed settlement facts
    expect(() =>
      buildProjectEvidenceCommitments(record, {
        phase: 'paid',
        itemCount: 1,
        itemsHash: 'c'.repeat(64),
        settledTotal: null,
        settlementCount: 0,
      })
    ).toThrow('settlement evidence');
    // closed without a closedAt stamp
    expect(() =>
      buildProjectEvidenceCommitments(record, {
        phase: 'closed',
        itemCount: 1,
        itemsHash: 'c'.repeat(64),
        settledTotal: 10,
        settlementCount: 1,
      })
    ).toThrow('closedAt');
    // sealed project reference round-trips with its phase intact
    const token = createCreEvidenceToken(
      { kind: 'project', entityId: 'project-1', teamId: 'team-1', phase: 'closed' },
      seal,
      { nonce: 'nonce-project' }
    );
    const claims = openCreEvidenceToken(token, unseal);
    expect(claims.kind).toBe('project');
    if (claims.kind === 'project') expect(claims.phase).toBe('closed');
  });

  test('reimbursement paid evidence fails closed without confirmed settlement facts', () => {
    expect(() =>
      buildReimbursementEvidenceCommitments(
        {
          requestId: 'request-1',
          teamId: 'team-1',
          status: 'paid',
          currency: 'USDC',
          subtotal: 10,
          markupPercent: null,
          markupAmount: 0,
          total: 10,
          sentAt: '2026-07-16T00:00:00.000Z',
          paidAt: '2026-07-17T00:00:00.000Z',
          paidTxHash: '0xabc',
        },
        {
          phase: 'paid',
          itemCount: 1,
          itemsHash: 'a'.repeat(64),
          settledTotal: null,
          settlementCount: 0,
        }
      )
    ).toThrow('settlement evidence');
  });
});
