/**
 * Read-only quotes the swap and Earn tools need to set a floor (`minOut` /
 * `minShares`) when the user gives a slippage instead of an explicit minimum.
 *
 * The demo venue is the sandbox `MockSwapRouter` (`rateBps()`), and any
 * ERC-4626 vault answers `previewDeposit`. Under `AGENT_KIT=stub` the stub
 * quoter mirrors the stub kit's venue so the story runs without a chain.
 */
import { createPublicClient, encodeFunctionData, http, parseAbi, type Address, type Hex } from 'viem'
import type { TreasuryChain } from './kit-contract.js'

/** Where quotes come from. */
export interface Quoter {
  /** Rate of `tokenIn → tokenOut` on `router`, in basis points of tokenOut per tokenIn. */
  routerRateBps(chain: TreasuryChain, router: Address, tokenIn: Address, tokenOut: Address): Promise<bigint>
  /** Shares an ERC-4626 vault would mint for `assets` right now. */
  previewDeposit(chain: TreasuryChain, vault: Address, assets: bigint): Promise<bigint>
}

/** ABI of the sandbox `MockSwapRouter` (the only swap venue the demo routes through). */
export const MOCK_SWAP_ROUTER_ABI = parseAbi([
  'function rateBps() view returns (uint256)',
  'function swap(address tokenIn, address tokenOut, uint256 amountIn, address receiver) returns (uint256 out)',
])

const ERC4626_PREVIEW_ABI = parseAbi(['function previewDeposit(uint256 assets) view returns (uint256 shares)'])

/** `MockSwapRouter.swap(tokenIn, tokenOut, amountIn, receiver)` calldata; `receiver` is the conduit. */
export function encodeMockSwap(tokenIn: Address, tokenOut: Address, amountIn: bigint, receiver: Address): Hex {
  return encodeFunctionData({ abi: MOCK_SWAP_ROUTER_ABI, functionName: 'swap', args: [tokenIn, tokenOut, amountIn, receiver] })
}

/** Apply a slippage tolerance to an expected amount: `expected × (10000 − bps) / 10000`. */
export function applySlippage(expected: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    throw new Error(`slippageBps must be an integer between 0 and 10000, got ${slippageBps}`)
  }
  return (expected * BigInt(10_000 - slippageBps)) / 10_000n
}

function rpcUrlOf(chain: TreasuryChain, override?: string): string {
  const url = override ?? chain.rpcUrl
  if (!url) throw new Error(`${chain.key} has no RPC URL; set RPC_URL_${chain.key.replace(/-/g, '_')} or pass minOut explicitly`)
  return url
}

/** Quotes read from the chain with viem. `rpcUrls` overrides the kit's per-chain RPC. */
export function createViemQuoter(rpcUrls: Partial<Record<string, string>> = {}): Quoter {
  const client = (chain: TreasuryChain) => createPublicClient({ transport: http(rpcUrlOf(chain, rpcUrls[chain.key])) })
  return {
    async routerRateBps(chain, router) {
      return client(chain).readContract({ address: router, abi: MOCK_SWAP_ROUTER_ABI, functionName: 'rateBps' })
    },
    async previewDeposit(chain, vault, assets) {
      return client(chain).readContract({ address: vault, abi: ERC4626_PREVIEW_ABI, functionName: 'previewDeposit', args: [assets] })
    },
  }
}

/** The stub venue: 1 USDC → 0.80 EURC, 1 EURC → 1.25 USDC, vault shares 1:1. */
export function createStubQuoter(): Quoter {
  return {
    async routerRateBps(chain, _router, tokenIn, tokenOut) {
      const isUsdc = (t: Address) => t.toLowerCase() === chain.usdc.toLowerCase()
      if (isUsdc(tokenIn) && !isUsdc(tokenOut)) return 8_000n
      if (!isUsdc(tokenIn) && isUsdc(tokenOut)) return 12_500n
      return 10_000n
    },
    async previewDeposit(_chain, _vault, assets) {
      return assets
    },
  }
}
