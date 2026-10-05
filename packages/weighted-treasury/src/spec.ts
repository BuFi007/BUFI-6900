// SPDX-License-Identifier: Apache-2.0
/**
 * The chain-neutral treasury spec: who can move money, and where it may go.
 *
 * One spec compiles to two backends with the same meaning:
 *   - EVM: Circle MSCA, WeightedWebauthnMultisigPlugin + ColdStorageAddressBookPlugin.
 *   - Solana: Squads Smart Account Program, one SpendingLimit policy per minimal winning
 *     coalition and asset, with the allowlist as each policy's destinations.
 *
 * Nothing here is vendor-specific. A signer is just a key per chain; a Circle user-controlled
 * wallet, a Ledger, a passkey-backed key or a plain keypair all fit.
 */

/** Circle's plugin bounds (`BaseWeightedMultisigPlugin`: _MAX_WEIGHT = 1_000_000, _MAX_OWNERS = 1000). */
export const MAX_WEIGHT = 1_000_000
export const MAX_EVM_OWNERS = 1000

export interface TreasuryOwner {
  /** Stable label for humans and logs. Not used on-chain. */
  id: string
  /** Integer in [1, MAX_WEIGHT]. */
  weight: number
  /** 20-byte EVM address (EOA or contract owner). Required to compile to EVM. */
  evm?: string
  /** Base58 ed25519 public key. Required to compile to Squads. */
  solana?: string
}

export interface AllowedRecipient {
  label?: string
  /** EVM recipient. */
  evm?: string
  /** Solana WALLET that must own the destination token account (not the token account itself). */
  solana?: string
}

export type Period = 'oneTime' | 'daily' | 'weekly' | 'monthly' | { customSeconds: number }

export interface TreasuryAsset {
  /** Display symbol, e.g. "USDC". */
  symbol: string
  /** Solana SPL mint, or `"native"` for SOL. Required to compile to Squads. */
  solanaMint?: string
  /** Token decimals on Solana. SOL must be 9. */
  solanaDecimals?: number
  /**
   * Optional cap per period for an approving quorum. The EVM weighted multisig has no budget
   * primitive, so a spec that sets one cannot compile to EVM with the same meaning, and the EVM
   * compiler refuses it (see `compileEvm`). Leave it unset for exact parity.
   */
  budget?: { maxPerPeriod: bigint; period: Period; maxPerUse?: bigint }
}

export interface WeightedTreasurySpec {
  version: 1
  owners: readonly TreasuryOwner[]
  /** Sum of approving weights must reach this. Integer in [1, sum(weights)]. */
  thresholdWeight: number
  /** Recipients money may go to. Must be non-empty: an empty list means "nobody" here. */
  allowlist: readonly AllowedRecipient[]
  /** Assets the treasury moves. On Squads, one policy per (coalition, asset). */
  assets: readonly TreasuryAsset[]
  /**
   * Seconds every admin change (owners, weights, allowlist) waits after approval. On Squads the
   * admin path is the settings quorum; on EVM Circle's plugins have no timelock, so a non-zero
   * value is a Squads-only hardening and is reported, not silently dropped.
   */
  adminTimelockSeconds: number
}

/** Thrown when a spec cannot be compiled to a backend with the same meaning. Never weaken; refuse. */
export class SpecNotExpressible extends Error {
  constructor(
    readonly backend: 'evm' | 'squads' | 'spec',
    readonly reason: string,
  ) {
    super(`[${backend}] ${reason}`)
    this.name = 'SpecNotExpressible'
  }
}
