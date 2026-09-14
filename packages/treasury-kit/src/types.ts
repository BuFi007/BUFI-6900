/**
 * @bufi6900/treasury-kit — the public shapes. This file is the interface
 * contract between the kit (`packages/treasury-kit`) and the agent app
 * (`apps/agent`); both were built against it in parallel. Change it here first.
 */
import type { Address, Hex } from 'viem'

// ─── chains ─────────────────────────────────────────────────────────────────

/** Chains a BUFI treasury can live on. Keys are Circle blockchain ids. */
export type TreasuryChainKey =
  | 'LOCAL'
  | 'ARC-TESTNET'
  | 'AVAX-FUJI'
  | 'ARB-SEPOLIA'
  | 'BASE-SEPOLIA'
  | 'ARC'
  | 'AVAX'

export interface TreasuryChain {
  key: TreasuryChainKey
  chainId: number
  /** Circle Modular Wallets URL path segment (`/arcTestnet`, `/avalancheFuji`, …); `null` on LOCAL (mock). */
  modularPath: string | null
  rpcUrl: string
  /** Stack addresses (EntryPoint, factory, plugins) — from `contracts/deployments/*.json`. */
  deploymentFile: string
  usdc: Address
  eurc?: Address
  /** ERC-3009 EIP-712 domain of the stablecoin(s), as Circle deployed them. */
  erc3009Domain: Record<string, { name: string; version: string }>
  /** TreasuryConduit address once deployed on this chain; `null` until then. */
  conduit: Address | null
  /** Protocol targets registered on the conduit for this chain (router, vault…). */
  targets: Record<string, Address>
  explorer?: string
}

// ─── treasury ───────────────────────────────────────────────────────────────

export interface TreasuryOwner {
  address: Address
  weight: bigint
}

export interface DeployTreasuryInput {
  /** Which chains to deploy on. Same address on every chain when the bootstrap owner and salt match. */
  chains: readonly TreasuryChainKey[]
  /** The owner set the quorum ends up with. The first owner is the bootstrap signer that creates the account. */
  owners: readonly TreasuryOwner[]
  thresholdWeight: bigint
  /** Seeded on the ColdStorageAddressBook at birth (fee recipient, member wallets, the conduit…). */
  allowlist: readonly Address[]
  /** Deterministic salt for the account address. */
  salt?: Hex
  /** Signs the bootstrap userOps (the first owner). */
  signer: OwnerSigner
}

export interface DeployedTreasury {
  chain: TreasuryChainKey
  address: Address
  owners: readonly TreasuryOwner[]
  thresholdWeight: bigint
  allowlist: readonly Address[]
  /** userOp hashes: create+weights, address book. */
  userOpHashes: readonly Hex[]
}

export type DeployTreasuryResult = {
  deployed: readonly DeployedTreasury[]
  failed: readonly { chain: TreasuryChainKey; error: string }[]
}

// ─── signing ────────────────────────────────────────────────────────────────

/** One owner able to sign digests: a local key in the demo, a passkey/Ledger in production. */
export interface OwnerSigner {
  address: Address
  /** Raw ECDSA over a 32-byte digest, returned as 65-byte r‖s‖v. */
  signDigest(digest: Hex): Promise<Hex>
}

/** A quorum: enough owners to reach the threshold, sorted the way the plugin expects. */
export interface Quorum {
  treasury: Address
  chain: TreasuryChainKey
  owners: readonly OwnerSigner[]
}

// ─── agent face ─────────────────────────────────────────────────────────────

export interface AgentGrant {
  /** Targets and selectors the session key may call. The conduit + `execute` is the swap/earn grant. */
  allow: readonly { target: Address; selectors?: readonly Hex[] }[]
  erc20Budget?: readonly { token: Address; limit: bigint; refreshIntervalSeconds: number }[]
  gasBudget?: { limit: bigint; refreshIntervalSeconds: number }
  validUntil: number
}

export interface DeployAgentFaceInput {
  chain: TreasuryChainKey
  /** The treasury that owns the agent account (nested ERC-1271 owner). */
  treasury: Address
  quorum: Quorum
  /** The agent's session key address. */
  sessionKey: Address
  grant: AgentGrant
  salt?: Hex
}

export interface DeployedAgentFace {
  chain: TreasuryChainKey
  address: Address
  sessionKey: Address
  grant: AgentGrant
  userOpHashes: readonly Hex[]
}

// ─── conduit ────────────────────────────────────────────────────────────────

export interface ConduitIntent {
  target: Address
  data: Hex
  tokenIn: Address
  amountIn: bigint
  tokenOut: Address
  minOut: bigint
  beneficiary: Address
  deadline: bigint
}

export interface ConduitAuthorization {
  token: Address
  from: Address
  value: bigint
  validAfter: bigint
  validBefore: bigint
  nonce: Hex
}

/** What the quorum reviews before signing. Human-readable, one line per fact. */
export interface ConduitFacts {
  kind: 'swap' | 'earn-deposit' | 'earn-withdraw' | 'custom'
  chain: TreasuryChainKey
  treasury: Address
  target: Address
  spend: { token: Address; symbol: string; amount: string }
  receive: { token: Address; symbol: string; minimum: string }
  deadline: string
  lines: readonly string[]
}

export interface ConduitRequest {
  chain: TreasuryChainKey
  intent: ConduitIntent
  authorization: ConduitAuthorization
  facts: ConduitFacts
}

/** A request the quorum approved: ready to submit by anyone. */
export interface ApprovedConduitRequest extends ConduitRequest {
  quorumSignature: Hex
  /** `conduit.execute(auth, sig, intent)` calldata. */
  calldata: Hex
}

export interface ConduitReceipt {
  chain: TreasuryChainKey
  txHash: Hex
  gained: bigint
  tokenOut: Address
}

/** Pods bytecode-API shape (`action`, `bytecode`, `destinationAddress`) adapted to an intent. */
export interface PodsBytecodeInput {
  action: 'lend' | 'withdraw'
  /** The protocol target Pods' calldata is for. */
  to: Address
  /** Pods' `bytecode` field: the calldata. */
  bytecode: Hex
  tokenIn: Address
  amountIn: bigint
  /** The receipt token (aToken / vault share) the treasury must gain. */
  tokenOut: Address
  minOut: bigint
  /** Must be the treasury — Pods maps it to `onBehalfOf` / `to` once their fix ships. */
  destinationAddress: Address
}
