/**
 * @bu/cre -- Chainlink Runtime Environment Integration
 *
 * Shared types, constants, and trigger client for CRE workflows.
 *
 * Usage:
 *   import { triggerTransferVerification } from "@bu/cre"           // Trigger client
 *   import type { AttestationRecord } from "@bu/cre/types"          // Types
 *   import { ATTESTATION_CONTRACTS } from "@bu/cre/constants"       // Constants
 */

export {
  CRE_CONTROL_PLANE_AUDIT,
  CRE_NETWORK_CATALOG,
  CRE_RECEIVER_DEPLOYMENT_PREFLIGHTS,
  CRE_WORKFLOW_CATALOG,
  type CREControlPlaneAudit,
  type CREDeploymentAccessStatus,
  type CRENetworkDefinition,
  type CREReceiverDeploymentPreflight,
  type CREReceiverDeploymentPreflightStatus,
  type CREWorkflowDefinition,
  type CREWorkflowProduct,
  type CREWorkflowReadiness,
  type CREWorkflowTrigger,
  creNetwork,
  creReceiverDeploymentPreflight,
  creWorkflow,
} from './catalog';
export type { CREClientConfig, TriggerResult } from './client';
// Client -- trigger CRE workflows from platform code
export {
  configureCREClient,
  triggerBalanceAttestation,
  triggerFeeReconciliation,
  triggerPayrollAttestation,
  triggerRampVerification,
  triggerReportAttestation,
  triggerTransferVerification,
  triggerTreasuryRebalance,
} from './client';
// Constants
export {
  ATTESTATION_CONTRACTS,
  ATTESTATION_OP_TYPES,
  CRE_CHAIN_SELECTORS,
  CRE_RECEIVER_ADDRESSES,
  CRE_WORKFLOW_NAMES,
  type CREChainSelector,
} from './constants';
export {
  buildPayrollEvidenceCommitments,
  buildReimbursementEvidenceCommitments,
  buildReportEvidenceCommitments,
  type CreEvidenceClaims,
  type CreEvidenceCommitments,
  type CreEvidenceKind,
  type CreEvidenceReference,
  canonicalDecimal,
  createCreEvidenceToken,
  openCreEvidenceToken,
  type PayrollEvidenceRecord,
  parseCreEvidenceCommitments,
  type ReimbursementEvidenceFacts,
  type ReimbursementEvidenceRecord,
  type ReportEvidenceRecord,
  stableStringify,
} from './evidence';
// Types
export type {
  AttestationConfig,
  AttestationData,
  AttestationRecord,
  AttestationResult,
  AttestationType,
  BalanceSnapshot,
  FeeReconciliation,
  RampVerification,
  TransferVerification,
} from './types';
