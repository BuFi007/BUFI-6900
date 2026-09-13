import {
  ATTESTATION_OP_TYPES,
  CRE_CHAIN_SELECTORS,
  CRE_RECEIVER_ADDRESSES,
  type CREChainSelector,
} from './constants';

export type CREWorkflowProduct =
  | 'invoice'
  | 'payroll'
  | 'reimbursement'
  | 'contract'
  | 'tax'
  | 'factoring'
  | 'privacy'
  | 'ai'
  | 'inbox'
  | 'graph';

export type CREWorkflowTrigger = 'http' | 'cron' | 'evm_log' | 'boundary_event';
export type CREWorkflowReadiness =
  | 'simulation_verified'
  | 'fixture_verified'
  | 'code_only'
  | 'specification_only'
  | 'external_boundary'
  | 'retired'
  | 'example';

export interface CRENetworkDefinition {
  selector: CREChainSelector;
  chainId: number;
  label: string;
  explorerUrl: string;
  simulationTarget: string;
}

export interface CRETenantChainAudit {
  cliVersion: string;
  verifiedAt: string;
  enabledSelectors: CREChainSelector[];
  reason: string;
}

export type CREReceiverDeploymentStatus =
  | 'cre_receiver'
  | 'incompatible_interface'
  | 'missing_code';

export type CREForwarderAuditStatus = 'verified' | 'mismatch' | 'not_checked';

export interface CREReceiverDeployment {
  selector: CREChainSelector;
  address: `0x${string}`;
  status: CREReceiverDeploymentStatus;
  /** Highest operation accepted by the deployed enum, verified with read-only eth_call. */
  maxOperationType?: number;
  /** Forwarder currently configured in the receiver, verified with read-only eth_call. */
  forwarderAddress?: `0x${string}`;
  /** Chainlink KeystoneForwarder required for deployed workflows on this network. */
  expectedForwarderAddress?: `0x${string}`;
  forwarderStatus: CREForwarderAuditStatus;
  verifiedAt: string;
  reason: string;
}

export type CREReceiverDeploymentPreflightStatus = 'dry_run_succeeded';

/**
 * Reproducible, non-broadcast evidence that the current receiver constructor
 * can be simulated against a network RPC with Chainlink's published
 * KeystoneForwarder. This is deliberately not a deployment record and never
 * satisfies the receiver or CRE listing gates.
 */
export interface CREReceiverDeploymentPreflight {
  selector: CREChainSelector;
  chainId: number;
  contract: 'BUAttestation';
  status: CREReceiverDeploymentPreflightStatus;
  forwarderAddress: `0x${string}`;
  sourceCommit: string;
  simulatedAt: string;
  gasEstimate: number;
  broadcast: false;
  reason: string;
}

export type CREDeploymentAccessStatus =
  | 'unknown'
  | 'not_requested'
  | 'request_submitted'
  | 'enabled'
  | 'denied';

export interface CREControlPlaneAudit {
  deploymentAccess: CREDeploymentAccessStatus;
  registryWorkflowCount: number;
  cliVersion: string;
  accessVerifiedAt?: string;
  registryVerifiedAt?: string;
  verifiedAt: string;
  reason: string;
}

export interface CREWorkflowReceiverRequirement {
  operationTypes: number[];
  addresses: Partial<Record<CREChainSelector, `0x${string}`>>;
}

export type CREWorkflowDeploymentTarget = 'staging' | 'production';

/**
 * Checked control-plane evidence for a deployed CRE workflow. A successful
 * local simulation never creates one of these records. The registry is kept
 * deliberately explicit so Workbench cannot infer deployment from config,
 * a receiver address, or a gateway URL.
 */
export interface CREWorkflowDeployment {
  workflow: string;
  selector: CREChainSelector;
  target: CREWorkflowDeploymentTarget;
  workflowId: string;
  configDigest: `0x${string}`;
  confidentialEvidence: 'vault_don' | 'not_required';
  deployedAt: string;
  verifiedAt: string;
  reason: string;
}

export interface CREWorkflowDefinition {
  name: string;
  product: CREWorkflowProduct;
  owner: 'desk' | 'external';
  readiness: CREWorkflowReadiness;
  triggers: CREWorkflowTrigger[];
  networks: CREChainSelector[];
  steps: string[];
  /** Static names for numbered `[USER LOG] Step N` messages proven in simulation. */
  simulationLogSteps?: string[];
  /** Maximum detail the operator plane may retain for this workflow. */
  privacyLevel?: 'metadata_only' | 'commitment_only';
  /** Receiver and operation compatibility required for a real EVM write. */
  receiver?: CREWorkflowReceiverRequirement;
  reason: string;
}

export const CRE_NETWORK_CATALOG: readonly CRENetworkDefinition[] = [
  {
    selector: CRE_CHAIN_SELECTORS.ETH_SEPOLIA,
    chainId: 11155111,
    label: 'Ethereum Sepolia',
    explorerUrl: 'https://sepolia.etherscan.io',
    simulationTarget: 'local-simulation',
  },
  {
    selector: CRE_CHAIN_SELECTORS.AVAX_FUJI,
    chainId: 43113,
    label: 'Avalanche Fuji',
    explorerUrl: 'https://testnet.snowtrace.io',
    simulationTarget: 'local-fuji-simulation',
  },
  {
    selector: CRE_CHAIN_SELECTORS.BASE_SEPOLIA,
    chainId: 84532,
    label: 'Base Sepolia',
    explorerUrl: 'https://sepolia.basescan.org',
    simulationTarget: 'local-base-simulation',
  },
  {
    selector: CRE_CHAIN_SELECTORS.ARB_SEPOLIA,
    chainId: 421614,
    label: 'Arbitrum Sepolia',
    explorerUrl: 'https://sepolia.arbiscan.io',
    simulationTarget: 'local-arbitrum-simulation',
  },
  {
    selector: CRE_CHAIN_SELECTORS.POLYGON_AMOY,
    chainId: 80002,
    label: 'Polygon Amoy',
    explorerUrl: 'https://amoy.polygonscan.com',
    simulationTarget: 'local-amoy-simulation',
  },
] as const;

/**
 * Last authenticated, read-only `cre workflow supported-chains` audit. Only
 * BUFI's declared testnet subset is retained; account identity and the wider
 * tenant response are deliberately excluded from the operator projection.
 */
export const CRE_TENANT_CHAIN_AUDIT: CRETenantChainAudit = {
  cliVersion: '1.23.0',
  verifiedAt: '2026-07-19T09:33:37.000Z',
  enabledSelectors: [
    CRE_CHAIN_SELECTORS.ETH_SEPOLIA,
    CRE_CHAIN_SELECTORS.AVAX_FUJI,
    CRE_CHAIN_SELECTORS.BASE_SEPOLIA,
    CRE_CHAIN_SELECTORS.ARB_SEPOLIA,
    CRE_CHAIN_SELECTORS.POLYGON_AMOY,
  ],
  reason:
    'The authenticated BUFI tenant reported every declared testnet chain as enabled. This proves tenant availability, not receiver deployment, workflow deployment, activation, or listing approval.',
};

/**
 * Production KeystoneForwarders published by Chainlink for deployed CRE
 * workflows. These are deliberately separate from tenant-scoped
 * MockKeystoneForwarders used by `cre workflow simulate --broadcast`.
 *
 * Source: https://docs.chain.link/cre/guides/workflow/using-evm-client/forwarder-directory-ts
 * Verified: 2026-07-19
 */
export const CRE_PRODUCTION_FORWARDERS: Readonly<Partial<Record<CREChainSelector, `0x${string}`>>> =
  {
    [CRE_CHAIN_SELECTORS.ETH_SEPOLIA]: '0xF8344CFd5c43616a4366C34E3EEE75af79a74482',
    [CRE_CHAIN_SELECTORS.AVAX_FUJI]: '0x76c9cf548b4179F8901cda1f8623568b58215E62',
    [CRE_CHAIN_SELECTORS.BASE_SEPOLIA]: '0xF8344CFd5c43616a4366C34E3EEE75af79a74482',
    [CRE_CHAIN_SELECTORS.ARB_SEPOLIA]: '0x76c9cf548b4179F8901cda1f8623568b58215E62',
    [CRE_CHAIN_SELECTORS.POLYGON_AMOY]: '0x76c9cf548b4179F8901cda1f8623568b58215E62',
  };

function requiredProductionForwarder(selector: CREChainSelector): `0x${string}` {
  const address = CRE_PRODUCTION_FORWARDERS[selector];
  if (!address) throw new Error(`Missing production KeystoneForwarder for ${selector}`);
  return address;
}

/**
 * Last read-only on-chain receiver audit. This deliberately separates a CRE
 * simulator write-report dry-run from proof that the configured deployment can
 * receive that workflow's operation on the declared network.
 */
export const CRE_RECEIVER_DEPLOYMENTS: readonly CREReceiverDeployment[] = [
  {
    selector: CRE_CHAIN_SELECTORS.ETH_SEPOLIA,
    address: CRE_RECEIVER_ADDRESSES.SEPOLIA_HARDENED_V2,
    status: 'cre_receiver',
    maxOperationType: 10,
    forwarderAddress: '0x09Ce8E2B3Fede2727dA4392Ea8Fe618305ba0474',
    expectedForwarderAddress: CRE_PRODUCTION_FORWARDERS[CRE_CHAIN_SELECTORS.ETH_SEPOLIA],
    forwarderStatus: 'mismatch',
    verifiedAt: '2026-07-19T01:15:00.000Z',
    reason:
      'Code and ReceiverTemplate interface are present, but the deployed enum accepts only operations 0–10 and the receiver trusts the BUFI deployer instead of the production KeystoneForwarder.',
  },
  {
    selector: CRE_CHAIN_SELECTORS.ETH_SEPOLIA,
    address: CRE_RECEIVER_ADDRESSES.SEPOLIA_LEGACY_V3,
    status: 'cre_receiver',
    maxOperationType: 18,
    forwarderAddress: '0x09Ce8E2B3Fede2727dA4392Ea8Fe618305ba0474',
    expectedForwarderAddress: CRE_PRODUCTION_FORWARDERS[CRE_CHAIN_SELECTORS.ETH_SEPOLIA],
    forwarderStatus: 'mismatch',
    verifiedAt: '2026-07-19T01:15:00.000Z',
    reason:
      'Legacy Sepolia receiver is live and accepts operations 0–18, but it trusts the BUFI deployer instead of the production KeystoneForwarder.',
  },
  {
    selector: CRE_CHAIN_SELECTORS.AVAX_FUJI,
    address: CRE_RECEIVER_ADDRESSES.SEPOLIA_LEGACY_V3,
    status: 'missing_code',
    expectedForwarderAddress: CRE_PRODUCTION_FORWARDERS[CRE_CHAIN_SELECTORS.AVAX_FUJI],
    forwarderStatus: 'not_checked',
    verifiedAt: '2026-07-19T01:15:00.000Z',
    reason: 'The configured Fuji address has no deployed bytecode on chain 43113.',
  },
  {
    selector: CRE_CHAIN_SELECTORS.ARB_SEPOLIA,
    address: CRE_RECEIVER_ADDRESSES.ARBITRUM_SEPOLIA_MOCK,
    status: 'incompatible_interface',
    expectedForwarderAddress: CRE_PRODUCTION_FORWARDERS[CRE_CHAIN_SELECTORS.ARB_SEPOLIA],
    forwarderStatus: 'not_checked',
    verifiedAt: '2026-07-19T01:15:00.000Z',
    reason:
      'The deployed test mock exposes attest(bytes32,uint8), not the CRE ReceiverTemplate onReport interface.',
  },
] as const;

/**
 * Foundry fork simulations executed without `--broadcast`, a private key, or
 * production secrets. Ignored Foundry artifacts remain local; this safe
 * manifest is the reviewable evidence exposed in Workbench.
 */
export const CRE_RECEIVER_DEPLOYMENT_PREFLIGHTS: readonly CREReceiverDeploymentPreflight[] = [
  {
    selector: CRE_CHAIN_SELECTORS.ETH_SEPOLIA,
    chainId: 11155111,
    contract: 'BUAttestation',
    status: 'dry_run_succeeded',
    forwarderAddress: requiredProductionForwarder(CRE_CHAIN_SELECTORS.ETH_SEPOLIA),
    sourceCommit: '54fe840a0f318505d0d7c07cfc116de0252015f0',
    simulatedAt: '2026-07-19T05:23:22.051Z',
    gasEstimate: 2_090_569,
    broadcast: false,
    reason:
      'Foundry fork simulation created BUAttestation with the published Ethereum Sepolia KeystoneForwarder; no transaction was signed or broadcast.',
  },
  {
    selector: CRE_CHAIN_SELECTORS.ARB_SEPOLIA,
    chainId: 421614,
    contract: 'BUAttestation',
    status: 'dry_run_succeeded',
    forwarderAddress: requiredProductionForwarder(CRE_CHAIN_SELECTORS.ARB_SEPOLIA),
    sourceCommit: '54fe840a0f318505d0d7c07cfc116de0252015f0',
    simulatedAt: '2026-07-19T05:23:26.841Z',
    gasEstimate: 2_234_260,
    broadcast: false,
    reason:
      'Foundry fork simulation created BUAttestation with the published Arbitrum Sepolia KeystoneForwarder; no transaction was signed or broadcast.',
  },
  {
    selector: CRE_CHAIN_SELECTORS.AVAX_FUJI,
    chainId: 43113,
    contract: 'BUAttestation',
    status: 'dry_run_succeeded',
    forwarderAddress: requiredProductionForwarder(CRE_CHAIN_SELECTORS.AVAX_FUJI),
    sourceCommit: '54fe840a0f318505d0d7c07cfc116de0252015f0',
    simulatedAt: '2026-07-19T05:23:31.856Z',
    gasEstimate: 2_090_569,
    broadcast: false,
    reason:
      'Foundry fork simulation created BUAttestation with the published Avalanche Fuji KeystoneForwarder; no transaction was signed or broadcast.',
  },
] as const;

/**
 * Last authenticated CRE control-plane audit. This is external account state,
 * not evidence of a workflow deployment or listing approval.
 */
export const CRE_CONTROL_PLANE_AUDIT: CREControlPlaneAudit = {
  deploymentAccess: 'request_submitted',
  registryWorkflowCount: 0,
  cliVersion: '1.23.0',
  accessVerifiedAt: '2026-07-19T05:34:09.000Z',
  registryVerifiedAt: '2026-07-19T05:55:30.525Z',
  verifiedAt: '2026-07-19T05:34:09.000Z',
  reason:
    'Deployment access was not enabled at the last access check; the CRE CLI submitted an access request, and the later read-only authenticated workflow registry audit remains empty.',
};

/**
 * Authenticated audit on 2026-07-19: the BUFI organization had deploy access
 * disabled, an access request was submitted, and `cre workflow list` returned
 * no workflows.
 * Add entries only after a real control-plane deployment has been verified;
 * never populate this registry from simulator output.
 */
export const CRE_WORKFLOW_DEPLOYMENTS: readonly CREWorkflowDeployment[] = [];

const sepolia = [CRE_CHAIN_SELECTORS.ETH_SEPOLIA];
const receiver = (
  operationTypes: number[],
  selector: CREChainSelector = CRE_CHAIN_SELECTORS.ETH_SEPOLIA,
  address: `0x${string}` = CRE_RECEIVER_ADDRESSES.SEPOLIA_HARDENED_V2
): CREWorkflowReceiverRequirement => ({
  operationTypes,
  addresses: { [selector]: address },
});

/**
 * Operator-facing registry. `simulation_verified` proves a dry-run execution,
 * not deployment, DON activation, production approval, or a real chain write.
 */
export const CRE_WORKFLOW_CATALOG: readonly CREWorkflowDefinition[] = [
  {
    name: 'workflow-contract-lifecycle',
    product: 'contract',
    owner: 'desk',
    readiness: 'fixture_verified',
    triggers: ['http'],
    networks: sepolia,
    receiver: receiver([ATTESTATION_OP_TYPES.contract_lifecycle]),
    steps: ['resolve_snapshot', 'verify_commitments', 'write_attestation', 'persist_receipt'],
    simulationLogSteps: ['resolve_contract_snapshot', 'write_contract_attestation'],
    privacyLevel: 'commitment_only',
    reason:
      'Shiva remains execution authority; local simulation attests only a commitment envelope. Receiver operation 22 still requires a compatible deployment before broadcast.',
  },
  {
    name: 'workflow-escrow-deploy',
    product: 'contract',
    owner: 'desk',
    readiness: 'retired',
    triggers: ['http'],
    networks: sepolia,
    receiver: receiver([ATTESTATION_OP_TYPES.escrow_verify]),
    steps: ['validate_agreement', 'build_report', 'deploy_escrow', 'persist_callback'],
    reason:
      'Retired: escrow deployment belongs to Shiva/ACE; CRE now attests the resulting lifecycle snapshot.',
  },
  {
    name: 'workflow-escrow-verify',
    product: 'contract',
    owner: 'desk',
    readiness: 'retired',
    triggers: ['http'],
    networks: sepolia,
    receiver: receiver([ATTESTATION_OP_TYPES.escrow_verify]),
    steps: ['load_submission', 'load_milestone', 'verify_evidence', 'persist_verdict', 'callback'],
    reason: 'Retired: the authoritative deliverable verification pipeline runs in Shiva/Workflows.',
  },
  {
    name: 'workflow-escrow-dispute',
    product: 'contract',
    owner: 'desk',
    readiness: 'retired',
    triggers: ['http'],
    networks: sepolia,
    receiver: receiver([ATTESTATION_OP_TYPES.escrow_dispute]),
    steps: ['lock_milestone', 'load_dispute', 'generate_briefs', 'tribunal', 'persist_callback'],
    reason: 'Retired: Shiva owns advocates, tribunal, persistence, and rollback semantics.',
  },
  {
    name: 'workflow-escrow-finalize',
    product: 'contract',
    owner: 'desk',
    readiness: 'retired',
    triggers: ['http'],
    networks: sepolia,
    receiver: receiver([ATTESTATION_OP_TYPES.escrow_finalize]),
    steps: ['load_agreement', 'resolve_decision', 'write_chain_state', 'release', 'callback'],
    reason:
      'Retired: Shiva/ACE owns settlement; CRE attests committed lifecycle state after execution.',
  },
  {
    name: 'workflow-escrow-monitor',
    product: 'contract',
    owner: 'desk',
    readiness: 'retired',
    triggers: ['cron', 'evm_log'],
    networks: sepolia,
    receiver: receiver([ATTESTATION_OP_TYPES.proof_of_reserves]),
    steps: ['observe_event', 'read_escrow', 'reconcile_state', 'publish_attestation'],
    reason:
      'Retired legacy monitor; Workbench observes the authoritative Shiva/ACE lifecycle directly.',
  },
  {
    name: 'workflow-escrow-yield',
    product: 'contract',
    owner: 'desk',
    readiness: 'retired',
    triggers: ['http'],
    networks: sepolia,
    receiver: receiver([
      ATTESTATION_OP_TYPES.escrow_yield_deposit,
      ATTESTATION_OP_TYPES.escrow_yield_redeem,
    ]),
    steps: ['load_agreement', 'select_strategy', 'execute_position', 'reconcile_backing'],
    reason:
      'Retired legacy yield executor; money movement remains an owner-gated Shiva/ACE boundary.',
  },
  {
    name: 'workflow-payroll-attest',
    product: 'payroll',
    owner: 'desk',
    readiness: 'fixture_verified',
    triggers: ['http'],
    networks: sepolia,
    receiver: receiver([ATTESTATION_OP_TYPES.payroll_attest]),
    steps: [
      'load_payroll',
      'verify_execution',
      'hash_recipients',
      'write_attestation',
      'persist_receipt',
    ],
    simulationLogSteps: [
      'load_payroll_evidence',
      'build_recipient_commitment',
      'write_payroll_attestation',
    ],
    privacyLevel: 'commitment_only',
    reason:
      'Sepolia fixture simulation proves the write path; local development can resolve an opaque token into commitments, while Vault DON owner and confidential staging evidence still require deployment configuration.',
  },
  {
    name: 'workflow-recibo-payroll',
    product: 'payroll',
    owner: 'desk',
    readiness: 'code_only',
    triggers: ['http'],
    networks: sepolia,
    receiver: receiver(
      [ATTESTATION_OP_TYPES.payroll_attest],
      CRE_CHAIN_SELECTORS.ETH_SEPOLIA,
      CRE_RECEIVER_ADDRESSES.SEPOLIA_LEGACY_V3
    ),
    steps: ['read_disbursement', 'verify_batch', 'write_attestation'],
    reason: 'On-chain read simulation and deployed contract evidence are still required.',
  },
  {
    name: 'workflow-reimbursement-attest',
    product: 'reimbursement',
    owner: 'desk',
    readiness: 'fixture_verified',
    triggers: ['http'],
    networks: sepolia,
    receiver: receiver([ATTESTATION_OP_TYPES.reimbursement_attest]),
    steps: [
      'decode_request',
      'load_request',
      'verify_canonical_hash',
      'write_attestation',
      'persist_receipt',
    ],
    simulationLogSteps: [
      'decode_reimbursement_evidence',
      'verify_request_commitment',
      'write_reimbursement_attestation',
    ],
    privacyLevel: 'commitment_only',
    reason:
      'Sepolia fixture simulations prove sent and paid writes; local development can resolve an opaque token into commitments, while Vault DON owner and confidential staging evidence still require deployment configuration.',
  },
  {
    name: 'workflow-report-verify',
    product: 'ai',
    owner: 'desk',
    readiness: 'fixture_verified',
    triggers: ['http'],
    networks: sepolia,
    receiver: receiver([ATTESTATION_OP_TYPES.report_verify]),
    steps: ['load_report', 'hash_sources', 'write_attestation', 'persist_receipt'],
    simulationLogSteps: [
      'load_completed_report',
      'hash_report_sources',
      'write_report_attestation',
    ],
    privacyLevel: 'commitment_only',
    reason:
      'Sepolia fixture simulation proves source hashing and the write; local development can resolve an opaque token into commitments, while Vault DON owner, confidential staging, and AI-trace correlation evidence remain required.',
  },
  {
    name: 'workflow-worldid-verify',
    product: 'contract',
    owner: 'desk',
    readiness: 'simulation_verified',
    triggers: ['http'],
    networks: [CRE_CHAIN_SELECTORS.ARB_SEPOLIA],
    receiver: receiver(
      [ATTESTATION_OP_TYPES.worldid_verify],
      CRE_CHAIN_SELECTORS.ARB_SEPOLIA,
      CRE_RECEIVER_ADDRESSES.ARBITRUM_SEPOLIA_MOCK
    ),
    steps: ['verify_marker', 'build_report', 'write_attestation'],
    simulationLogSteps: ['validate_world_api_marker', 'write_worldid_commitment'],
    privacyLevel: 'commitment_only',
    reason:
      'World API remains the verifier; CRE validates the authenticated marker and anchors its privacy-safe commitment on Arbitrum Sepolia.',
  },
  {
    name: 'workflow-gateway-sweep',
    product: 'contract',
    owner: 'desk',
    readiness: 'simulation_verified',
    triggers: ['http'],
    networks: [CRE_CHAIN_SELECTORS.AVAX_FUJI],
    receiver: receiver(
      [ATTESTATION_OP_TYPES.gateway_sweep],
      CRE_CHAIN_SELECTORS.AVAX_FUJI,
      CRE_RECEIVER_ADDRESSES.SEPOLIA_LEGACY_V3
    ),
    steps: ['resolve_gateway', 'read_balance', 'verify_sweep', 'write_attestation'],
    simulationLogSteps: ['verify_post_sweep_balance', 'write_attestation'],
    reason:
      'Local Fuji dry-run verifies a real ERC-20 balance read, the fail-closed balance delta, and the EVM write-report capability.',
  },
  {
    name: 'workflow-allowlist-sync',
    product: 'privacy',
    owner: 'desk',
    readiness: 'code_only',
    triggers: ['http'],
    networks: sepolia,
    receiver: receiver([ATTESTATION_OP_TYPES.allowlist_sync]),
    steps: ['read_policy', 'compare_allowlist', 'write_update'],
    reason: 'Fail-open local policy fallback must be disabled outside simulation.',
  },
  {
    name: 'workflow-treasury-rebalance',
    product: 'contract',
    owner: 'desk',
    readiness: 'code_only',
    triggers: ['cron'],
    networks: sepolia,
    receiver: receiver([ATTESTATION_OP_TYPES.balance_attest]),
    steps: ['read_reserves', 'evaluate_ratio', 'build_report', 'write_rebalance'],
    reason: 'Cron simulation and deterministic-time hardening are still required.',
  },
  {
    name: 'workflow-agent-validation',
    product: 'ai',
    owner: 'desk',
    readiness: 'specification_only',
    triggers: ['http'],
    networks: [
      CRE_CHAIN_SELECTORS.ETH_SEPOLIA,
      CRE_CHAIN_SELECTORS.ARB_SEPOLIA,
      CRE_CHAIN_SELECTORS.AVAX_FUJI,
    ],
    steps: ['resolve_agent', 'verify_registration', 'validate_evidence'],
    reason:
      'Legacy handler specification only: no CRE Runner entrypoint or current project/workflow target exists.',
  },
  {
    name: 'workflow-ace-finalize',
    product: 'ai',
    owner: 'desk',
    readiness: 'specification_only',
    triggers: ['http'],
    networks: [
      CRE_CHAIN_SELECTORS.ETH_SEPOLIA,
      CRE_CHAIN_SELECTORS.ARB_SEPOLIA,
      CRE_CHAIN_SELECTORS.AVAX_FUJI,
    ],
    steps: ['resolve_policy', 'write_verdict', 'record_reputation'],
    reason:
      'Legacy handler specification only: no CRE Runner entrypoint exists and extractor addresses remain unresolved.',
  },
  {
    name: 'workflow-invoice-settle',
    product: 'invoice',
    owner: 'external',
    readiness: 'retired',
    triggers: ['boundary_event'],
    networks: [],
    steps: ['settlement_outbox', 'external_consumer', 'attestation_callback'],
    reason:
      'Embedded mutable-row settlement was retired; canonical InvoiceSettlementFinalizedV1 is externally consumed.',
  },
  {
    name: 'workflow-recibo-invoice',
    product: 'factoring',
    owner: 'external',
    readiness: 'retired',
    triggers: ['boundary_event'],
    networks: [],
    steps: ['factoring_handoff', 'external_lock', 'settlement_callback'],
    reason:
      'Embedded Recibo invoice execution is retired in favor of the standalone factoring lifecycle.',
  },
  {
    name: 'workflow-factoring-lifecycle',
    product: 'factoring',
    owner: 'external',
    readiness: 'external_boundary',
    triggers: ['boundary_event'],
    networks: [],
    steps: ['eligibility', 'lock_receivable', 'fund', 'settle', 'reconcile'],
    reason:
      'Owned by the standalone chainlink-cre/fx-recibu integration; Desk observes handoff and callback boundaries.',
  },
  {
    name: 'workflow-payment-score-attest',
    product: 'factoring',
    owner: 'external',
    readiness: 'external_boundary',
    triggers: ['boundary_event'],
    networks: [],
    steps: ['snapshot', 'verify_memo_parity', 'publish_attestation'],
    reason:
      'No embedded workflow directory exists; the standalone CRE integration owns this attestation.',
  },
  {
    name: 'workflow-example',
    product: 'contract',
    owner: 'desk',
    readiness: 'example',
    triggers: ['http', 'cron', 'evm_log'],
    networks: sepolia,
    steps: ['example'],
    reason: 'Developer template only; never listing-eligible.',
  },
] as const;

export function creNetwork(selector: CREChainSelector): CRENetworkDefinition | undefined {
  return CRE_NETWORK_CATALOG.find(network => network.selector === selector);
}

export function creReceiverDeployment(
  selector: CREChainSelector,
  address: string
): CREReceiverDeployment | undefined {
  return CRE_RECEIVER_DEPLOYMENTS.find(
    deployment =>
      deployment.selector === selector && deployment.address.toLowerCase() === address.toLowerCase()
  );
}

export function creReceiverDeploymentPreflight(
  selector: CREChainSelector
): CREReceiverDeploymentPreflight | undefined {
  return CRE_RECEIVER_DEPLOYMENT_PREFLIGHTS.find(preflight => preflight.selector === selector);
}

export function creWorkflow(name: string): CREWorkflowDefinition | undefined {
  return CRE_WORKFLOW_CATALOG.find(workflow => workflow.name === name);
}

export function creWorkflowDeployment(
  workflow: string,
  selector: CREChainSelector
): CREWorkflowDeployment | undefined {
  return CRE_WORKFLOW_DEPLOYMENTS.find(
    deployment => deployment.workflow === workflow && deployment.selector === selector
  );
}
