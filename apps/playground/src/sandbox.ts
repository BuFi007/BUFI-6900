/*
 * Copyright (c) 2026 BUFI. Licensed under the Apache License, Version 2.0.
 *
 * The sandbox wiring every panel shares: the stack deployment (contracts/deployments/local.json, the file
 * `bun run mock:circle` writes), the chain object, Circle's two transports pointed at the mock Modular Wallets API,
 * the clients, and the dev-only anvil signers used by the "Fund me" / module-owner / relayer buttons.
 */
import {
  type Abi,
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  toFunctionSelector,
} from 'viem'
import { type BundlerClient, type SmartAccount, createBundlerClient } from 'viem/account-abstraction'
import { privateKeyToAccount } from 'viem/accounts'
import { foundry } from 'viem/chains'

import { toModularTransport, toPasskeyTransport, toStackDeployment } from '@bufi/modular-wallets-core'

import deploymentJson from '../../../contracts/deployments/local.json'

export const MOCK_URL = import.meta.env.VITE_CLIENT_URL || 'http://127.0.0.1:8788/v1/rpc/w3s/buidl'
export const CLIENT_KEY = import.meta.env.VITE_CLIENT_KEY || 'sandbox-client-key'
export const RPC_URL = import.meta.env.VITE_ANVIL_RPC_URL || 'http://127.0.0.1:8545'

/** The stack the sandbox deployed: Circle's contracts at Circle's canonical addresses + the BUFI plugins. */
export const deployment = toStackDeployment(deploymentJson)
export const chain = { ...foundry, id: deployment.chainId ?? 31337 }

export const USDC_DECIMALS = 6
export const usdc: Address = (() => {
  const address = deployment.tokens?.usdc
  if (!address) throw new Error('deployment carries no tokens.usdc — run `bun run mock:circle` at the repo root')
  return address
})()

// Create Circle transports (as in the upstream example, pointed at the mock; the mock host is trusted explicitly)
export const passkeyTransport = toPasskeyTransport(MOCK_URL, CLIENT_KEY)
export const modularTransport = toModularTransport(MOCK_URL, CLIENT_KEY, {
  trustedHosts: [new URL(MOCK_URL).host],
})

// Create a public client — the Modular Wallets API; this is what resolves the account address (circle_getAddress)
export const client = createPublicClient({ chain, transport: modularTransport })

// Create a bundler client
export const bundlerClient = createBundlerClient({ chain, transport: modularTransport })

// Direct chain reads (AccountLoupe, plugin state, balances) against the same anvil the mock proxies to
export const rpc = createPublicClient({ chain, transport: http(RPC_URL) })

// ── dev-only: anvil's well-known accounts (never reuse outside the sandbox) ─────────────────────────────────
export const ANVIL = {
  /** #0 — stack deployer, SandboxUSDC minter, BufiEarnModule owner. */
  deployer: privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'),
  /** #4 — the earn relayer the headless e2e authorizes. */
  relayer: privateKeyToAccount('0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a'),
} as const
export const deployerWallet = createWalletClient({ chain, transport: http(RPC_URL), account: ANVIL.deployer })
export const relayerWallet = createWalletClient({ chain, transport: http(RPC_URL), account: ANVIL.relayer })

export const USDC_ABI = parseAbi([
  'function mint(address to, uint256 amount)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
])
export const EARN_ABI = parseAbi([
  'function setConfig((uint256 chainId,address token,address vault)[] newConfigs) returns (uint256)',
  'function addAuthorizedRelayer(address newRelayer)',
  'function authorizedRelayers(address) view returns (bool)',
  'function autoEarn(address token, uint256 amountToSave)',
])
export const TRANSFER_SELECTOR = toFunctionSelector('function transfer(address,uint256)')
export const APPROVE_SELECTOR = toFunctionSelector('function approve(address,uint256)')

const PLUGIN_LABELS = new Map<string, string>([
  [deployment.weightedWebauthnMultisig.address.toLowerCase(), 'WeightedWebauthnMultisigPlugin (Circle, owner)'],
  [deployment.coldStorageAddressBook.address.toLowerCase(), 'ColdStorageAddressBookPlugin (Circle)'],
  ...(deployment.bufiSessionKey ? [[deployment.bufiSessionKey.address.toLowerCase(), 'BufiSessionKeyPlugin (BUFI)'] as const] : []),
  ...(deployment.bufiEarnModule ? [[deployment.bufiEarnModule.address.toLowerCase(), 'BufiEarnModule (BUFI)'] as const] : []),
])
export const labelPlugin = (address: Address): string => PLUGIN_LABELS.get(address.toLowerCase()) ?? 'unknown plugin'
export const isInstalled = (installed: readonly Address[], plugin: Address | undefined): boolean =>
  plugin !== undefined && installed.some((p) => p.toLowerCase() === plugin.toLowerCase())

export const sameAddress = (a: Address, b: Address): boolean => a.toLowerCase() === b.toLowerCase()
export const USDC = (amount: string | number): bigint => BigInt(Math.round(Number(amount) * 10 ** USDC_DECIMALS))
export const short = (hex: string): string => `${hex.slice(0, 8)}…${hex.slice(-6)}`

/**
 * Per-op options every owner-side panel receives from the app: whether the sandbox paymaster sponsors the op, and an
 * optional `verificationGasLimit` override.
 *
 * WORKAROUND (passkey owners on anvil): the SDK's `userOperation.estimateGas` hook takes `verificationGasLimit` from
 * `circle_getUserOperationGasPrice` (`notDeployed` 1.5M / `deployed` 600k on the mock) — values sized for chains with
 * the RIP-7212 P-256 precompile. anvil has none, so WeightedWebauthnMultisigPlugin falls back to the Solidity FCL
 * verifier and the EntryPoint rejects the op with `AA26 over verificationGasLimit`. Both the hook and viem's
 * `prepareUserOperation` honour a caller-supplied `verificationGasLimit`, so the app passes one for WebAuthn owners.
 * EOA owners and session-key ops never need it.
 */
export interface OpOptions {
  sponsor: boolean
  verificationGasLimit?: bigint
}
export const PASSKEY_VERIFICATION_GAS_LIMIT = 3_000_000n

export interface UserOpOutcome {
  hash: Hex
  success: boolean
  txHash: Hex
  reason?: string
}

/**
 * Sends a user operation and waits for its receipt. `callData` is submitted as the RAW calldata (plugin installs and
 * every plugin management function target the account itself and must never be wrapped in `execute`, one per user
 * operation); `calls` is the normal `execute` / `executeBatch` path.
 */
export async function sendUserOp(
  bundler: BundlerClient,
  params: { account: SmartAccount; sponsor?: boolean; verificationGasLimit?: bigint } & (
    | { callData: Hex; calls?: undefined }
    | { calls: readonly { to: Address; data?: Hex; value?: bigint }[]; callData?: undefined }
  ),
): Promise<UserOpOutcome> {
  const overrides = {
    ...(params.sponsor ? { paymaster: true as const } : {}),
    ...(params.verificationGasLimit !== undefined ? { verificationGasLimit: params.verificationGasLimit } : {}),
  }
  const hash =
    params.callData !== undefined
      ? await bundler.sendUserOperation({ account: params.account, callData: params.callData, ...overrides })
      : await bundler.sendUserOperation({ account: params.account, calls: [...params.calls], ...overrides })
  const receipt = await bundler.waitForUserOperationReceipt({ hash })
  return { hash, success: receipt.success, txHash: receipt.receipt.transactionHash, reason: receipt.reason }
}

/** The first meaningful line of a viem / RPC error: shortMessage + details when the node returned any. */
export function formatError(error: unknown): string {
  if (error && typeof error === 'object') {
    const e = error as { shortMessage?: string; details?: string; message?: string }
    const head = e.shortMessage ?? e.message ?? String(error)
    return e.details && !head.includes(e.details) ? `${head} — ${e.details}` : head
  }
  return String(error)
}

// ── dev-only: the MockVault forge artifact (contracts/out, gitignored) for the Earn panel's "deploy a vault" button.
// import.meta.glob resolves to an empty map when contracts/out is absent, so neither `vite build` nor `tsc` needs it.
const vaultArtifacts = import.meta.glob<{ abi: Abi; bytecode: { object: Hex } }>(
  '../../../contracts/out/Mocks.sol/MockVault.json',
  { import: 'default' },
)
export async function loadMockVaultArtifact(): Promise<{ abi: Abi; bytecode: Hex }> {
  const load = Object.values(vaultArtifacts)[0]
  if (!load) throw new Error('contracts/out/Mocks.sol/MockVault.json is missing — run `bun run contracts:build` and restart vite')
  const artifact = await load()
  return { abi: artifact.abi, bytecode: artifact.bytecode.object }
}
