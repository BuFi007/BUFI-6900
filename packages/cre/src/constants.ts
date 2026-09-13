/**
 * CRE Constants
 *
 * Shared constants for CRE workflows and platform integrations.
 * Contract addresses, chain selectors, and endpoints.
 */

// ============================================================================
// BUAttestation Contract Addresses
// ============================================================================

/**
 * Receiver addresses referenced by the checked-in CRE workflow configs.
 *
 * These are deployment identities, not a claim that each deployment supports
 * every current operation. `CRE_RECEIVER_DEPLOYMENTS` in `catalog.ts` records
 * the last verified interface/operation compatibility for Workbench.
 */
export const CRE_RECEIVER_ADDRESSES = {
  SEPOLIA_HARDENED_V2: '0xC3C7A1bd7556ba93729f859F0f1D1Cb60aeEc72C',
  SEPOLIA_LEGACY_V3: '0x67fEd62cC3E3988671ECaaE132e637eA17B2FEDB',
  ARBITRUM_SEPOLIA_MOCK: '0xaaf50d1ccf481657f9719a71b8384a9e1bbe1348',
} as const;

/** Default hardened receiver per network. Networks without a compatible receiver stay absent. */
export const ATTESTATION_CONTRACTS: Readonly<Record<string, string>> = {
  'ethereum-testnet-sepolia': CRE_RECEIVER_ADDRESSES.SEPOLIA_HARDENED_V2,
};

// ============================================================================
// CRE-Supported Chain Selectors
// ============================================================================

/**
 * Chain selector names used in CRE project.yaml and workflow configs.
 * These map to CRE's internal chain identifiers.
 */
export const CRE_CHAIN_SELECTORS = {
  // Testnets
  ETH_SEPOLIA: 'ethereum-testnet-sepolia',
  AVAX_FUJI: 'avalanche-testnet-fuji',
  BASE_SEPOLIA: 'ethereum-testnet-sepolia-base-1',
  ARB_SEPOLIA: 'ethereum-testnet-sepolia-arbitrum-1',
  POLYGON_AMOY: 'polygon-testnet-amoy',

  // Mainnets (for future production deployment)
  ETH_MAINNET: 'ethereum-mainnet',
  AVAX_MAINNET: 'avalanche-mainnet',
  BASE_MAINNET: 'base-mainnet',
} as const;

export type CREChainSelector = (typeof CRE_CHAIN_SELECTORS)[keyof typeof CRE_CHAIN_SELECTORS];

// ============================================================================
// Attestation Operation Types
// ============================================================================

/** Maps attestation type to uint8 used in BUAttestation.sol */
export const ATTESTATION_OP_TYPES = {
  transfer_verify: 0,
  balance_attest: 1,
  invoice_settle: 2,
  fee_reconcile: 3,
  ramp_verify: 4,
  report_verify: 5,
  payroll_attest: 6,
  kyc_verified: 7,
  kyb_verified: 8,
  proof_of_reserves: 9,
  usdcg_supply_snapshot: 10,
  escrow_verify: 11,
  escrow_dispute: 12,
  escrow_yield_deposit: 13,
  escrow_yield_redeem: 14,
  escrow_finalize: 15,
  reimbursement_attest: 16,
  allowlist_sync: 19,
  worldid_verify: 20,
  contract_lifecycle: 22,
  gateway_sweep: 23,
  payment_score_attest: 24,
} as const;

// ============================================================================
// Workflow Name Constants
// ============================================================================

/** Canonical workflow names matching BuFi007/chainlink-cre workflow-* directories (apps/cre removed 2026-07-21) */
export const CRE_WORKFLOW_NAMES = {
  TRANSFER_VERIFY: 'workflow-transfer-verify',
  BALANCE_ATTESTATION: 'workflow-balance-attestation',
  FEE_RECONCILIATION: 'workflow-fee-reconciliation',
  PAYROLL_ATTEST: 'workflow-payroll-attest',
  REPORT_VERIFY: 'workflow-report-verify',
  RAMP_VERIFY: 'workflow-ramp-verify',
  TREASURY_REBALANCE: 'workflow-treasury-rebalance',
} as const;
