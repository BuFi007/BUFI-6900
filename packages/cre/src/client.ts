/**
 * CRE Trigger Client
 *
 * Allows existing platform code (Trigger.dev tasks, Shiva routes, Motora
 * handlers) to trigger CRE workflows via their HTTP endpoints.
 *
 * Follows the same pattern as @bu/trigger's typed wrappers:
 *   import { triggerTransferVerification } from "@bu/cre"
 *
 * @example
 * ```ts
 * // In a Trigger.dev task after a successful transfer:
 * import { triggerTransferVerification } from "@bu/cre"
 *
 * await triggerTransferVerification({
 *   transferId: transfer.id,
 *   txHash: result.transactionHash,
 *   chainId: transfer.fromChainId,
 *   amount: transfer.amount,
 * })
 * ```
 */

import {
  publishWorkbenchEvent,
  type WorkbenchEnvironment,
  type WorkbenchProduct,
  type WorkbenchSource,
} from '@bu/observability/workbench-events';

import { CRE_WORKFLOW_NAMES } from './constants';

// ============================================================================
// Configuration
// ============================================================================

export interface CREClientConfig {
  /** Base URL of the CRE HTTP trigger endpoint */
  baseUrl: string;
  /** Auth token for the CRE endpoint (if deployed on DON) */
  authToken?: string;
  /** Explicit target classification for Workbench observability. */
  environment?: WorkbenchEnvironment;
}

let clientConfig: CREClientConfig | null = null;

/**
 * Configure the CRE trigger client.
 * Call this once at startup (similar to createTriggerClient in @bu/trigger).
 */
export function configureCREClient(config: CREClientConfig): void {
  clientConfig = config;
}

/**
 * TEST-ONLY: reset the module singleton so the not-configured path is testable.
 * (Replaces a query-string cache-bust dynamic re-import that bun 1.1.x — the CI
 * runtime — hangs on. Do not call from production code.)
 */
export function resetCREClientForTests(): void {
  clientConfig = null;
}

// ============================================================================
// Core Trigger Function
// ============================================================================

export interface TriggerResult {
  success: boolean;
  error?: string;
}

function classifyTarget(
  baseUrl: string,
  configured?: WorkbenchEnvironment
): {
  source: WorkbenchSource;
  environment: WorkbenchEnvironment;
} {
  const environment =
    configured ??
    (() => {
      try {
        const hostname = new URL(baseUrl).hostname;
        if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
          return 'local' as const;
        }
      } catch {
        // Fetch below remains the authority for malformed URL failures.
      }
      return process.env.NODE_ENV === 'production' ? ('live' as const) : ('testnet' as const);
    })();

  return {
    source: environment === 'local' ? 'cre_local' : 'cre_live',
    environment,
  };
}

function classifyProduct(workflowName: string): WorkbenchProduct {
  if (workflowName.includes('factoring')) return 'factoring';
  if (workflowName.includes('payroll')) return 'payroll';
  if (workflowName.includes('reimbursement')) return 'reimbursement';
  if (workflowName.includes('invoice')) return 'invoice';
  if (workflowName.includes('report')) return 'ai';
  if (workflowName.includes('fee') || workflowName.includes('tax')) return 'tax';
  if (workflowName.includes('score')) return 'factoring';
  if (workflowName.includes('inbox')) return 'inbox';
  if (workflowName.includes('graph') || workflowName.includes('knowledge')) return 'graph';
  return 'contract';
}

function payloadString(payload: unknown, keys: string[]): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;
  for (const key of keys) {
    if (typeof record[key] === 'string' && record[key]) return record[key] as string;
  }
  return undefined;
}

/**
 * Trigger a CRE workflow via its HTTP endpoint.
 * Works for both local simulation and deployed workflows.
 */
async function triggerCREWorkflow<T>(workflowName: string, payload: T): Promise<TriggerResult> {
  if (!clientConfig) {
    throw new Error('CRE client not configured. Call configureCREClient({ baseUrl }) first.');
  }

  const url = `${clientConfig.baseUrl}/${workflowName}`;
  const traceId = payloadString(payload, ['traceId', 'trace_id']) ?? crypto.randomUUID();
  const runId = payloadString(payload, ['workbenchRunId', 'runId']) ?? `cre_${crypto.randomUUID()}`;
  const target = classifyTarget(clientConfig.baseUrl, clientConfig.environment);
  const product = classifyProduct(workflowName);

  const publish = (state: 'running' | 'succeeded' | 'failed', summary: string, retryable = false) =>
    publishWorkbenchEvent({
      runId,
      traceId,
      source: target.source,
      product,
      environment: target.environment,
      mode: 'dispatch',
      state,
      kind: state === 'failed' ? 'error' : 'trigger',
      workflow: workflowName,
      privacyLevel: product === 'privacy' ? 'commitment_only' : 'metadata_only',
      summary,
      error: state === 'failed' ? { code: 'CRE_TRIGGER_FAILED', retryable } : undefined,
    });

  await publish('running', `Dispatching ${workflowName}`);

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-BUFI-Run-Id': runId,
        'X-Trace-Id': traceId,
        ...(clientConfig.authToken ? { Authorization: `Bearer ${clientConfig.authToken}` } : {}),
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      await publish('failed', `${workflowName} rejected the dispatch`, resp.status >= 500);
      return {
        success: false,
        error: `CRE trigger ${workflowName} failed: ${resp.status} ${resp.statusText}`,
      };
    }

    await publish('succeeded', `${workflowName} returned successfully`);
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await publish('failed', `${workflowName} could not be dispatched`, true);
    return {
      success: false,
      error: `CRE trigger ${workflowName} error: ${message}`,
    };
  }
}

// ============================================================================
// Typed Workflow Triggers
// ============================================================================
// Same pattern as @bu/trigger's triggerEnsureInvoiceSchedule, etc.

/** Trigger transfer verification CRE workflow */
export async function triggerTransferVerification(payload: {
  transferId: string;
  txHash: string;
  chainId: number;
  amount: string;
}): Promise<TriggerResult> {
  return triggerCREWorkflow(CRE_WORKFLOW_NAMES.TRANSFER_VERIFY, payload);
}

/** Trigger balance attestation CRE workflow */
export async function triggerBalanceAttestation(payload: {
  teamId: string;
  walletAddresses: string[];
  chainIds: number[];
}): Promise<TriggerResult> {
  return triggerCREWorkflow(CRE_WORKFLOW_NAMES.BALANCE_ATTESTATION, payload);
}

/** Trigger fee reconciliation CRE workflow */
export async function triggerFeeReconciliation(payload: {
  periodStart: string;
  periodEnd: string;
  feeRecipientAddresses: string[];
}): Promise<TriggerResult> {
  return triggerCREWorkflow(CRE_WORKFLOW_NAMES.FEE_RECONCILIATION, payload);
}

/** Trigger payroll attestation CRE workflow */
export async function triggerPayrollAttestation(payload: {
  /** Opaque, short-lived reference minted by an authorized BUFI server. */
  evidenceToken: string;
}): Promise<TriggerResult> {
  return triggerCREWorkflow(CRE_WORKFLOW_NAMES.PAYROLL_ATTEST, payload);
}

/** Trigger AI report attestation CRE workflow */
export async function triggerReportAttestation(payload: {
  /** Opaque, short-lived reference minted by an authorized BUFI server. */
  evidenceToken: string;
}): Promise<TriggerResult> {
  return triggerCREWorkflow(CRE_WORKFLOW_NAMES.REPORT_VERIFY, payload);
}

/** Trigger ramp verification CRE workflow */
export async function triggerRampVerification(payload: {
  rampId: string;
  rampType: 'onramp' | 'offramp';
  expectedAmount: string;
  depositAddress: string;
}): Promise<TriggerResult> {
  return triggerCREWorkflow(CRE_WORKFLOW_NAMES.RAMP_VERIFY, payload);
}

/** Trigger treasury rebalance CRE workflow (normally cron-driven, this is for manual triggers) */
export async function triggerTreasuryRebalance(payload: {
  reason?: string;
}): Promise<TriggerResult> {
  return triggerCREWorkflow(CRE_WORKFLOW_NAMES.TREASURY_REBALANCE, payload);
}
