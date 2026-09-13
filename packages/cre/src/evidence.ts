import { isHex, keccak256, toHex } from 'viem';

const TOKEN_PREFIX = 'bufi_cre_evidence_v1.';
const TOKEN_AUDIENCE = 'bufi-cre-evidence';
const MAX_TOKEN_LENGTH = 8_192;
const MAX_REFERENCE_LENGTH = 256;
const MAX_TTL_SECONDS = 15 * 60;
const CLOCK_SKEW_SECONDS = 30;
const SHA256_HEX = /^[0-9a-f]{64}$/u;

export type ContractLifecycleEvidenceEvent =
  | 'contract_deploy'
  | 'contract_sign'
  | 'contract_fund'
  | 'contract_complete'
  | 'contract_cancel';

export type CreEvidenceKind =
  | 'contract'
  | 'payroll'
  | 'reimbursement'
  | 'report'
  | 'project'
  | 'payment-score';

/**
 * Project-as-container attestation phases. A living payable project anchors:
 * `sent` when the payer link is shared, `paid` each time a per-item settlement
 * lands (binds the cumulative confirmed settlement), and `closed` on the
 * two-party close (binds the final settled state).
 */
export type ProjectEvidencePhase = 'sent' | 'paid' | 'closed';

export type CreEvidenceReference =
  | { kind: 'payment-score'; entityId: string; teamId: string }
  | {
      kind: 'contract';
      entityId: string;
      teamId: string;
      event: ContractLifecycleEvidenceEvent;
    }
  | {
      kind: 'payroll';
      entityId: string;
      teamId: string;
      batchId?: string;
    }
  | {
      kind: 'reimbursement';
      entityId: string;
      teamId: string;
      phase: 'sent' | 'paid';
    }
  | {
      kind: 'report';
      entityId: string;
      teamId: string;
    }
  | {
      kind: 'project';
      entityId: string;
      teamId: string;
      phase: ProjectEvidencePhase;
    };

export type CreEvidenceClaims = CreEvidenceReference & {
  audience: typeof TOKEN_AUDIENCE;
  expiresAt: number;
  issuedAt: number;
  nonce: string;
  version: 1;
};

export interface CreEvidenceTokenOptions {
  now?: Date;
  nonce?: string;
  ttlSeconds?: number;
}

export type CreEvidenceCommitments =
  | {
      kind: 'contract';
      event: ContractLifecycleEvidenceEvent;
      entityCommitment: `0x${string}`;
      agreementCommitment: `0x${string}`;
      stateCommitment: `0x${string}`;
      snapshotCommitment: `0x${string}`;
    }
  | {
      kind: 'payroll';
      entityCommitment: `0x${string}`;
      recordCommitment: `0x${string}`;
      recipientCommitment: `0x${string}`;
      batchCommitment: `0x${string}`;
    }
  | {
      kind: 'reimbursement';
      phase: 'sent' | 'paid';
      entityCommitment: `0x${string}`;
      requestCommitment: `0x${string}`;
      itemsHash: string;
      settlementCommitment: `0x${string}`;
    }
  | {
      kind: 'report';
      entityCommitment: `0x${string}`;
      reportCommitment: `0x${string}`;
      transactionsHash: `0x${string}`;
      metricsHash: `0x${string}`;
      analysisHash: `0x${string}`;
      combinedHash: `0x${string}`;
    }
  | {
      kind: 'project';
      phase: ProjectEvidencePhase;
      entityCommitment: `0x${string}`;
      projectCommitment: `0x${string}`;
      itemsHash: string;
      settlementCommitment: `0x${string}`;
    };

export interface PayrollEvidenceRecord {
  payrollId: string;
  teamId: string;
  status: string;
  payPeriodStart: string;
  payPeriodEnd: string;
  totalAmountUsdc: string | number;
  totalAmountEurc: string | number;
  recipientCount: number;
  recipients: unknown;
  executedAt: string | null;
}

export interface ContractLifecycleEvidenceRecord {
  agreementId: string;
  teamId: string;
  status: string;
  agreementHash: string | null;
  chainId: number | null;
  totalAmount: string | number;
  fundedAmount: string | number;
  fundedAt: string | null;
  escrowAddress: string | null;
  updatedAt: string;
  agreement: unknown;
}

export interface ReportEvidenceRecord {
  reportId: string;
  teamId: string;
  reportNumber: string;
  status: string;
  fromDate: string;
  toDate: string;
  createdAt: string;
  transactionsData: unknown;
  financialMetrics: unknown;
  aiAnalysis: unknown;
}

export interface ReimbursementEvidenceRecord {
  requestId: string;
  teamId: string;
  status: string;
  currency: string;
  subtotal: string | number;
  markupPercent: string | number | null;
  markupAmount: string | number;
  total: string | number;
  sentAt: string | null;
  paidAt: string | null;
  paidTxHash: string | null;
}

export interface ReimbursementEvidenceFacts {
  phase: 'sent' | 'paid';
  itemCount: number;
  itemsHash: string;
  settledTotal?: string | number | null;
  settlementCount?: number | null;
}

export interface ProjectEvidenceRecord {
  projectId: string;
  teamId: string;
  status: string;
  closedAt: string | null;
}

export interface ProjectEvidenceFacts {
  phase: ProjectEvidencePhase;
  itemCount: number;
  itemsHash: string;
  settledTotal?: string | number | null;
  settlementCount?: number | null;
}

function requiredReference(value: unknown, field: string): string {
  const hasControlCharacter =
    typeof value === 'string' &&
    [...value].some(character => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    });
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_REFERENCE_LENGTH ||
    hasControlCharacter
  ) {
    throw new Error(`CRE evidence ${field} is invalid`);
  }
  return value;
}

function requiredInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`CRE evidence ${field} must be an integer`);
  return Number(value);
}

export function canonicalDecimal(value: string | number): string {
  const raw = String(value);
  if (!/^\d+(?:\.\d+)?$/u.test(raw)) throw new Error('CRE evidence decimal is invalid');
  const [integer = '0', fraction = ''] = raw.split('.');
  const normalizedInteger = integer.replace(/^0+(?=\d)/u, '') || '0';
  const normalizedFraction = fraction.replace(/0+$/u, '');
  return normalizedFraction ? `${normalizedInteger}.${normalizedFraction}` : normalizedInteger;
}

/** Deterministic JSON used for cross-runtime commitments. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('CRE evidence contains a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map(key => {
        if (record[key] === undefined) throw new Error('CRE evidence contains undefined');
        return `${JSON.stringify(key)}:${stableStringify(record[key])}`;
      });
    return `{${entries.join(',')}}`;
  }
  throw new Error('CRE evidence contains an unsupported value');
}

function commitment(value: unknown): `0x${string}` {
  return keccak256(toHex(stableStringify(value)));
}

function requiredContractEvent(value: unknown): ContractLifecycleEvidenceEvent {
  switch (value) {
    case 'contract_deploy':
    case 'contract_sign':
    case 'contract_fund':
    case 'contract_complete':
    case 'contract_cancel':
      return value;
    default:
      throw new Error('CRE evidence contract event is invalid');
  }
}

function validateReference(reference: CreEvidenceReference): CreEvidenceReference {
  const entityId = requiredReference(reference.entityId, 'entityId');
  const teamId = requiredReference(reference.teamId, 'teamId');
  switch (reference.kind) {
    case 'payment-score':
      if (
        entityId !== teamId ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(teamId)
      ) {
        throw new Error('CRE payment score workspace is invalid');
      }
      return { kind: 'payment-score', entityId, teamId };
    case 'contract':
      return {
        kind: 'contract',
        entityId,
        teamId,
        event: requiredContractEvent(reference.event),
      };
    case 'payroll':
      return {
        kind: 'payroll',
        entityId,
        teamId,
        ...(reference.batchId ? { batchId: requiredReference(reference.batchId, 'batchId') } : {}),
      };
    case 'reimbursement':
      if (reference.phase !== 'sent' && reference.phase !== 'paid') {
        throw new Error('CRE evidence reimbursement phase is invalid');
      }
      return { kind: 'reimbursement', entityId, teamId, phase: reference.phase };
    case 'report':
      return { kind: 'report', entityId, teamId };
    case 'project':
      if (
        reference.phase !== 'sent' &&
        reference.phase !== 'paid' &&
        reference.phase !== 'closed'
      ) {
        throw new Error('CRE evidence project phase is invalid');
      }
      return { kind: 'project', entityId, teamId, phase: reference.phase };
  }
}

/**
 * Produces a commitment-only snapshot of Shiva's authoritative contract row.
 * CRE attests that snapshot; it never receives agreement content, party
 * addresses, milestone amounts, signatures, or cancellation evidence.
 */
export function buildContractLifecycleEvidenceCommitments(
  record: ContractLifecycleEvidenceRecord,
  event: ContractLifecycleEvidenceEvent
): Extract<CreEvidenceCommitments, { kind: 'contract' }> {
  const agreementId = requiredReference(record.agreementId, 'agreementId');
  const teamId = requiredReference(record.teamId, 'teamId');
  const normalizedEvent = requiredContractEvent(event);
  const status = requiredReference(record.status, 'contract status');
  const updatedAt = requiredReference(record.updatedAt, 'contract updatedAt');
  if (!record.agreement || typeof record.agreement !== 'object') {
    throw new Error('Contract lifecycle agreement evidence is invalid');
  }
  if (record.chainId !== null && (!Number.isSafeInteger(record.chainId) || record.chainId < 1)) {
    throw new Error('Contract lifecycle chainId is invalid');
  }

  const fundedAmount = canonicalDecimal(record.fundedAmount);
  const totalAmount = canonicalDecimal(record.totalAmount);
  if (normalizedEvent === 'contract_fund' && (!record.fundedAt || fundedAmount === '0')) {
    throw new Error('Contract lifecycle funding evidence is not ready');
  }
  if (
    normalizedEvent === 'contract_sign' &&
    status !== 'pending_sign' &&
    status !== 'active' &&
    status !== 'completed'
  ) {
    throw new Error('Contract lifecycle signing evidence is not ready');
  }
  if (normalizedEvent === 'contract_complete' && status !== 'completed') {
    throw new Error('Contract lifecycle completion evidence is not ready');
  }
  if (normalizedEvent === 'contract_cancel' && status !== 'cancelled' && status !== 'canceled') {
    throw new Error('Contract lifecycle cancellation evidence is not ready');
  }
  if (
    normalizedEvent === 'contract_deploy' &&
    !record.escrowAddress &&
    status !== 'deploying' &&
    status !== 'active' &&
    status !== 'completed'
  ) {
    throw new Error('Contract lifecycle deployment evidence is not ready');
  }

  const agreementCommitment = commitment(record.agreement);
  const stateCommitment = commitment({
    agreementHash: record.agreementHash,
    chainId: record.chainId,
    escrowConfigured: Boolean(record.escrowAddress),
    fundedAmount,
    fundedAt: record.fundedAt,
    status,
    totalAmount,
    updatedAt,
  });
  return {
    kind: 'contract',
    event: normalizedEvent,
    entityCommitment: keccak256(toHex(`contract:${agreementId}`)),
    agreementCommitment,
    stateCommitment,
    snapshotCommitment: commitment({
      agreementCommitment,
      event: normalizedEvent,
      stateCommitment,
      teamCommitment: keccak256(toHex(`team:${teamId}`)),
    }),
  };
}

/**
 * Seals a short-lived reference. The caller supplies the authenticated
 * encryption primitive; no plaintext workspace record belongs in this token.
 */
export function createCreEvidenceToken(
  reference: CreEvidenceReference,
  seal: (plaintext: string) => string,
  options: CreEvidenceTokenOptions = {}
): string {
  const normalized = validateReference(reference);
  const issuedAt = Math.floor((options.now ?? new Date()).getTime() / 1_000);
  const ttlSeconds = options.ttlSeconds ?? 5 * 60;
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_TTL_SECONDS) {
    throw new Error('CRE evidence token TTL is invalid');
  }
  const nonce = requiredReference(options.nonce ?? crypto.randomUUID(), 'nonce');
  const claims: CreEvidenceClaims = {
    ...normalized,
    audience: TOKEN_AUDIENCE,
    expiresAt: issuedAt + ttlSeconds,
    issuedAt,
    nonce,
    version: 1,
  };
  const token = `${TOKEN_PREFIX}${seal(stableStringify(claims))}`;
  if (token.length > MAX_TOKEN_LENGTH) throw new Error('CRE evidence token is too large');
  return token;
}

export function openCreEvidenceToken(
  token: string,
  unseal: (ciphertext: string) => string,
  now = new Date()
): CreEvidenceClaims {
  if (
    typeof token !== 'string' ||
    !token.startsWith(TOKEN_PREFIX) ||
    token.length <= TOKEN_PREFIX.length ||
    token.length > MAX_TOKEN_LENGTH
  ) {
    throw new Error('CRE evidence token is invalid');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(unseal(token.slice(TOKEN_PREFIX.length)));
  } catch {
    throw new Error('CRE evidence token is invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('CRE evidence token is invalid');
  }
  const claims = parsed as Partial<CreEvidenceClaims>;
  if (claims.version !== 1 || claims.audience !== TOKEN_AUDIENCE) {
    throw new Error('CRE evidence token is invalid');
  }
  const issuedAt = requiredInteger(claims.issuedAt, 'issuedAt');
  const expiresAt = requiredInteger(claims.expiresAt, 'expiresAt');
  const current = Math.floor(now.getTime() / 1_000);
  if (issuedAt > current + CLOCK_SKEW_SECONDS || expiresAt <= current) {
    throw new Error('CRE evidence token is expired');
  }
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_TTL_SECONDS) {
    throw new Error('CRE evidence token lifetime is invalid');
  }
  const nonce = requiredReference(claims.nonce, 'nonce');
  const reference = validateReference(claims as CreEvidenceReference);
  return { ...reference, audience: TOKEN_AUDIENCE, expiresAt, issuedAt, nonce, version: 1 };
}

export function buildPayrollEvidenceCommitments(
  record: PayrollEvidenceRecord,
  batchId?: string
): Extract<CreEvidenceCommitments, { kind: 'payroll' }> {
  const payrollId = requiredReference(record.payrollId, 'payrollId');
  const teamId = requiredReference(record.teamId, 'teamId');
  if (record.status !== 'executed' || !record.executedAt) {
    throw new Error('Payroll evidence is not executed');
  }
  if (!Number.isSafeInteger(record.recipientCount) || record.recipientCount < 1) {
    throw new Error('Payroll evidence recipient count is invalid');
  }
  if (!record.recipients || typeof record.recipients !== 'object') {
    throw new Error('Payroll evidence recipients are invalid');
  }
  let countedRecipients = 0;
  for (const group of Object.values(record.recipients as Record<string, unknown>)) {
    if (!Array.isArray(group)) throw new Error('Payroll evidence recipient group is invalid');
    for (const recipient of group) {
      if (!recipient || typeof recipient !== 'object' || Array.isArray(recipient)) {
        throw new Error('Payroll evidence recipient is invalid');
      }
      const candidate = recipient as Record<string, unknown>;
      canonicalDecimal(candidate.amount as string | number);
      requiredReference(candidate.walletAddress, 'recipient wallet');
      countedRecipients += 1;
    }
  }
  if (countedRecipients !== record.recipientCount) {
    throw new Error('Payroll evidence recipient count does not match recipients');
  }
  const recordCommitment = commitment({
    payrollId,
    teamId,
    payPeriodStart: requiredReference(record.payPeriodStart, 'payPeriodStart'),
    payPeriodEnd: requiredReference(record.payPeriodEnd, 'payPeriodEnd'),
    totalAmountUsdc: canonicalDecimal(record.totalAmountUsdc),
    totalAmountEurc: canonicalDecimal(record.totalAmountEurc),
    recipientCount: record.recipientCount,
    executedAt: requiredReference(record.executedAt, 'executedAt'),
  });
  return {
    kind: 'payroll',
    entityCommitment: keccak256(toHex(`payroll:${payrollId}`)),
    recordCommitment,
    recipientCommitment: commitment(record.recipients),
    batchCommitment: batchId
      ? keccak256(toHex(`payroll-batch:${requiredReference(batchId, 'batchId')}`))
      : keccak256(toHex(`payroll-record:${recordCommitment}`)),
  };
}

export function buildReportEvidenceCommitments(
  record: ReportEvidenceRecord
): Extract<CreEvidenceCommitments, { kind: 'report' }> {
  const reportId = requiredReference(record.reportId, 'reportId');
  const teamId = requiredReference(record.teamId, 'teamId');
  if (record.status !== 'completed') throw new Error('Report evidence is not completed');
  if (
    record.transactionsData === null ||
    record.transactionsData === undefined ||
    record.financialMetrics === null ||
    record.financialMetrics === undefined ||
    record.aiAnalysis === null ||
    record.aiAnalysis === undefined
  ) {
    throw new Error('Report evidence sources are incomplete');
  }
  const transactionsHash = commitment(record.transactionsData);
  const metricsHash = commitment(record.financialMetrics);
  const analysisHash = commitment(record.aiAnalysis);
  const combinedHash = commitment({ analysisHash, metricsHash, transactionsHash });
  return {
    kind: 'report',
    entityCommitment: keccak256(toHex(`financial-report:${reportId}`)),
    reportCommitment: commitment({
      reportId,
      teamId,
      reportNumber: requiredReference(record.reportNumber, 'reportNumber'),
      fromDate: requiredReference(record.fromDate, 'fromDate'),
      toDate: requiredReference(record.toDate, 'toDate'),
      createdAt: requiredReference(record.createdAt, 'createdAt'),
      combinedHash,
    }),
    transactionsHash,
    metricsHash,
    analysisHash,
    combinedHash,
  };
}

export function buildReimbursementEvidenceCommitments(
  record: ReimbursementEvidenceRecord,
  facts: ReimbursementEvidenceFacts
): Extract<CreEvidenceCommitments, { kind: 'reimbursement' }> {
  const requestId = requiredReference(record.requestId, 'requestId');
  const teamId = requiredReference(record.teamId, 'teamId');
  if (record.status === 'draft' || record.status === 'canceled') {
    throw new Error('Reimbursement evidence is not attestable');
  }
  if (facts.phase === 'paid' && record.status !== 'paid') {
    throw new Error('Reimbursement evidence is not paid');
  }
  if (
    !Number.isSafeInteger(facts.itemCount) ||
    facts.itemCount < 1 ||
    !SHA256_HEX.test(facts.itemsHash)
  ) {
    throw new Error('Reimbursement item evidence is invalid');
  }
  const requestCommitment = commitment({
    requestId,
    teamId,
    phase: facts.phase,
    itemCount: facts.itemCount,
    subtotal: canonicalDecimal(record.subtotal),
    markupPercent: record.markupPercent === null ? null : canonicalDecimal(record.markupPercent),
    markupAmount: canonicalDecimal(record.markupAmount),
    total: canonicalDecimal(record.total),
    itemsHash: facts.itemsHash,
    currency: requiredReference(record.currency, 'currency'),
    sentAt: record.sentAt,
  });
  let settlementCommitment: `0x${string}`;
  if (facts.phase === 'paid') {
    if (
      facts.settledTotal === null ||
      facts.settledTotal === undefined ||
      !Number.isSafeInteger(facts.settlementCount) ||
      Number(facts.settlementCount) < 1
    ) {
      throw new Error('Reimbursement settlement evidence is invalid');
    }
    settlementCommitment = commitment({
      settledTotal: canonicalDecimal(facts.settledTotal),
      settlementCount: facts.settlementCount,
      paidAt: record.paidAt,
      paidTxHash: record.paidTxHash,
    });
  } else {
    settlementCommitment = keccak256(toHex('reimbursement:settlement:not-paid'));
  }
  return {
    kind: 'reimbursement',
    phase: facts.phase,
    entityCommitment: keccak256(toHex(`reimbursement:${requestId}`)),
    requestCommitment,
    itemsHash: facts.itemsHash,
    settlementCommitment,
  };
}

/**
 * Commitment-only snapshot of a project-as-container. Binds the project
 * identity, the current expense-item set (itemsHash), and — for `paid`/`closed`
 * — the cumulative confirmed settlement. CRE never receives item descriptions,
 * vendor names, amounts, or settlement rows; only these commitments cross the
 * DON boundary.
 */
export function buildProjectEvidenceCommitments(
  record: ProjectEvidenceRecord,
  facts: ProjectEvidenceFacts
): Extract<CreEvidenceCommitments, { kind: 'project' }> {
  const projectId = requiredReference(record.projectId, 'projectId');
  const teamId = requiredReference(record.teamId, 'teamId');
  const status = requiredReference(record.status, 'project status');
  if (
    !Number.isSafeInteger(facts.itemCount) ||
    facts.itemCount < 1 ||
    !SHA256_HEX.test(facts.itemsHash)
  ) {
    throw new Error('Project item evidence is invalid');
  }
  const closedAt =
    facts.phase === 'closed' ? requiredReference(record.closedAt, 'closedAt') : record.closedAt;
  const projectCommitment = commitment({
    projectId,
    teamId,
    phase: facts.phase,
    status,
    itemCount: facts.itemCount,
    itemsHash: facts.itemsHash,
    closedAt,
  });
  let settlementCommitment: `0x${string}`;
  if (facts.phase === 'paid' || facts.phase === 'closed') {
    if (
      facts.settledTotal === null ||
      facts.settledTotal === undefined ||
      !Number.isSafeInteger(facts.settlementCount) ||
      Number(facts.settlementCount) < 1
    ) {
      throw new Error('Project settlement evidence is invalid');
    }
    settlementCommitment = commitment({
      settledTotal: canonicalDecimal(facts.settledTotal),
      settlementCount: facts.settlementCount,
      closedAt,
    });
  } else {
    settlementCommitment = keccak256(toHex('project:settlement:not-paid'));
  }
  return {
    kind: 'project',
    phase: facts.phase,
    entityCommitment: keccak256(toHex(`project:${projectId}`)),
    projectCommitment,
    itemsHash: facts.itemsHash,
    settlementCommitment,
  };
}

function requiredCommitment(value: unknown, field: string): `0x${string}` {
  if (typeof value !== 'string' || !isHex(value, { strict: true }) || value.length !== 66) {
    throw new Error(`CRE evidence ${field} is not a bytes32 commitment`);
  }
  return value as `0x${string}`;
}

/** Strictly validates the commitment-only response returned by Shiva. */
export function parseCreEvidenceCommitments(value: unknown): CreEvidenceCommitments {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('CRE evidence response is invalid');
  }
  const wrapper = value as Record<string, unknown>;
  const candidate = wrapper.success === true ? wrapper.evidence : value;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error('CRE evidence response is invalid');
  }
  const evidence = candidate as Record<string, unknown>;
  const entityCommitment = requiredCommitment(evidence.entityCommitment, 'entityCommitment');
  switch (evidence.kind) {
    case 'contract':
      return {
        kind: 'contract',
        event: requiredContractEvent(evidence.event),
        entityCommitment,
        agreementCommitment: requiredCommitment(
          evidence.agreementCommitment,
          'agreementCommitment'
        ),
        stateCommitment: requiredCommitment(evidence.stateCommitment, 'stateCommitment'),
        snapshotCommitment: requiredCommitment(evidence.snapshotCommitment, 'snapshotCommitment'),
      };
    case 'payroll':
      return {
        kind: 'payroll',
        entityCommitment,
        recordCommitment: requiredCommitment(evidence.recordCommitment, 'recordCommitment'),
        recipientCommitment: requiredCommitment(
          evidence.recipientCommitment,
          'recipientCommitment'
        ),
        batchCommitment: requiredCommitment(evidence.batchCommitment, 'batchCommitment'),
      };
    case 'reimbursement':
      if (evidence.phase !== 'sent' && evidence.phase !== 'paid') {
        throw new Error('CRE evidence reimbursement phase is invalid');
      }
      if (typeof evidence.itemsHash !== 'string' || !SHA256_HEX.test(evidence.itemsHash)) {
        throw new Error('CRE evidence itemsHash is invalid');
      }
      return {
        kind: 'reimbursement',
        phase: evidence.phase,
        entityCommitment,
        requestCommitment: requiredCommitment(evidence.requestCommitment, 'requestCommitment'),
        itemsHash: evidence.itemsHash,
        settlementCommitment: requiredCommitment(
          evidence.settlementCommitment,
          'settlementCommitment'
        ),
      };
    case 'report':
      return {
        kind: 'report',
        entityCommitment,
        reportCommitment: requiredCommitment(evidence.reportCommitment, 'reportCommitment'),
        transactionsHash: requiredCommitment(evidence.transactionsHash, 'transactionsHash'),
        metricsHash: requiredCommitment(evidence.metricsHash, 'metricsHash'),
        analysisHash: requiredCommitment(evidence.analysisHash, 'analysisHash'),
        combinedHash: requiredCommitment(evidence.combinedHash, 'combinedHash'),
      };
    case 'project':
      if (evidence.phase !== 'sent' && evidence.phase !== 'paid' && evidence.phase !== 'closed') {
        throw new Error('CRE evidence project phase is invalid');
      }
      if (typeof evidence.itemsHash !== 'string' || !SHA256_HEX.test(evidence.itemsHash)) {
        throw new Error('CRE evidence itemsHash is invalid');
      }
      return {
        kind: 'project',
        phase: evidence.phase,
        entityCommitment,
        projectCommitment: requiredCommitment(evidence.projectCommitment, 'projectCommitment'),
        itemsHash: evidence.itemsHash,
        settlementCommitment: requiredCommitment(
          evidence.settlementCommitment,
          'settlementCommitment'
        ),
      };
    default:
      throw new Error('CRE evidence kind is invalid');
  }
}
