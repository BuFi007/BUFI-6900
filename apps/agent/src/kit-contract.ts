/**
 * The slice of `@bufi6900/treasury-kit` this app calls, typed against the kit's
 * own `types.ts` (the fixed interface contract). The kit is built in parallel;
 * `kit.ts` binds this shape to the real package or to `kit-stub.ts`.
 *
 * Only the names in the kit README are used here, spelled exactly as it lists
 * them. When the kit lands, nothing in this file should need to change.
 */
import type { Address, Hex } from 'viem'
import type {
  AgentGrant,
  ApprovedConduitRequest,
  ConduitIntent,
  ConduitReceipt,
  ConduitRequest,
  DeployAgentFaceInput,
  DeployedAgentFace,
  DeployTreasuryInput,
  DeployTreasuryResult,
  OwnerSigner,
  PodsBytecodeInput,
  Quorum,
  TreasuryChain,
  TreasuryChainKey,
  TreasuryOwner,
} from '../../../packages/treasury-kit/src/types.js'

export type {
  AgentGrant,
  ApprovedConduitRequest,
  ConduitAuthorization,
  ConduitFacts,
  ConduitIntent,
  ConduitReceipt,
  ConduitRequest,
  DeployAgentFaceInput,
  DeployedAgentFace,
  DeployedTreasury,
  DeployTreasuryInput,
  DeployTreasuryResult,
  OwnerSigner,
  PodsBytecodeInput,
  Quorum,
  TreasuryChain,
  TreasuryChainKey,
  TreasuryOwner,
} from '../../../packages/treasury-kit/src/types.js'

/**
 * Environment the kit reads its transports from. Described in the kit README
 * (`KitEnv`) but not exported from `types.ts`, so it is restated here structurally.
 */
export interface KitEnv {
  circleClientUrl?: string
  circleClientKey?: string
  mockCircleUrl?: string
  rpcUrls?: Partial<Record<TreasuryChainKey, string>>
}

/** Who submits an approved conduit request. Mirrors the kit's `SubmitVia`. */
export type SubmitVia =
  | { kind: 'eoa'; privateKey: Hex }
  | { kind: 'agent'; agent: Address; sessionKey: OwnerSigner }

/** Input of the kit's `buildSwapRequest`. */
export interface BuildSwapRequestInput {
  chain: TreasuryChainKey
  treasury: Address
  tokenIn: 'USDC' | 'EURC'
  tokenOut: 'USDC' | 'EURC'
  amountIn: bigint
  minOut: bigint
  validForSeconds?: number
  /** Router calldata for `target`, receiver = the conduit (swept to the treasury). */
  route: { target: Address; data: Hex; label: string }
}

/** Input of the kit's `buildEarnDepositRequest`. */
export interface BuildEarnDepositRequestInput {
  chain: TreasuryChainKey
  treasury: Address
  vault: Address
  token: 'USDC' | 'EURC'
  amountIn: bigint
  minShares: bigint
  validForSeconds?: number
}

/** Input of the kit's `buildFromPodsBytecode`. */
export type BuildFromPodsBytecodeInput = PodsBytecodeInput & {
  chain: TreasuryChainKey
  treasury: Address
  validForSeconds?: number
}

/** What `treasuryStatus` reports for one chain. */
export interface TreasuryStatusReport {
  deployed: boolean
  owners: readonly TreasuryOwner[]
  thresholdWeight: bigint
  allowlist: readonly Address[]
  /** symbol → atomic units */
  balances: Record<string, bigint>
}

/** The kit surface the agent app uses. Function names and shapes follow the kit README verbatim. */
export interface TreasuryKit {
  CHAINS: Record<TreasuryChainKey, TreasuryChain>
  getChain(key: TreasuryChainKey): TreasuryChain
  withConduit(chain: TreasuryChain, conduit: Address, targets: Record<string, Address>): TreasuryChain
  localKeySigner(privateKey: Hex): OwnerSigner
  deployTreasury(input: DeployTreasuryInput, env: KitEnv): Promise<DeployTreasuryResult>
  treasuryStatus(chain: TreasuryChainKey, treasury: Address, env: KitEnv): Promise<TreasuryStatusReport>
  conduitExecutorGrant(input: {
    conduit: Address
    validUntil: number
    gasBudget?: { limit: bigint; refreshIntervalSeconds: number }
  }): AgentGrant
  deployAgentFace(input: DeployAgentFaceInput, env: KitEnv): Promise<DeployedAgentFace>
  intentNonce(intent: ConduitIntent): Hex
  buildSwapRequest(input: BuildSwapRequestInput): ConduitRequest
  buildEarnDepositRequest(input: BuildEarnDepositRequestInput): ConduitRequest
  buildFromPodsBytecode(input: BuildFromPodsBytecodeInput): ConduitRequest
  approveWithQuorum(request: ConduitRequest, quorum: Quorum, env: KitEnv): Promise<ApprovedConduitRequest>
  submitApproved(approved: ApprovedConduitRequest, via: SubmitVia, env: KitEnv): Promise<ConduitReceipt>
}
