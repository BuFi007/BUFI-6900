/**
 * Verification Result Types
 *
 * Types for the data produced by CRE verification workflows.
 * Import from @bu/cre/types to consume verification results
 * in admin dashboards, compliance tools, etc.
 */

/** Result of a transfer verification check */
export interface TransferVerification {
  transferId: string;
  /** Amount seen on-chain */
  onChainAmount: string;
  /** Amount in platform records (Shiva/Circle) */
  platformAmount: string;
  /** Whether amounts and addresses match */
  match: boolean;
  /** Description of mismatch if any */
  discrepancy?: string;
}

/** Result of a balance attestation snapshot */
export interface BalanceSnapshot {
  walletAddress: string;
  chainId: number;
  /** Balance read directly from chain via EVM Read */
  onChainBalance: string;
  /** Balance reported by platform (Motora/Shiva) */
  platformBalance: string;
  currency: 'USDC' | 'EURC';
  match: boolean;
  timestamp: number;
}

/** Result of a fee reconciliation check */
export interface FeeReconciliation {
  /** Date range of the reconciliation period */
  periodStart: string;
  periodEnd: string;
  /** Total fees expected (from @bu/fee calculations) */
  expectedTotal: string;
  /** Total fees observed on-chain in fee recipient wallets */
  actualTotal: string;
  match: boolean;
  /** Per-service breakdown */
  breakdown?: Record<string, { expected: string; actual: string }>;
}

/** Result of a ramp verification */
export interface RampVerification {
  rampId: string;
  rampType: 'onramp' | 'offramp';
  /** Expected USDC amount from the ramp operation */
  expectedAmount: string;
  /** Actual USDC balance change observed on-chain */
  onChainAmount: string;
  match: boolean;
  depositAddress: string;
}
