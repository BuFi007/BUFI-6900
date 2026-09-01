/*
 * Test scaffolding: a throwaway anvil on a free port, the canonical stack deployed on it, and the mock API in front.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import { rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createPublicClient,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  getContractAddress,
  http,
  keccak256,
  pad,
  parseAbiParameters,
  parseSignature,
  zeroHash,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
} from 'viem'
import type { PrivateKeyAccount } from 'viem/accounts'

import { upgradableMscaAbi, weightedPluginInstallDataAbi } from '../src/abi.ts'
import { getFreePort, startAnvil, type AnvilHandle } from '../src/anvil.ts'
import { anvilChain, createClients, type Clients } from '../src/chain.ts'
import { ANVIL_ACCOUNTS, silentLogger } from '../src/config.ts'
import { deployStack } from '../src/deploy.ts'
import type { LocalDeployment } from '../src/deployments.ts'
import type { ModularWallet } from '../src/rpc/types.ts'
import { createMockCircleServer, type MockCircleServer } from '../src/server.ts'
import { SDK_ERC1967_PROXY_CREATION_CODE } from './sdk-constants.ts'

export const CLIENT_KEY = 'sandbox-test-key'

export interface Sandbox {
  anvil: AnvilHandle
  rpcUrl: string
  chain: Chain
  publicClient: PublicClient
  /** anvil account #0 — owns the paymaster, holds the minted USDC. */
  deployer: Clients
  deployment: LocalDeployment
  mock: MockCircleServer
  deploymentsPath: string
  stop(): Promise<void>
}

export async function bootSandbox(): Promise<Sandbox> {
  const anvil = await startAnvil({ port: await getFreePort(), silent: true })
  const deploymentsPath = path.join(os.tmpdir(), `bufi6900-mock-circle-${anvil.port}-${Date.now()}.json`)
  try {
    const deployment = await deployStack({ rpcUrl: anvil.rpcUrl, deploymentsPath, log: silentLogger })
    const mock = await createMockCircleServer({
      port: 0,
      hostname: '127.0.0.1',
      anvilRpcUrl: anvil.rpcUrl,
      deployment,
      log: silentLogger,
    })
    const chain = anvilChain(anvil.rpcUrl, deployment.chainId)
    const deployer = await createClients(anvil.rpcUrl, ANVIL_ACCOUNTS.deployer.key)
    return {
      anvil,
      rpcUrl: anvil.rpcUrl,
      chain,
      publicClient: createPublicClient({ chain, transport: http(anvil.rpcUrl) }),
      deployer,
      deployment,
      mock,
      deploymentsPath,
      async stop() {
        await mock.stop()
        await anvil.stop()
        rmSync(deploymentsPath, { force: true })
      },
    }
  } catch (error) {
    await anvil.stop()
    rmSync(deploymentsPath, { force: true })
    throw error
  }
}

export interface RpcErrorShape {
  code: number
  message: string
  data?: unknown
}

export class MockRpcError extends Error {
  constructor(public readonly error: RpcErrorShape) {
    super(`${error.code}: ${error.message}`)
  }
}

/** Raw JSON-RPC against the mock, exactly like the SDK's fetchFromApi. */
export async function rpc<T = unknown>(
  sandbox: Sandbox,
  method: string,
  params: unknown[] = [],
  options: { key?: string | null; id?: string | number } = {},
): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (options.key !== null) headers.authorization = `Bearer ${options.key ?? CLIENT_KEY}`
  const response = await fetch(sandbox.mock.rpcUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: options.id ?? crypto.randomUUID(), method, params }),
  })
  const json = (await response.json()) as { result?: T; error?: RpcErrorShape }
  if (!response.ok) throw new MockRpcError(json.error ?? { code: response.status, message: `HTTP ${response.status}` })
  if (json.error) throw new MockRpcError(json.error)
  return json.result as T
}

/** viem transport pointed at the mock with the Bearer header the SDK would send. */
export function mockTransport(sandbox: Sandbox) {
  return http(sandbox.mock.rpcUrl, { fetchOptions: { headers: { Authorization: `Bearer ${CLIENT_KEY}` } } })
}

/** `circle_getAddress` with the exact params `getModularWalletAddress` builds for a LocalAccount owner. */
export async function getAddressForEoa(sandbox: Sandbox, owner: PrivateKeyAccount, name = 'test wallet'): Promise<ModularWallet> {
  return rpc<ModularWallet>(sandbox, 'circle_getAddress', [
    {
      scaConfiguration: {
        initialOwnershipConfiguration: {
          weightedMultisig: { owners: [{ address: owner.address, weight: 1 }], thresholdWeight: 1 },
        },
        scaCore: 'circle_6900_v1',
      },
      metadata: { name },
    },
  ])
}

/** The SDK's offline `computeAddress(owner)` for a 1-of-1 EOA owner, using the SDK's own proxy creation code. */
export function computeAddressLikeSdk(deployment: LocalDeployment, owner: Address): Address {
  const weighted = deployment.plugins.weightedWebauthnMultisig
  const sender = pad(owner, { size: 32 })
  const salt = zeroHash
  const installData = encodeAbiParameters(weightedPluginInstallDataAbi, [[owner], [1n], [], [], 1n])
  const initializeData = encodeFunctionData({
    abi: upgradableMscaAbi,
    functionName: 'initializeUpgradableMSCA',
    args: [[weighted.address], [weighted.manifestHash], [installData]],
  })
  const mixedSalt = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [sender, salt]))
  const bytecode = encodePacked(
    ['bytes', 'bytes'],
    [
      SDK_ERC1967_PROXY_CREATION_CODE,
      encodeAbiParameters(parseAbiParameters('address, bytes'), [deployment.upgradableMscaImpl, initializeData]),
    ],
  )
  return getContractAddress({ bytecode, from: deployment.upgradableMscaFactory, opcode: 'CREATE2', salt: mixedSalt })
}

/** `initCode` (factory ‖ createAccount calldata) → the v0.7 `factory` / `factoryData` pair. */
export function splitInitCode(initCode: Hex): { factory: Address; factoryData: Hex } {
  return { factory: `0x${initCode.slice(2, 42)}` as Address, factoryData: `0x${initCode.slice(42)}` as Hex }
}

/**
 * WeightedWebauthnMultisigPlugin EOA signature for a userOp: one 65-byte `[r ‖ s ‖ v]` chunk where v = 27/28 + 32
 * marks the chunk as signed over the ACTUAL digest `toEthSignedMessageHash(userOpHash)` (SDK `wrapEoaSignature`
 * with `hasUserOpGas: true`). With a single owner at threshold 1 that one chunk is the whole signature.
 */
export async function signUserOpAsWeightedEoa(owner: PrivateKeyAccount, userOpHash: Hex): Promise<Hex> {
  const signature = await owner.signMessage({ message: { raw: userOpHash } })
  const { r, s, v } = parseSignature(signature)
  if (v === undefined) throw new Error('signature has no v')
  return encodePacked(['bytes32', 'bytes32', 'uint8'], [r, s, Number(v) + 32])
}
