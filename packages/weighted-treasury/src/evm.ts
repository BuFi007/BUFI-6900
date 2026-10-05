// SPDX-License-Identifier: Apache-2.0
/**
 * EVM backend: Circle MSCA with WeightedWebauthnMultisigPlugin + ColdStorageAddressBookPlugin.
 *
 * Output matches the install inputs those plugins take (owners with weights, a threshold weight,
 * the AddressBook seed list) and the `@bufi6900/treasury-kit` `DeployTreasuryInput` fields of the
 * same names, so any deployer for that stack can consume it.
 */
import { MAX_EVM_OWNERS, SpecNotExpressible, type WeightedTreasurySpec } from './spec'
import { validateSpec } from './validate'

export interface EvmTreasuryConfig {
  owners: { address: string; weight: bigint }[]
  thresholdWeight: bigint
  /** ColdStorageAddressBookPlugin seed. Lower-cased and de-duplicated. */
  allowlist: string[]
  /** Spec features with no EVM equivalent that were NOT required for parity. Informational. */
  notes: string[]
}

export function compileEvm(spec: WeightedTreasurySpec): EvmTreasuryConfig {
  validateSpec(spec)
  const fail = (reason: string): never => {
    throw new SpecNotExpressible('evm', reason)
  }

  if (spec.owners.length > MAX_EVM_OWNERS) fail(`more than ${MAX_EVM_OWNERS} owners`)

  const owners = spec.owners.map((owner) => {
    if (!owner.evm) return fail(`owner "${owner.id}" has no EVM address`)
    return { address: owner.evm.toLowerCase(), weight: BigInt(owner.weight) }
  })
  const seen = new Set<string>()
  for (const { address } of owners) {
    if (seen.has(address)) fail(`EVM address ${address} appears on two owners`)
    seen.add(address)
  }

  const allowlist = [
    ...new Set(
      spec.allowlist.map((recipient, i) => {
        if (!recipient.evm) return fail(`allowlist entry ${recipient.label ?? i} has no EVM address`)
        return recipient.evm.toLowerCase()
      }),
    ),
  ]

  // The weighted multisig authorises any amount to an allowlisted recipient. A per-period budget
  // has no plugin to enforce it, so compiling it would silently drop it. Refuse instead.
  for (const asset of spec.assets) {
    if (asset.budget) fail(`${asset.symbol}: per-period budgets have no EVM enforcement on the weighted multisig; remove the budget or enforce it with a session-key grant`)
  }

  const notes: string[] = []
  if (spec.adminTimelockSeconds > 0) {
    notes.push(`adminTimelockSeconds=${spec.adminTimelockSeconds} applies on Squads only; Circle's weighted multisig executes admin changes immediately`)
  }

  return { owners, thresholdWeight: BigInt(spec.thresholdWeight), allowlist, notes }
}
