/*
 * Copyright (c) 2026 BUFI. Licensed under the Apache License, Version 2.0.
 */
import { toFunctionSelector } from 'viem'

import {
  ARC_TESTNET_ERC8004_REGISTRIES,
  ARC_TESTNET_ERC8183_JOBS,
} from '../constants/deployments'

import type {
  AgentRolePresetMeta,
  BufiGrant,
  BufiGrantExpiry,
  BufiGrantScopeEntry,
  BufiGrantSpendBudget,
  Erc8004RaterGrantParameters,
  Erc8183BuyerGrantParameters,
  Erc8183ProviderGrantParameters,
  FloatFunderGrantParameters,
  GatewayDepositorGrantParameters,
} from '../types/bufi'
import type { Address, Hex } from 'viem'

/**
 * The default gas budget for an agent role: 0.5 native token per 24 hours. Gas is charged against the account at
 * validation time (EntryPoint v0.7 required prefund), so this is the ceiling on what a compromised key can burn
 * even when every one of its operations reverts.
 */
export const DEFAULT_AGENT_GAS_BUDGET: BufiGrantSpendBudget = {
  limit: 500_000_000_000_000_000n,
  refreshIntervalSeconds: 86_400,
}

/** ERC-20 selectors an agent may be scoped to. */
export const ERC20_TRANSFER_SELECTOR = toFunctionSelector(
  'function transfer(address,uint256)',
)
export const ERC20_APPROVE_SELECTOR = toFunctionSelector(
  'function approve(address,uint256)',
)

/** Native ERC-8183 job selectors, as BUFI drives them (see `apps/shiva` `w2w-onchain.service.ts` in desk). */
export const ERC8183_SELECTORS = {
  createJob: toFunctionSelector(
    'function createJob(address,address,uint256,string,address)',
  ),
  setBudget: toFunctionSelector('function setBudget(uint256,uint256,bytes)'),
  fund: toFunctionSelector('function fund(uint256,bytes)'),
  submit: toFunctionSelector('function submit(uint256,bytes32,bytes)'),
  complete: toFunctionSelector('function complete(uint256,bytes32,bytes)'),
  reject: toFunctionSelector('function reject(uint256,bytes32,bytes)'),
} as const

/**
 * The ERC-8004 reputation registry's feedback entry point, as pinned by desk's
 * `packages/services/src/agent-reputation.test.ts`.
 */
export const ERC8004_GIVE_FEEDBACK_SIGNATURE =
  'function giveFeedback(uint256,int128,uint8,string,string,string,string,bytes32)' as const

/** Circle Gateway deposit entry points (`IGatewayWallet`). */
export const GATEWAY_SELECTORS = {
  deposit: toFunctionSelector('function deposit(address,uint256)'),
  depositFor: toFunctionSelector(
    'function depositFor(address,address,uint256)',
  ),
} as const

function grant(
  scope: readonly BufiGrantScopeEntry[],
  expiry: BufiGrantExpiry,
  erc20?: { token: Address; budget: BufiGrantSpendBudget },
  gas: BufiGrantSpendBudget = DEFAULT_AGENT_GAS_BUDGET,
  requiredPaymaster?: Address,
): BufiGrant {
  return {
    scope: { allow: scope },
    budget: {
      ...(erc20
        ? {
            erc20: [
              {
                token: erc20.token,
                limit: erc20.budget.limit,
                refreshIntervalSeconds: erc20.budget.refreshIntervalSeconds,
              },
            ],
          }
        : {}),
      gas,
    },
    expiry,
    ...(requiredPaymaster ? { requiredPaymaster } : {}),
  }
}

/**
 * The buyer side of an ERC-8183 job: create, budget, fund and reject, plus the ERC-20 legs those need.
 *
 * `complete` is deliberately excluded by default — it is the evaluator's decision to release escrowed funds, which
 * belongs to the owner quorum rather than to the agent. Pass `includeComplete` only for an agent you are willing to
 * let settle its own jobs.
 *
 * The jobs contract MUST be in the account's AddressBook: `approve(jobs, …)` is checked by
 * `BufiSessionRecipientHookPlugin`, which treats an approval's spender as the recipient. Note the accepted
 * limitation (adversarial finding F-02): an allowlisted spender can forward the allowance anywhere, so only
 * escrow-style contracts belong on that list.
 */
export function erc8183BuyerGrant({
  jobContract = ARC_TESTNET_ERC8183_JOBS,
  token,
  budget,
  expiry,
  gas,
  requiredPaymaster,
  includeComplete = false,
}: Erc8183BuyerGrantParameters): BufiGrant {
  const jobSelectors: Hex[] = [
    ERC8183_SELECTORS.createJob,
    ERC8183_SELECTORS.setBudget,
    ERC8183_SELECTORS.fund,
    ERC8183_SELECTORS.reject,
    ...(includeComplete ? [ERC8183_SELECTORS.complete] : []),
  ]
  return grant(
    [
      {
        target: token,
        selectors: [ERC20_APPROVE_SELECTOR, ERC20_TRANSFER_SELECTOR],
      },
      { target: jobContract, selectors: jobSelectors },
    ],
    expiry,
    { token, budget },
    gas,
    requiredPaymaster,
  )
}

/**
 * The provider side of an ERC-8183 job: set the budget it is willing to work for and submit the deliverable. A
 * provider never spends, so the grant carries a gas budget only.
 */
export function erc8183ProviderGrant({
  jobContract = ARC_TESTNET_ERC8183_JOBS,
  expiry,
  gas,
  requiredPaymaster,
}: Erc8183ProviderGrantParameters): BufiGrant {
  return grant(
    [
      {
        target: jobContract,
        selectors: [ERC8183_SELECTORS.setBudget, ERC8183_SELECTORS.submit],
      },
    ],
    expiry,
    undefined,
    gas,
    requiredPaymaster,
  )
}

/**
 * Rating a counterparty on the ERC-8004 reputation registry. Minting the agent's own identity (`register`) is an
 * owner operation performed when the face is born, never a session-key power.
 *
 * Eligibility (different workspaces, mutually accepted relationship, a settled workflow) is an application rule and
 * is NOT enforced on-chain by this grant.
 */
export function erc8004RaterGrant({
  reputationRegistry = ARC_TESTNET_ERC8004_REGISTRIES.reputation,
  giveFeedbackSignature = ERC8004_GIVE_FEEDBACK_SIGNATURE,
  expiry,
  gas,
  requiredPaymaster,
}: Erc8004RaterGrantParameters): BufiGrant {
  return grant(
    [
      {
        target: reputationRegistry,
        selectors: [toFunctionSelector(giveFeedbackSignature)],
      },
    ],
    expiry,
    undefined,
    gas,
    requiredPaymaster,
  )
}

/**
 * Topping up a hot signer under budget: the x402 signer that produces EIP-3009 authorizations, or the funding
 * wallet behind scoped cards.
 *
 * A session key can never sign those payments itself. X402 authorizations and Gateway burn intents are ERC-1271
 * signatures, and ERC-1271 on a Circle account routes to the ownership plugin — the session-key plugin is not
 * consulted. The agent therefore funds a small hot wallet and that wallet signs; the plugin bounds how much and
 * how often. `recipients` is informational here: enforcement comes from the AddressBook via the recipient hook,
 * so every entry must also be allowlisted on the account.
 * @throws If `recipients` is empty — a float funder with no destination is always a mistake.
 */
export function floatFunderGrant({
  token,
  recipients,
  budget,
  expiry,
  gas,
  requiredPaymaster,
}: FloatFunderGrantParameters): BufiGrant {
  if (recipients.length === 0) {
    throw new Error('A float funder grant must name at least one recipient.')
  }
  return grant(
    [{ target: token, selectors: [ERC20_TRANSFER_SELECTOR] }],
    expiry,
    { token, budget },
    gas,
    requiredPaymaster,
  )
}

/**
 * Funding a Circle Gateway position under budget. The agent may move USDC INTO the account's (or another
 * depositor's) Gateway balance; it can never move that balance cross-chain, because a burn intent is an ERC-1271
 * signature validated against the ownership plugin. See `docs/GATEWAY-1271-EVALUATION.md`.
 */
export function gatewayDepositorGrant({
  gatewayWallet,
  token,
  budget,
  expiry,
  gas,
  requiredPaymaster,
}: GatewayDepositorGrantParameters): BufiGrant {
  return grant(
    [
      { target: token, selectors: [ERC20_APPROVE_SELECTOR] },
      {
        target: gatewayWallet,
        selectors: [GATEWAY_SELECTORS.deposit, GATEWAY_SELECTORS.depositFor],
      },
    ],
    expiry,
    { token, budget },
    gas,
    requiredPaymaster,
  )
}

/**
 * Metadata for each role, for approval UIs and for the service that provisions agent faces: which plugins the
 * account needs, and which addresses must be on its AddressBook for the grant to be usable.
 */
export const AGENT_ROLE_PRESETS: readonly AgentRolePresetMeta[] = [
  {
    role: 'erc8183-buyer',
    description:
      'Create, budget and fund ERC-8183 jobs; reject a bad delivery. Settling (complete) stays with the owners.',
    plugins: ['bufiSessionKey', 'coldStorageAddressBook', 'recipientHook'],
    addressBookRecipients: ['jobContract', 'providerAccount'],
  },
  {
    role: 'erc8183-provider',
    description:
      'Set the accepted budget and submit deliverables. Never spends.',
    plugins: ['bufiSessionKey'],
    addressBookRecipients: [],
  },
  {
    role: 'erc8004-rater',
    description:
      'Rate a counterparty on the ERC-8004 reputation registry. Identity minting stays an owner operation.',
    plugins: ['bufiSessionKey'],
    addressBookRecipients: [],
  },
  {
    role: 'float-funder',
    description:
      'Top up an x402 signer or a card funding wallet under budget. The hot wallet signs; the agent only funds it.',
    plugins: ['bufiSessionKey', 'coldStorageAddressBook', 'recipientHook'],
    addressBookRecipients: ['hotWallet'],
  },
  {
    role: 'gateway-depositor',
    description:
      'Fund a Circle Gateway position. Burn intents are owner-signed (ERC-1271) and are not reachable by a key.',
    plugins: ['bufiSessionKey', 'coldStorageAddressBook', 'recipientHook'],
    addressBookRecipients: ['gatewayWallet'],
  },
] as const

/**
 * Human-readable lines describing a grant, for approval prompts. Amounts are printed in base units: the caller
 * knows the token's decimals, this module does not.
 */
export function describeGrant(grant_: BufiGrant): string[] {
  const lines: string[] = []
  for (const entry of grant_.scope.allow) {
    lines.push(
      entry.selectors && entry.selectors.length > 0
        ? `may call ${entry.selectors.join(', ')} on ${entry.target}`
        : `may call any function on ${entry.target}`,
    )
  }
  for (const erc20 of grant_.budget?.erc20 ?? []) {
    lines.push(
      `may spend up to ${erc20.limit} of ${erc20.token} per ${erc20.refreshIntervalSeconds}s`,
    )
  }
  if (grant_.budget?.native) {
    lines.push(
      `may spend up to ${grant_.budget.native.limit} wei of native token per ${grant_.budget.native.refreshIntervalSeconds}s`,
    )
  }
  if (grant_.budget?.gas) {
    lines.push(
      `may consume up to ${grant_.budget.gas.limit} wei of gas per ${grant_.budget.gas.refreshIntervalSeconds}s`,
    )
  }
  const validAfter = grant_.expiry.validAfter ?? 0
  lines.push(
    validAfter > 0
      ? `valid from ${validAfter} until ${grant_.expiry.validUntil}`
      : `valid until ${grant_.expiry.validUntil}`,
  )
  if (grant_.requiredPaymaster) {
    lines.push(`must be sponsored by ${grant_.requiredPaymaster}`)
  }
  return lines
}
