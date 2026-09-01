/*
 * @bufi/mock-circle — viem clients for anvil plus the `anvil_*` cheat codes the deployer relies on.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Address,
  type Chain,
  type Hash,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem'
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'

export function anvilChain(rpcUrl: string, id: number): Chain {
  return defineChain({
    id,
    name: 'Anvil (BUFI-6900 sandbox)',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  })
}

interface JsonRpcEnvelope<T> {
  result?: T
  error?: { code: number; message: string; data?: unknown }
}

export class UpstreamRpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message)
    this.name = 'UpstreamRpcError'
  }
}

/** Raw JSON-RPC call straight to the node — errors come back untouched (code/message/data). */
export async function rawJsonRpc<T = unknown>(rpcUrl: string, method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  if (!response.ok) throw new UpstreamRpcError(-32603, `${method}: upstream HTTP ${response.status}`)
  const json = (await response.json()) as JsonRpcEnvelope<T>
  if (json.error) throw new UpstreamRpcError(json.error.code, json.error.message, json.error.data)
  return json.result as T
}

export async function detectChainId(rpcUrl: string): Promise<number> {
  const hex = await rawJsonRpc<Hex>(rpcUrl, 'eth_chainId')
  return Number(hex)
}

export interface Clients {
  rpcUrl: string
  chain: Chain
  publicClient: PublicClient
  walletClient: WalletClient<ReturnType<typeof http>, Chain, PrivateKeyAccount>
  account: PrivateKeyAccount
}

export async function createClients(rpcUrl: string, privateKey: Hex): Promise<Clients> {
  const chain = anvilChain(rpcUrl, await detectChainId(rpcUrl))
  const account = privateKeyToAccount(privateKey)
  const transport = http(rpcUrl)
  return {
    rpcUrl,
    chain,
    account,
    publicClient: createPublicClient({ chain, transport }),
    walletClient: createWalletClient({ chain, transport, account }),
  }
}

export async function anvilSetCode(rpcUrl: string, address: Address, code: Hex): Promise<void> {
  await rawJsonRpc(rpcUrl, 'anvil_setCode', [address, code])
}

export async function anvilSetBalance(rpcUrl: string, address: Address, wei: bigint): Promise<void> {
  await rawJsonRpc(rpcUrl, 'anvil_setBalance', [address, `0x${wei.toString(16)}`])
}

/**
 * Sends a transaction "from" an account we do not hold the key for (Circle's factory owner). anvil signs
 * nothing: `anvil_impersonateAccount` makes `eth_sendTransaction` accept the bare `from`.
 */
export async function sendAsImpersonated(
  clients: Clients,
  from: Address,
  tx: { to: Address; data: Hex; value?: bigint },
): Promise<Hash> {
  await rawJsonRpc(clients.rpcUrl, 'anvil_impersonateAccount', [from])
  try {
    const balance = await clients.publicClient.getBalance({ address: from })
    if (balance < 10n ** 18n) await anvilSetBalance(clients.rpcUrl, from, 100n * 10n ** 18n)
    const impersonated = createWalletClient({ chain: clients.chain, transport: http(clients.rpcUrl), account: from })
    const hash = await impersonated.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ?? 0n })
    const receipt = await clients.publicClient.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new Error(`impersonated tx from ${from} reverted (${hash})`)
    return hash
  } finally {
    await rawJsonRpc(clients.rpcUrl, 'anvil_stopImpersonatingAccount', [from])
  }
}

export async function hasCode(publicClient: PublicClient, address: Address): Promise<boolean> {
  const code = await publicClient.getCode({ address })
  return code !== undefined && code !== '0x'
}
