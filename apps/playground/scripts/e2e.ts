/*
 * Copyright (c) 2026 BUFI. Licensed under the Apache License, Version 2.0.
 *
 * Headless end-to-end drive of the BUFI-6900 sandbox through @bufi/modular-wallets-core.
 * See README.md for the scenario. Exit 0 = every assertion held.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  parseAbi,
  toFunctionSelector,
} from 'viem'
import { createBundlerClient } from 'viem/account-abstraction'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { foundry } from 'viem/chains'

import {
  buildAgentFaceCalls,
  encodeInstallAddressBook,
  encodeInstallEarnModule,
  encodeRemoveSessionKey,
  computeEarnConfigHash,
  findPredecessor,
  getAllowedRecipients,
  getInstalledPlugins,
  getSessionKeys,
  toBufiSessionKeyAccount,
  toCircleSmartAccount,
  toModularTransport,
  toStackDeployment,
} from '@bufi/modular-wallets-core'

const ROOT = resolve(import.meta.dir, '../../..')
const MOCK_URL = process.env.MOCK_CIRCLE_URL ?? 'http://127.0.0.1:8788/v1/rpc/w3s/buidl'
const RPC_URL = process.env.ANVIL_RPC_URL ?? 'http://127.0.0.1:8545'
const DEPLOYMENTS_PATH = process.env.DEPLOYMENTS_PATH ?? resolve(ROOT, 'contracts/deployments/local.json')

// anvil's well-known accounts
const DEPLOYER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const
const RELAYER_KEY = '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a' as const

const USDC_ABI = parseAbi([
  'function mint(address to, uint256 amount)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
])
const EARN_ABI = parseAbi([
  'function setConfig((uint256 chainId,address token,address vault)[] newConfigs) returns (uint256)',
  'function addAuthorizedRelayer(address newRelayer)',
  'function autoEarn(address token, uint256 amountToSave)',
])

const USDC = (n: number) => BigInt(Math.round(n * 1e6))
const TRANSFER = toFunctionSelector('function transfer(address,uint256)')

let step = 0
const ok = (msg: string) => console.log(`  ✔ ${msg}`)
const section = (title: string) => console.log(`\n${++step}. ${title}`)
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`)
}
async function expectRejected(label: string, fn: () => Promise<unknown>) {
  try {
    await fn()
  } catch (error) {
    ok(`${label} → rejected (${String((error as Error).message).split('\n')[0].slice(0, 120)})`)
    return
  }
  throw new Error(`ASSERTION FAILED: ${label} should have been rejected`)
}

async function rpcUp(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sandbox' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    })
    return res.ok
  } catch {
    return false
  }
}

async function ensureSandbox() {
  if ((await rpcUp(MOCK_URL)) && existsSync(DEPLOYMENTS_PATH)) return
  console.log('sandbox not running — booting @bufi/mock-circle (anvil + deploy + mock API)…')
  const child = spawn('bun', ['run', '--cwd', 'packages/mock-circle', 'dev'], {
    cwd: ROOT,
    stdio: 'inherit',
    detached: true,
  })
  child.unref()
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    if ((await rpcUp(MOCK_URL)) && existsSync(DEPLOYMENTS_PATH)) return
    await Bun.sleep(1_000)
  }
  throw new Error('sandbox did not come up within 180s')
}

async function main() {
  await ensureSandbox()
  const deployment = toStackDeployment(JSON.parse(readFileSync(DEPLOYMENTS_PATH, 'utf8')))
  const usdc = deployment.tokens?.usdc
  assert(usdc, 'deployment carries tokens.usdc')
  assert(deployment.bufiSessionKey, 'deployment carries bufiSessionKey (build contracts first: bun run contracts:build)')

  const chain = { ...foundry, id: deployment.chainId ?? 31337 }
  const rpc = createPublicClient({ chain, transport: http(RPC_URL) })
  const modular = toModularTransport(MOCK_URL, 'sandbox-client-key', {
    trustedHosts: [new URL(MOCK_URL).host],
  })
  const client = createPublicClient({ chain, transport: modular })
  const deployer = createWalletClient({ chain, transport: http(RPC_URL), account: privateKeyToAccount(DEPLOYER_KEY) })
  const relayer = createWalletClient({ chain, transport: http(RPC_URL), account: privateKeyToAccount(RELAYER_KEY) })

  const owner = privateKeyToAccount(generatePrivateKey())
  const agent = privateKeyToAccount(generatePrivateKey())
  const friend = privateKeyToAccount(generatePrivateKey()).address
  const stranger = privateKeyToAccount(generatePrivateKey()).address

  console.log(`sandbox   chainId=${chain.id}  mock=${MOCK_URL}`)
  console.log(`stack     factory=${deployment.upgradableMscaFactory} weighted=${deployment.weightedWebauthnMultisig.address}`)
  console.log(`plugins   addressBook=${deployment.coldStorageAddressBook.address} sessionKey=${deployment.bufiSessionKey.address} earn=${deployment.bufiEarnModule?.address ?? '—'}`)

  // ── 1. account via the SDK, exactly like a Circle app ─────────────────────────────────────────────────────
  section('Create a weighted-multisig MSCA through the SDK (circle_getAddress on the mock) and deploy it')
  const account = await toCircleSmartAccount({ client, owner, deployment })
  const address = account.address
  ok(`counterfactual address ${address}`)
  await deployer.writeContract({ address: usdc, abi: USDC_ABI, functionName: 'mint', args: [address, USDC(10_000)] })
  const fundTx = await deployer.sendTransaction({ to: address, value: 5n * 10n ** 18n })
  await rpc.waitForTransactionReceipt({ hash: fundTx })
  const bundler = createBundlerClient({ account, chain, transport: modular })

  const firstHash = await bundler.sendUserOperation({
    calls: [{ to: usdc, data: encodeFunctionData({ abi: USDC_ABI, functionName: 'transfer', args: [friend, USDC(1)] }) }],
  })
  const firstReceipt = await bundler.waitForUserOperationReceipt({ hash: firstHash })
  assert(firstReceipt.success, 'first userOp succeeded')
  assert((await rpc.getCode({ address })) !== undefined, 'account is deployed')
  assert((await rpc.readContract({ address: usdc, abi: USDC_ABI, functionName: 'balanceOf', args: [friend] })) === USDC(1), 'friend got 1 USDC')
  ok('account deployed by its first userOp; 1 USDC transferred by the owner')
  let installed = await getInstalledPlugins(rpc, { account: address })
  assert(installed.map((p) => p.toLowerCase()).includes(deployment.weightedWebauthnMultisig.address.toLowerCase()), 'weighted multisig installed at init')

  // ── 2. address book ───────────────────────────────────────────────────────────────────────────────────────
  section('Owner installs ColdStorageAddressBookPlugin (production dependency slots) with [friend] allowlisted')
  const abInstall = encodeInstallAddressBook({ account: address, recipients: [friend], deployment })
  const abHash = await bundler.sendUserOperation({ calls: [abInstall] })
  assert((await bundler.waitForUserOperationReceipt({ hash: abHash })).success, 'address book install succeeded')
  installed = await getInstalledPlugins(rpc, { account: address })
  assert(installed.map((p) => p.toLowerCase()).includes(deployment.coldStorageAddressBook.address.toLowerCase()), 'address book listed by AccountLoupe')
  const allowed = await getAllowedRecipients(rpc, { plugin: deployment.coldStorageAddressBook.address, account: address })
  assert(allowed.length === 1 && allowed[0].toLowerCase() === friend.toLowerCase(), 'allowlist == [friend]')
  ok('installed; allowlist read back through the SDK')
  await expectRejected('owner transfer to a stranger (execute is hooked by the address book)', () =>
    bundler.sendUserOperation({
      calls: [{ to: usdc, data: encodeFunctionData({ abi: USDC_ABI, functionName: 'transfer', args: [stranger, USDC(1)] }) }],
    }),
  )

  // ── 3. agent grant ────────────────────────────────────────────────────────────────────────────────────────
  section('Owner installs BufiSessionKeyPlugin seeded with the agent grant {scope, budget, expiry}')
  const now = Number((await rpc.getBlock()).timestamp)
  const face = buildAgentFaceCalls({
    account: address,
    deployment,
    agents: [
      {
        sessionKey: agent.address,
        grant: {
          scope: { allow: [{ target: usdc, selectors: [TRANSFER] }] },
          budget: {
            erc20: [{ token: usdc, limit: USDC(500), refreshIntervalSeconds: 86_400 }],
            gas: { limit: 10n ** 18n, refreshIntervalSeconds: 86_400 },
          },
          expiry: { validUntil: now + 7 * 86_400 },
        },
      },
    ],
  })
  const skHash = await bundler.sendUserOperation({ calls: [face.installSessionKeyPlugin] })
  assert((await bundler.waitForUserOperationReceipt({ hash: skHash })).success, 'session key plugin install succeeded')
  const keys = await getSessionKeys(rpc, { plugin: deployment.bufiSessionKey.address, account: address })
  assert(keys.map((k) => k.toLowerCase()).includes(agent.address.toLowerCase()), 'agent key registered')
  ok(`agent ${agent.address} granted: USDC.transfer only · 500 USDC / 24h · 1 ETH gas / 24h · 7 days`)

  // ── 4. the agent spends ───────────────────────────────────────────────────────────────────────────────────
  section('Agent spends through toBufiSessionKeyAccount (executeWithSessionKey)')
  const agentAccount = await toBufiSessionKeyAccount({
    client,
    account: address,
    sessionKey: agent,
    plugin: deployment.bufiSessionKey.address,
    deployment,
  })
  const agentBundler = createBundlerClient({ account: agentAccount, chain, transport: modular })
  const agentTransfer = (to: Address, amount: bigint) =>
    agentBundler
      .sendUserOperation({ calls: [{ to: usdc, data: encodeFunctionData({ abi: USDC_ABI, functionName: 'transfer', args: [to, amount] }) }] })
      .then((hash) => agentBundler.waitForUserOperationReceipt({ hash }))
      .then((r) => {
        assert(r.success, 'agent userOp executed')
        return r
      })

  await agentTransfer(friend, USDC(200))
  ok('200 USDC → friend (within budget)')
  await agentTransfer(stranger, USDC(10))
  ok('10 USDC → stranger SUCCEEDED — FINDING: the address book hooks execute/executeBatch only; executeWithSessionKey is not gated. Recipient policy for agents lives in the grant (see docs/PLUGIN-COMPOSITION.md)')
  await agentTransfer(friend, USDC(250))
  ok('250 USDC → friend (460/500 used)')
  await expectRejected('agent 100 USDC (would exceed the 500 USDC / 24h budget)', () => agentTransfer(friend, USDC(100)))
  await expectRejected('agent calls a selector outside the grant (USDC.approve)', () =>
    agentBundler.sendUserOperation({
      calls: [{ to: usdc, data: encodeFunctionData({ abi: USDC_ABI, functionName: 'approve', args: [stranger, USDC(1)] }) }],
    }),
  )
  await expectRejected('agent calls a target outside the grant (the account itself)', () =>
    agentBundler.sendUserOperation({ calls: [{ to: address, data: '0x' as Hex, value: 0n }] }),
  )

  // ── 5. revoke ─────────────────────────────────────────────────────────────────────────────────────────────
  section('Owner revokes the agent key; the agent is rejected')
  const predecessor = await findPredecessor(rpc, { plugin: deployment.bufiSessionKey.address, account: address, sessionKey: agent.address })
  const revoke = encodeRemoveSessionKey({ sessionKey: agent.address, predecessor })
  const rvHash = await bundler.sendUserOperation({ calls: [{ to: address, data: revoke, value: 0n }] })
  assert((await bundler.waitForUserOperationReceipt({ hash: rvHash })).success, 'removeSessionKey succeeded')
  await expectRejected('revoked agent transfer', () => agentTransfer(friend, USDC(1)))

  // ── 6. earn ───────────────────────────────────────────────────────────────────────────────────────────────
  if (deployment.bufiEarnModule) {
    section('Earn: module owner registers a vault; the multisig adopts it at install; the relayer sweeps')
    const vaultArtifact = JSON.parse(readFileSync(resolve(ROOT, 'contracts/out/Mocks.sol/MockVault.json'), 'utf8'))
    const vaultTx = await deployer.deployContract({ abi: vaultArtifact.abi, bytecode: vaultArtifact.bytecode.object as Hex, args: [usdc] })
    const vault = (await rpc.waitForTransactionReceipt({ hash: vaultTx })).contractAddress as Address
    const configs = [{ chainId: BigInt(chain.id), token: usdc, vault }]
    const configHash = computeEarnConfigHash(configs)
    const earn = deployment.bufiEarnModule.address
    await rpc.waitForTransactionReceipt({ hash: await deployer.writeContract({ address: earn, abi: EARN_ABI, functionName: 'setConfig', args: [configs] }) })
    await rpc.waitForTransactionReceipt({ hash: await deployer.writeContract({ address: earn, abi: EARN_ABI, functionName: 'addAuthorizedRelayer', args: [relayer.account.address] }) })
    const earnInstall = encodeInstallEarnModule({ account: address, configHash, deployment })
    const eHash = await bundler.sendUserOperation({ calls: [earnInstall] })
    assert((await bundler.waitForUserOperationReceipt({ hash: eHash })).success, 'earn install succeeded')
    const sweep = await relayer.writeContract({ address, abi: EARN_ABI, functionName: 'autoEarn', args: [usdc, USDC(1_000)] })
    assert((await rpc.waitForTransactionReceipt({ hash: sweep })).status === 'success', 'relayer autoEarn tx mined')
    const shares = await rpc.readContract({ address: vault, abi: USDC_ABI, functionName: 'balanceOf', args: [address] })
    assert(shares > 0n, 'vault shares minted to the account')
    ok(`relayer swept 1,000 USDC into ${vault}; account holds ${shares} shares (vault is NOT on the address book — deposit path is executeFromPluginExternal)`)
  } else {
    console.log('\n(earn module not in deployment — skipped)')
  }

  console.log('\nALL GREEN')
}

main().catch((error) => {
  console.error('\nE2E FAILED:', error)
  process.exit(1)
})
