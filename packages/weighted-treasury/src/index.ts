// SPDX-License-Identifier: Apache-2.0
/**
 * One weighted-multisig + recipient-allowlist treasury spec, two chains, same meaning.
 *
 *   compileEvm    → Circle MSCA (WeightedWebauthnMultisigPlugin + ColdStorageAddressBookPlugin)
 *   compileSquads → Squads Smart Account Program (settings + one SpendingLimit policy per
 *                   minimal winning coalition and asset, destinations = allowlist)
 *
 * Both compilers refuse a spec they cannot express exactly. They never emit a weaker policy.
 */
export * from './spec'
export { validateSpec, isEvmAddress, isSolanaKey } from './validate'
export { minimalWinningCoalitions, isWinning, MAX_ENUMERABLE_OWNERS, type WeightedMember } from './coalitions'
export { compileEvm, type EvmTreasuryConfig } from './evm'
export * from './squads/compile'
export * from './squads/sdk-args'
export * from './squads/flow'
