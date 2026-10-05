// SPDX-License-Identifier: Apache-2.0
import { MAX_WEIGHT, SpecNotExpressible, type WeightedTreasurySpec } from './spec'

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

export const isEvmAddress = (value: string): boolean => EVM_ADDRESS.test(value)
export const isSolanaKey = (value: string): boolean => BASE58.test(value)

/** Backend-independent checks. Throws `SpecNotExpressible('spec', …)` on the first problem. */
export function validateSpec(spec: WeightedTreasurySpec): void {
  const fail = (reason: string): never => {
    throw new SpecNotExpressible('spec', reason)
  }

  if (spec.version !== 1) fail(`unsupported spec version ${String(spec.version)}`)
  if (spec.owners.length === 0) fail('at least one owner is required')

  const ids = new Set<string>()
  let total = 0
  for (const owner of spec.owners) {
    if (ids.has(owner.id)) fail(`duplicate owner id "${owner.id}"`)
    ids.add(owner.id)
    if (!Number.isInteger(owner.weight) || owner.weight < 1 || owner.weight > MAX_WEIGHT) {
      fail(`owner "${owner.id}" weight must be an integer in [1, ${MAX_WEIGHT}]`)
    }
    if (owner.evm !== undefined && !isEvmAddress(owner.evm)) fail(`owner "${owner.id}" has an invalid EVM address`)
    if (owner.solana !== undefined && !isSolanaKey(owner.solana)) fail(`owner "${owner.id}" has an invalid Solana key`)
    total += owner.weight
  }

  if (!Number.isInteger(spec.thresholdWeight) || spec.thresholdWeight < 1 || spec.thresholdWeight > total) {
    fail(`thresholdWeight must be an integer in [1, ${total}] (the sum of owner weights)`)
  }

  // An empty allowlist means "nobody" in this spec. On Squads an empty destinations list means
  // "anybody", so emitting one would invert the meaning. Refuse it at the spec level.
  if (spec.allowlist.length === 0) fail('allowlist must not be empty (empty means nobody; Squads would read it as anybody)')

  if (spec.assets.length === 0) fail('at least one asset is required')
  for (const asset of spec.assets) {
    const budget = asset.budget
    if (!budget) continue
    if (budget.maxPerPeriod <= 0n) fail(`${asset.symbol}: budget.maxPerPeriod must be positive`)
    if (budget.maxPerUse !== undefined && (budget.maxPerUse <= 0n || budget.maxPerUse > budget.maxPerPeriod)) {
      fail(`${asset.symbol}: budget.maxPerUse must be in (0, maxPerPeriod]`)
    }
    if (typeof budget.period === 'object' && (!Number.isInteger(budget.period.customSeconds) || budget.period.customSeconds <= 0)) {
      fail(`${asset.symbol}: custom period must be a positive integer of seconds`)
    }
  }

  if (!Number.isInteger(spec.adminTimelockSeconds) || spec.adminTimelockSeconds < 0 || spec.adminTimelockSeconds > 0xffffffff) {
    fail('adminTimelockSeconds must be a u32')
  }
}
