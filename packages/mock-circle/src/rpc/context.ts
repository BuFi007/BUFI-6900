/*
 * @bufi/mock-circle — per-server state and the handler context.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import { createPublicClient, createWalletClient, http, type Chain, type Hex, type PublicClient, type WalletClient } from 'viem'
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'

import { anvilChain, detectChainId } from '../chain.ts'
import { ANVIL_ACCOUNTS, type Logger } from '../config.ts'
import type { LocalDeployment } from '../deployments.ts'
import type { AddressMappingResponse, ModularWallet, StoredCredential, StoredUserOp } from './types.ts'

export interface ServerState {
  /** ModularWallets keyed by lower-cased address. */
  wallets: Map<string, ModularWallet>
  /** owner key (`eoa:<addr>` / `webauthn:<x>:<y>`) → lower-cased wallet addresses. */
  walletsByOwner: Map<string, Set<string>>
  /** Explicit `circle_createAddressMapping` rows, keyed by owner key. */
  addressMappings: Map<string, AddressMappingResponse[]>
  /** userOpHash → what the bundler knows about it. */
  userOps: Map<Hex, StoredUserOp>
  /** WebAuthn credential id → registration record. */
  credentials: Map<string, StoredCredential>
}

export function createState(): ServerState {
  return {
    wallets: new Map(),
    walletsByOwner: new Map(),
    addressMappings: new Map(),
    userOps: new Map(),
    credentials: new Map(),
  }
}

export interface RpcContext {
  /** anvil JSON-RPC URL. */
  rpcUrl: string
  chain: Chain
  publicClient: PublicClient
  bundler: {
    account: PrivateKeyAccount
    walletClient: WalletClient<ReturnType<typeof http>, Chain, PrivateKeyAccount>
  }
  paymasterSigner: PrivateKeyAccount
  deployment: LocalDeployment
  state: ServerState
  rpId: string
  paymasterValiditySecs: number
  log: Logger
  /** Serialises `handleOps` submissions so the bundler nonce never races. */
  sendQueue: Promise<unknown>
}

export interface RpcContextOptions {
  rpcUrl: string
  deployment: LocalDeployment
  bundlerKey?: Hex
  paymasterSignerKey?: Hex
  rpId: string
  paymasterValiditySecs: number
  log: Logger
}

export async function createRpcContext(opts: RpcContextOptions): Promise<RpcContext> {
  const chainId = await detectChainId(opts.rpcUrl)
  if (chainId !== opts.deployment.chainId) {
    throw new Error(`anvil at ${opts.rpcUrl} is chainId ${chainId} but the deployment file says ${opts.deployment.chainId}`)
  }
  const chain = anvilChain(opts.rpcUrl, chainId)
  const transport = http(opts.rpcUrl)
  const bundlerAccount = privateKeyToAccount(opts.bundlerKey ?? ANVIL_ACCOUNTS.bundler.key)
  const paymasterSigner = privateKeyToAccount(opts.paymasterSignerKey ?? ANVIL_ACCOUNTS.paymasterSigner.key)
  if (opts.deployment.paymaster && opts.deployment.paymaster.signer.toLowerCase() !== paymasterSigner.address.toLowerCase()) {
    throw new Error(
      `paymaster signer mismatch: deployment expects ${opts.deployment.paymaster.signer}, server key is ${paymasterSigner.address}`,
    )
  }
  return {
    rpcUrl: opts.rpcUrl,
    chain,
    publicClient: createPublicClient({ chain, transport }),
    bundler: {
      account: bundlerAccount,
      walletClient: createWalletClient({ chain, transport, account: bundlerAccount }),
    },
    paymasterSigner,
    deployment: opts.deployment,
    state: createState(),
    rpId: opts.rpId,
    paymasterValiditySecs: opts.paymasterValiditySecs,
    log: opts.log,
    sendQueue: Promise.resolve(),
  }
}

/** Runs `fn` after every previously enqueued submission finished (success or failure). */
export function enqueue<T>(ctx: RpcContext, fn: () => Promise<T>): Promise<T> {
  const run = ctx.sendQueue.then(fn, fn)
  ctx.sendQueue = run.catch(() => undefined)
  return run
}
