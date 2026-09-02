/*
 * Copyright (c) 2026 BUFI. Licensed under the Apache License, Version 2.0.
 */
import { toFunctionSelector } from 'viem'

import {
  AGENT_ROLE_PRESETS,
  ARC_TESTNET_ERC8004_REGISTRIES,
  ARC_TESTNET_ERC8183_JOBS,
  DEFAULT_AGENT_GAS_BUDGET,
  buildBufiGrant,
  describeGrant,
  erc8004RaterGrant,
  erc8183BuyerGrant,
  erc8183ProviderGrant,
  floatFunderGrant,
  gatewayDepositorGrant,
} from '../../index'

import type { Address, Hex } from 'viem'

const USDC = '0x5425890298aed601595a70AB815c96711a31Bc65' as Address
const GATEWAY = '0x0077777d7EBA4688BDeF3E311b846F25870A19B9' as Address
const HOT_WALLET = '0x1111111111111111111111111111111111111111' as Address
const EXPIRY = { validUntil: 1_800_000_000 }
const BUDGET = { limit: 1_000_000_000n, refreshIntervalSeconds: 86_400 }

const SEL = {
  transfer: toFunctionSelector('function transfer(address,uint256)'),
  approve: toFunctionSelector('function approve(address,uint256)'),
  createJob: toFunctionSelector(
    'function createJob(address,address,uint256,string,address)',
  ),
  setBudget: toFunctionSelector('function setBudget(uint256,uint256,bytes)'),
  fund: toFunctionSelector('function fund(uint256,bytes)'),
  submit: toFunctionSelector('function submit(uint256,bytes32,bytes)'),
  complete: toFunctionSelector('function complete(uint256,bytes32,bytes)'),
  reject: toFunctionSelector('function reject(uint256,bytes32,bytes)'),
  deposit: toFunctionSelector('function deposit(address,uint256)'),
  depositFor: toFunctionSelector(
    'function depositFor(address,address,uint256)',
  ),
  giveFeedback: toFunctionSelector(
    'function giveFeedback(uint256,int128,uint8,string,string,string,string,bytes32)',
  ),
}

const targets = (g: ReturnType<typeof erc8183ProviderGrant>) =>
  g.scope.allow.map((e) => e.target.toLowerCase())
const selectorsFor = (
  g: ReturnType<typeof erc8183ProviderGrant>,
  target: Address,
): readonly Hex[] =>
  g.scope.allow.find((e) => e.target.toLowerCase() === target.toLowerCase())
    ?.selectors ?? []

describe('agent role grant presets', () => {
  describe('erc8183BuyerGrant', () => {
    it('scopes exactly the buyer legs and defaults the jobs contract to Arc', () => {
      const g = erc8183BuyerGrant({
        token: USDC,
        budget: BUDGET,
        expiry: EXPIRY,
      })
      expect(targets(g)).toEqual([
        USDC.toLowerCase(),
        ARC_TESTNET_ERC8183_JOBS.toLowerCase(),
      ])
      expect(selectorsFor(g, USDC)).toEqual([SEL.approve, SEL.transfer])
      expect(selectorsFor(g, ARC_TESTNET_ERC8183_JOBS)).toEqual([
        SEL.createJob,
        SEL.fund,
        SEL.reject,
      ])
      // The provider states the price, so the buyer never calls setBudget (proved on Arc: job 182422).
      expect(selectorsFor(g, ARC_TESTNET_ERC8183_JOBS)).not.toContain(SEL.setBudget)
    })

    it('excludes complete unless explicitly requested', () => {
      expect(
        selectorsFor(
          erc8183BuyerGrant({ token: USDC, budget: BUDGET, expiry: EXPIRY }),
          ARC_TESTNET_ERC8183_JOBS,
        ),
      ).not.toContain(SEL.complete)
      expect(
        selectorsFor(
          erc8183BuyerGrant({
            token: USDC,
            budget: BUDGET,
            expiry: EXPIRY,
            includeComplete: true,
          }),
          ARC_TESTNET_ERC8183_JOBS,
        ),
      ).toContain(SEL.complete)
    })

    it('carries the ERC-20 budget and the default gas budget', () => {
      const g = erc8183BuyerGrant({
        token: USDC,
        budget: BUDGET,
        expiry: EXPIRY,
      })
      expect(g.budget?.erc20).toEqual([
        { token: USDC, limit: BUDGET.limit, refreshIntervalSeconds: 86_400 },
      ])
      expect(g.budget?.gas).toEqual(DEFAULT_AGENT_GAS_BUDGET)
    })
  })

  describe('erc8183ProviderGrant', () => {
    it('scopes only setBudget and submit, and never spends', () => {
      const g = erc8183ProviderGrant({ expiry: EXPIRY })
      expect(targets(g)).toEqual([ARC_TESTNET_ERC8183_JOBS.toLowerCase()])
      expect(selectorsFor(g, ARC_TESTNET_ERC8183_JOBS)).toEqual([
        SEL.setBudget,
        SEL.submit,
      ])
      expect(g.budget?.erc20).toBeUndefined()
    })
  })

  describe('erc8004RaterGrant', () => {
    it('scopes giveFeedback on the reputation registry only', () => {
      const g = erc8004RaterGrant({ expiry: EXPIRY })
      expect(targets(g)).toEqual([
        ARC_TESTNET_ERC8004_REGISTRIES.reputation.toLowerCase(),
      ])
      expect(
        selectorsFor(g, ARC_TESTNET_ERC8004_REGISTRIES.reputation),
      ).toEqual([SEL.giveFeedback])
      expect(targets(g)).not.toContain(
        ARC_TESTNET_ERC8004_REGISTRIES.identity.toLowerCase(),
      )
    })
  })

  describe('floatFunderGrant', () => {
    it('scopes transfer only and requires a recipient', () => {
      const g = floatFunderGrant({
        token: USDC,
        recipients: [HOT_WALLET],
        budget: BUDGET,
        expiry: EXPIRY,
      })
      expect(targets(g)).toEqual([USDC.toLowerCase()])
      expect(selectorsFor(g, USDC)).toEqual([SEL.transfer])
      expect(() =>
        floatFunderGrant({
          token: USDC,
          recipients: [],
          budget: BUDGET,
          expiry: EXPIRY,
        }),
      ).toThrow(/at least one recipient/)
    })
  })

  describe('gatewayDepositorGrant', () => {
    it('scopes approve plus the two deposit entry points, and no burn intent path', () => {
      const g = gatewayDepositorGrant({
        gatewayWallet: GATEWAY,
        token: USDC,
        budget: BUDGET,
        expiry: EXPIRY,
      })
      expect(selectorsFor(g, USDC)).toEqual([SEL.approve])
      expect(selectorsFor(g, GATEWAY)).toEqual([SEL.deposit, SEL.depositFor])
    })
  })

  describe('buildBufiGrant compatibility', () => {
    it.each([
      [
        'buyer',
        erc8183BuyerGrant({ token: USDC, budget: BUDGET, expiry: EXPIRY }),
      ],
      ['provider', erc8183ProviderGrant({ expiry: EXPIRY })],
      ['rater', erc8004RaterGrant({ expiry: EXPIRY })],
      [
        'float',
        floatFunderGrant({
          token: USDC,
          recipients: [HOT_WALLET],
          budget: BUDGET,
          expiry: EXPIRY,
        }),
      ],
      [
        'gateway',
        gatewayDepositorGrant({
          gatewayWallet: GATEWAY,
          token: USDC,
          budget: BUDGET,
          expiry: EXPIRY,
        }),
      ],
    ])('compiles %s into permission updates', (_name, g) => {
      const updates = buildBufiGrant(g)
      expect(updates.length).toBeGreaterThan(2)
      expect(updates.every((u) => u.startsWith('0x'))).toBe(true)
    })

    it('keeps a stable update order: access list type, entries, budgets, time range', () => {
      const updates = buildBufiGrant(
        erc8183BuyerGrant({ token: USDC, budget: BUDGET, expiry: EXPIRY }),
      )
      // The first update always sets the list type; the last always sets the validity window.
      expect(updates[0].length).toBeGreaterThan(2)
      expect(updates.at(-1)).toBeDefined()
    })
  })

  describe('AGENT_ROLE_PRESETS', () => {
    it('names the plugins and AddressBook entries each role depends on', () => {
      const buyer = AGENT_ROLE_PRESETS.find((p) => p.role === 'erc8183-buyer')
      expect(buyer?.plugins).toContain('recipientHook')
      expect(buyer?.addressBookRecipients).toContain('jobContract')
      const provider = AGENT_ROLE_PRESETS.find(
        (p) => p.role === 'erc8183-provider',
      )
      expect(provider?.addressBookRecipients).toEqual([])
      expect(AGENT_ROLE_PRESETS).toHaveLength(5)
    })
  })

  describe('describeGrant', () => {
    it('renders scope, budgets and expiry for an approval prompt', () => {
      expect(
        describeGrant(
          erc8183BuyerGrant({
            token: USDC,
            budget: BUDGET,
            expiry: EXPIRY,
            requiredPaymaster: GATEWAY,
          }),
        ),
      ).toMatchSnapshot()
    })
  })
})
