// SPDX-License-Identifier: Apache-2.0
/**
 * What the EVM side would do with a spend: Circle's weighted multisig (approver weight vs. threshold), the
 * ColdStorageAddressBook (recipient on the allowlist), and the ERC-20 transfer itself (enough balance).
 * Used to judge a Squads spend against the reference rule, so a disagreement is a real parity bug and an
 * underfunded transfer is not mistaken for one.
 */
import { isWinning, type WeightedMember } from './coalitions'

export function expectedSpendOutcome(input: {
  owners: readonly WeightedMember[]
  thresholdWeight: number
  approvers: ReadonlySet<string>
  destinationAllowlisted: boolean
  amount: bigint
  /** Token balance the treasury holds, in base units. */
  available: bigint
  /** Only for the human-readable reason. Default 0 (base units). */
  decimals?: number
}): { pass: boolean; why: string } {
  const { owners, thresholdWeight, approvers, destinationAllowlisted, amount, available, decimals = 0 } = input
  if (!isWinning(owners, thresholdWeight, approvers)) {
    const weight = owners.filter((o) => approvers.has(o.id)).reduce((sum, o) => sum + o.weight, 0)
    return { pass: false, why: `weight ${weight} < ${thresholdWeight}` }
  }
  if (!destinationAllowlisted) return { pass: false, why: 'destination is not on the allowlist' }
  if (amount > available) return { pass: false, why: `vault holds ${units(available, decimals)}, less than ${units(amount, decimals)}` }
  return { pass: true, why: 'weight reached, R is allowlisted' }
}

function units(value: bigint, decimals: number): string {
  if (decimals === 0) return value.toString()
  const base = 10n ** BigInt(decimals)
  const frac = (value % base).toString().padStart(decimals, '0').replace(/0+$/, '')
  return frac ? `${value / base}.${frac}` : `${value / base}`
}

/**
 * Seconds until an approved proposal can execute. Squads compares against the chain's Clock sysvar, so pass the
 * CHAIN's current unix time (e.g. `getBlockTime(getSlot())`), never the local wall clock.
 */
export function timelockRemaining(input: { approvedAt: number; timeLock: number; chainNow: number }): number {
  return Math.max(0, input.approvedAt + input.timeLock - input.chainNow)
}
