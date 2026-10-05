// SPDX-License-Identifier: Apache-2.0
/**
 * Solana backend: Squads Smart Account Program (`SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG`).
 *
 * Layout, chosen so the weighted rule and the allowlist bind exactly as they do on EVM:
 *
 *   settings  signers = every owner, threshold = ALL owners, time_lock = adminTimelockSeconds.
 *             This is the admin path (owners, weights, allowlist). It is stricter than EVM, where
 *             the weighted quorum administers itself: Squads' SettingsChange policy cannot edit
 *             policies, so a weighted admin path needs a custom program (the v2 proposal).
 *
 *   policies  one SpendingLimit per (minimal winning coalition × asset):
 *             signers = the coalition, threshold = coalition size, destinations = allowlist.
 *             A group that reaches the weight threshold always contains a minimal coalition, so it
 *             can spend; a group that does not reach it contains none, so it cannot. Money only
 *             moves to wallets on the allowlist, like ColdStorageAddressBook.
 *
 * Output is plain data in the field names of Squads' generated SDK types
 * (`PolicyCreationPayload`, `SmartAccountSigner`), so any client can submit it.
 */
import { minimalWinningCoalitions } from '../coalitions'
import { SpecNotExpressible, type Period, type WeightedTreasurySpec } from '../spec'
import { validateSpec } from '../validate'

export const SMART_ACCOUNT_PROGRAM_ID = 'SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG'
/** `Pubkey::default()`: the program's marker for native SOL in a spending limit. */
export const NATIVE_SOL_MINT = '11111111111111111111111111111111'
/** Initiate | Vote | Execute. */
export const ALL_PERMISSIONS = 7
const U64_MAX = (1n << 64n) - 1n

export const DEFAULT_MAX_POLICIES = 64

export type SquadsPeriod =
  | { __kind: 'OneTime' }
  | { __kind: 'Daily' }
  | { __kind: 'Weekly' }
  | { __kind: 'Monthly' }
  | { __kind: 'Custom'; fields: [bigint] }

export interface SquadsSigner {
  key: string
  permissions: { mask: number }
}

export interface SquadsSpendingLimitPolicy {
  /** Owner ids of the coalition this policy encodes. Not on-chain; for audit and UI. */
  coalition: string[]
  asset: string
  signers: SquadsSigner[]
  threshold: number
  timeLock: number
  payload: {
    __kind: 'SpendingLimit'
    fields: [
      {
        mint: string
        sourceAccountIndex: number
        destinations: string[]
        timeConstraints: { start: bigint; expiration: bigint | null; period: SquadsPeriod; accumulateUnused: boolean }
        quantityConstraints: { maxPerPeriod: bigint; maxPerUse: bigint; enforceExactQuantity: boolean }
        usageState: null
      },
    ]
  }
}

export interface SquadsTreasuryPlan {
  programId: string
  settings: { signers: SquadsSigner[]; threshold: number; timeLock: number }
  /** In creation order. Policy seeds are assigned by the program: 1, 2, 3… on a fresh account. */
  policies: SquadsSpendingLimitPolicy[]
  /** Vault index the policies spend from. */
  sourceAccountIndex: number
  /** Where Squads semantics deliberately differ from EVM. Always surfaced, never hidden. */
  notes: string[]
}

export interface CompileSquadsOptions {
  /** Refuse specs that would need more policies than this. Default 64. */
  maxPolicies?: number
  sourceAccountIndex?: number
}

export function compileSquads(spec: WeightedTreasurySpec, options: CompileSquadsOptions = {}): SquadsTreasuryPlan {
  validateSpec(spec)
  const fail = (reason: string): never => {
    throw new SpecNotExpressible('squads', reason)
  }
  const maxPolicies = options.maxPolicies ?? DEFAULT_MAX_POLICIES
  const sourceAccountIndex = options.sourceAccountIndex ?? 0

  const keyOf = new Map<string, string>()
  for (const owner of spec.owners) {
    if (!owner.solana) fail(`owner "${owner.id}" has no Solana key`)
    if ([...keyOf.values()].includes(owner.solana!)) fail(`Solana key ${owner.solana} appears on two owners`)
    keyOf.set(owner.id, owner.solana!)
  }

  const destinations = [
    ...new Set(
      spec.allowlist.map((recipient, i) => recipient.solana ?? fail(`allowlist entry ${recipient.label ?? i} has no Solana wallet`)),
    ),
  ]
  // Belt and braces: validateSpec already refuses an empty allowlist. An empty destinations list
  // on Squads means "any address", so it must never reach the chain.
  if (destinations.length === 0) fail('empty destinations would allow any address')

  const coalitions = minimalWinningCoalitions(spec.owners, spec.thresholdWeight)
  const policyCount = coalitions.length * spec.assets.length
  if (policyCount > maxPolicies) {
    fail(`${coalitions.length} minimal coalitions × ${spec.assets.length} assets = ${policyCount} policies, over the cap of ${maxPolicies}; flatten the weights or reduce assets`)
  }

  const signerOf = (id: string): SquadsSigner => ({ key: keyOf.get(id)!, permissions: { mask: ALL_PERMISSIONS } })

  const policies: SquadsSpendingLimitPolicy[] = []
  for (const asset of spec.assets) {
    const mint = asset.solanaMint === 'native' ? NATIVE_SOL_MINT : (asset.solanaMint ?? fail(`${asset.symbol} has no Solana mint`))
    if (mint === NATIVE_SOL_MINT && asset.solanaDecimals !== undefined && asset.solanaDecimals !== 9) {
      fail('native SOL transfers require decimals = 9')
    }
    const budget = asset.budget
    for (const coalition of coalitions) {
      policies.push({
        coalition,
        asset: asset.symbol,
        signers: coalition.map(signerOf),
        threshold: coalition.length,
        timeLock: 0,
        payload: {
          __kind: 'SpendingLimit',
          fields: [
            {
              mint,
              sourceAccountIndex,
              destinations,
              timeConstraints: {
                start: 0n,
                expiration: null,
                period: budget ? toSquadsPeriod(budget.period) : { __kind: 'Daily' },
                accumulateUnused: false,
              },
              quantityConstraints: {
                // No budget in the spec = no cap, the same as the EVM weighted multisig.
                maxPerPeriod: budget ? budget.maxPerPeriod : U64_MAX,
                // 0 disables the per-use check in the program.
                maxPerUse: budget?.maxPerUse ?? 0n,
                enforceExactQuantity: false,
              },
              usageState: null,
            },
          ],
        },
      })
    }
  }

  const notes = [
    `admin (owners, weights, allowlist) requires ALL ${spec.owners.length} owners on Squads, stricter than the weighted quorum on EVM`,
    'the settings quorum (all owners) can also run arbitrary vault transactions, as the EVM quorum can by uninstalling the AddressBook',
    `${coalitions.length} minimal winning coalition(s) × ${spec.assets.length} asset(s) = ${policyCount} policies`,
  ]
  if (spec.adminTimelockSeconds === 0) notes.push('adminTimelockSeconds is 0: an approved admin change lands immediately')

  return {
    programId: SMART_ACCOUNT_PROGRAM_ID,
    settings: {
      signers: spec.owners.map((o) => signerOf(o.id)),
      threshold: spec.owners.length,
      timeLock: spec.adminTimelockSeconds,
    },
    policies,
    sourceAccountIndex,
    notes,
  }
}

function toSquadsPeriod(period: Period): SquadsPeriod {
  if (typeof period === 'object') return { __kind: 'Custom', fields: [BigInt(period.customSeconds)] }
  switch (period) {
    case 'oneTime':
      return { __kind: 'OneTime' }
    case 'daily':
      return { __kind: 'Daily' }
    case 'weekly':
      return { __kind: 'Weekly' }
    case 'monthly':
      return { __kind: 'Monthly' }
  }
}
