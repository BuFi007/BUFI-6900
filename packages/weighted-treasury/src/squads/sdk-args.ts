// SPDX-License-Identifier: Apache-2.0
/**
 * Turns a `SquadsTreasuryPlan` into the argument objects `@sqds/smart-account` expects.
 *
 * The SDK's runtime types (`PublicKey` from @solana/web3.js, `BN` from bn.js) are injected rather
 * than imported, so this package has no Solana dependency and a caller can pass the exact
 * instances its SDK build uses (two copies of web3.js break `instanceof` checks).
 */
import type { SquadsPeriod, SquadsSigner, SquadsSpendingLimitPolicy, SquadsTreasuryPlan } from './compile'

export interface SolanaRuntime<PK, BNT> {
  PublicKey: new (value: string) => PK
  BN: new (value: string) => BNT
}

export function toSdkSigners<PK>(signers: readonly SquadsSigner[], rt: Pick<SolanaRuntime<PK, unknown>, 'PublicKey'>) {
  return signers.map((s) => ({ key: new rt.PublicKey(s.key), permissions: { mask: s.permissions.mask } }))
}

function toSdkPeriod<BNT>(period: SquadsPeriod, rt: Pick<SolanaRuntime<unknown, BNT>, 'BN'>) {
  return period.__kind === 'Custom' ? { __kind: 'Custom' as const, fields: [new rt.BN(period.fields[0].toString())] as [BNT] } : period
}

/** One `SettingsAction::PolicyCreate` per policy, in plan order. `seed` is the program-assigned seed. */
export function toSdkPolicyCreateAction<PK, BNT>(policy: SquadsSpendingLimitPolicy, seed: number, rt: SolanaRuntime<PK, BNT>) {
  const f = policy.payload.fields[0]
  return {
    __kind: 'PolicyCreate' as const,
    seed,
    policyCreationPayload: {
      __kind: 'SpendingLimit' as const,
      fields: [
        {
          mint: new rt.PublicKey(f.mint),
          sourceAccountIndex: f.sourceAccountIndex,
          destinations: f.destinations.map((d) => new rt.PublicKey(d)),
          timeConstraints: {
            start: new rt.BN(f.timeConstraints.start.toString()),
            expiration: f.timeConstraints.expiration === null ? null : new rt.BN(f.timeConstraints.expiration.toString()),
            period: toSdkPeriod(f.timeConstraints.period, rt),
            accumulateUnused: f.timeConstraints.accumulateUnused,
          },
          quantityConstraints: {
            maxPerPeriod: new rt.BN(f.quantityConstraints.maxPerPeriod.toString()),
            maxPerUse: new rt.BN(f.quantityConstraints.maxPerUse.toString()),
            enforceExactQuantity: f.quantityConstraints.enforceExactQuantity,
          },
          usageState: null,
        },
      ],
    },
    signers: toSdkSigners(policy.signers, rt),
    threshold: policy.threshold,
    timeLock: policy.timeLock,
    startTimestamp: null,
    expirationArgs: null,
  }
}

/**
 * All PolicyCreate actions for a FRESH smart account (policy seeds start at 1).
 * For an account that already has policies, pass `firstSeed = settings.policySeed + 1`.
 */
export function toSdkPolicyCreateActions<PK, BNT>(plan: SquadsTreasuryPlan, rt: SolanaRuntime<PK, BNT>, firstSeed = 1) {
  return plan.policies.map((policy, i) => toSdkPolicyCreateAction(policy, firstSeed + i, rt))
}
