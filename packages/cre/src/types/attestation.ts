/**
 * Attestation Types
 *
 * Shared between CRE workflows (apps/cre) and the rest of the monorepo.
 * Import these from @bu/cre/types to display attestation data in
 * admin dashboards, user-facing apps, etc.
 */

/** All supported attestation operation types */
export type AttestationType =
  | 'transfer_verify'
  | 'balance_attest'
  | 'invoice_settle'
  | 'fee_reconcile'
  | 'ramp_verify'
  | 'report_verify'
  | 'payroll_attest'
  | 'reimbursement_attest'
  | 'kyc_verified'
  | 'kyb_verified'
  | 'proof_of_reserves'
  | 'usdcg_supply_snapshot'
  | 'escrow_verify'
  | 'escrow_dispute'
  | 'escrow_yield_deposit'
  | 'escrow_yield_redeem'
  | 'escrow_finalize'
  | 'allowlist_sync'
  | 'worldid_verify'
  | 'contract_lifecycle'
  | 'gateway_sweep'
  | 'payment_score_attest';

/** An attestation record as stored on-chain in BUAttestation.sol */
export interface AttestationRecord {
  /** On-chain attestation ID (keccak256 of opType + entityId + timestamp) */
  id: string;
  /** The type of verification performed */
  type: AttestationType;
  /** Platform entity ID (transfer ID, invoice ID, etc.) */
  entityId: string;
  /** keccak256 hash of the verified data */
  dataHash: string;
  /** Transaction hash of the attestation write */
  txHash: string;
  /** Chain ID where the attestation was recorded */
  chainId: number;
  /** Unix timestamp of the attestation */
  timestamp: number;
  /** Optional metadata stored on-chain */
  metadata?: Record<string, unknown>;
}

/** Result returned from the publishAttestation() service */
export interface AttestationResult {
  txHash: string;
  attestationId: string;
  dataHash: string;
  timestamp: number;
}

/** Data passed to publishAttestation() */
export interface AttestationData {
  type: AttestationType;
  entityId: string;
  /** Arbitrary data -- will be keccak256 hashed for on-chain storage */
  data: Record<string, unknown>;
  /** Optional JSON metadata stored on-chain */
  metadata?: string;
}

/**
 * Config shape required by attestation service.
 * Workflow configs that use publishAttestation() must extend this.
 */
export interface AttestationConfig {
  chainSelectorName: string;
  attestationContract: string;
  gasLimit: string;
}
