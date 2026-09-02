/*
 * Copyright (c) 2026 BUFI. Licensed under the Apache License, Version 2.0.
 *
 * LIVE canary against Circle's real Modular Wallets API on Avalanche Fuji: create a Circle Smart Account for an
 * EOA owner, install the testnet-deployed BufiSessionKeyPlugin, grant an agent key, spend USDC with it.
 * Answers plan 184's PENDING "testnet install proof" + "AddressBook composition" with a real Circle bundler.
 *
 * Env (never printed): CIRCLE_CLIENT_KEY, CIRCLE_CLIENT_URL (base, e.g. https://modular-sdk.circle.com/v1/rpc/w3s/buidl),
 * OWNER_PRIVATE_KEY (testnet-only EOA, also funds gas), optional CIRCLE_API_KEY (faucet). Writes
 * contracts/deployments/avax-fuji.canary.json.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { type Address, type Hex, createPublicClient, createWalletClient, encodeFunctionData, formatEther, http, parseAbi, parseEther, toFunctionSelector } from 'viem'
import { createBundlerClient } from 'viem/account-abstraction'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { avalancheFuji } from 'viem/chains'

import {
  AVAX_FUJI_DEPLOYMENT,
  buildAgentFaceCalls,
  encodeInstallAddressBook,
  getAllowedRecipients,
  getInstalledPlugins,
  getSessionKeys,
  toBufiSessionKeyAccount,
  toCircleSmartAccount,
  toModularTransport,
} from '@bufi/modular-wallets-core'

const ROOT = resolve(import.meta.dir, '../..')
const OUT = resolve(ROOT, 'contracts/deployments/avax-fuji.canary.json')
const need = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`missing env ${k}`); return v }
const CLIENT_KEY = need('CIRCLE_CLIENT_KEY')
const CLIENT_URL = need('CIRCLE_CLIENT_URL').replace(/\/$/, '')
const OWNER_KEY = need('OWNER_PRIVATE_KEY') as Hex
const RPC = 'https://api.avax-test.network/ext/bc/C/rpc'
const USDC_ABI = parseAbi(['function transfer(address to, uint256 amount) returns (bool)', 'function balanceOf(address) view returns (uint256)'])
const USDC = (n: number) => BigInt(Math.round(n * 1e6))
const log = (m: string) => console.log(`  ${m}`)
const state: Record<string, unknown> = { chainId: 43113, startedAt: new Date().toISOString() }
const save = () => writeFileSync(OUT, JSON.stringify(state, null, 2))

async function main() {
  const deployment = AVAX_FUJI_DEPLOYMENT
  const usdc = deployment.tokens!.usdc
  const owner = privateKeyToAccount(OWNER_KEY)
  const chain = avalancheFuji
  const rpc = createPublicClient({ chain, transport: http(RPC) })
  const funder = createWalletClient({ chain, transport: http(RPC), account: owner })
  const modular = toModularTransport(`${CLIENT_URL}/avalancheFuji`, CLIENT_KEY, { appUri: process.env.MODULAR_WALLETS_APP_URI ?? 'localhost' })
  const client = createPublicClient({ chain, transport: modular })

  console.log('1. account via Circle Modular Wallets API (circle_getAddress)')
  const account = await toCircleSmartAccount({ client, owner, deployment, name: 'bufi-6900-canary' })
  const address = account.address
  state.account = address; state.owner = owner.address; save()
  log(`account ${address} (owner EOA ${owner.address})`)
  const code = await rpc.getCode({ address })
  log(`deployed: ${Boolean(code && code !== '0x')}`)

  const bal = await rpc.getBalance({ address })
  if (bal < parseEther('0.03')) {
    const h = await funder.sendTransaction({ to: address, value: parseEther('0.05') })
    await rpc.waitForTransactionReceipt({ hash: h })
    log(`funded 0.05 AVAX (tx ${h})`)
  } else log(`balance ${formatEther(bal)} AVAX`)

  const bundler = createBundlerClient({ account, chain, transport: modular })
  const send = async (label: string, params: Parameters<typeof bundler.sendUserOperation>[0]) => {
    const hash = await bundler.sendUserOperation(params)
    const r = await bundler.waitForUserOperationReceipt({ hash, timeout: 180_000 })
    log(`${label}: userOp ${hash} tx ${r.receipt.transactionHash} success=${r.success}`)
    ;(state.userOps ??= [] as unknown[]) as unknown[]; (state.userOps as unknown[]).push({ label, userOpHash: hash, tx: r.receipt.transactionHash, success: r.success }); save()
    if (!r.success) throw new Error(`${label} executed but reverted`)
    return r
  }

  console.log('2. install BufiSessionKeyPlugin (raw calldata userOp; deploys the account if needed)')
  let installed = (code && code !== '0x') ? await getInstalledPlugins(rpc, { account: address }) : []
  const skAddr = deployment.bufiSessionKey!.address
  const agent = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as Hex ?? generatePrivateKey())
  state.agent = agent.address; save()
  const nowTs = Number((await rpc.getBlock()).timestamp)
  const face = buildAgentFaceCalls({
    account: address, deployment,
    agents: [{ sessionKey: agent.address, grant: {
      scope: { allow: [{ target: usdc, selectors: [toFunctionSelector('function transfer(address,uint256)')] }] },
      budget: { erc20: [{ token: usdc, limit: USDC(5), refreshIntervalSeconds: 86_400 }], gas: { limit: parseEther('0.5'), refreshIntervalSeconds: 86_400 } },
      expiry: { validUntil: nowTs + 7 * 86_400 },
    } }],
  })
  if (!installed.map((p) => p.toLowerCase()).includes(skAddr.toLowerCase())) {
    await send('installSessionKeyPlugin', { callData: face.installSessionKeyPlugin.data })
  } else {
    const existing = await getSessionKeys(rpc, { plugin: skAddr, account: address })
    if (existing.map((k) => k.toLowerCase()).includes(agent.address.toLowerCase())) {
      log('plugin installed and this agent key already granted — skipping addSessionKey')
    } else {
      log('plugin already installed — granting this run\'s agent key with addSessionKey (owner userOp, raw calldata)')
      await send('addSessionKey', { callData: face.addSessionKeys[0].data })
    }
  }
  installed = await getInstalledPlugins(rpc, { account: address })
  log(`getInstalledPlugins → ${installed.join(', ')}`)
  if (!installed.map((p) => p.toLowerCase()).includes(skAddr.toLowerCase())) throw new Error('plugin not listed by AccountLoupe')
  const keys = await getSessionKeys(rpc, { plugin: skAddr, account: address })
  log(`session keys → ${keys.join(', ')}`)
  state.installedPlugins = installed; state.sessionKeys = keys; save()

  console.log('3. agent spends USDC through the real Circle bundler')
  let usdcBal = await rpc.readContract({ address: usdc, abi: USDC_ABI, functionName: 'balanceOf', args: [address] })
  if (usdcBal < USDC(1) && process.env.CIRCLE_API_KEY) {
    const res = await fetch('https://api.circle.com/v1/faucet/drips', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.CIRCLE_API_KEY}` }, body: JSON.stringify({ address, blockchain: 'AVAX-FUJI', usdc: true }) })
    log(`faucet: HTTP ${res.status}`)
    for (let i = 0; i < 30 && usdcBal < USDC(1); i++) { await Bun.sleep(5_000); usdcBal = await rpc.readContract({ address: usdc, abi: USDC_ABI, functionName: 'balanceOf', args: [address] }) }
  }
  log(`account USDC: ${Number(usdcBal) / 1e6}`)
  if (usdcBal < USDC(1)) { log('no USDC — skipping agent spend'); state.agentSpend = 'skipped (no USDC)'; save(); return }
  const agentAccount = await toBufiSessionKeyAccount({ client, account: address, sessionKey: agent, plugin: skAddr, deployment })
  const agentBundler = createBundlerClient({ account: agentAccount, chain, transport: modular })
  const before = await rpc.readContract({ address: usdc, abi: USDC_ABI, functionName: 'balanceOf', args: [owner.address] })
  const usePaymaster = process.env.USE_CIRCLE_PAYMASTER === '1'
  if (usePaymaster) log('agent op sponsored by Circle paymaster (ERC-7677 pm_getPaymasterData on the same transport)')
  const hash = await agentBundler.sendUserOperation({ calls: [{ to: usdc, data: encodeFunctionData({ abi: USDC_ABI, functionName: 'transfer', args: [owner.address, USDC(1)] }) }], ...(usePaymaster ? { paymaster: true } : {}) })
  const r = await agentBundler.waitForUserOperationReceipt({ hash, timeout: 180_000 })
  const after = await rpc.readContract({ address: usdc, abi: USDC_ABI, functionName: 'balanceOf', args: [owner.address] })
  const gasPaidBy = usePaymaster ? 'paymaster' : 'account'
  log(`agent transfer 1 USDC: userOp ${hash} tx ${r.receipt.transactionHash} success=${r.success} delta=${Number(after - before) / 1e6} gasPaidBy=${gasPaidBy} paymaster=${(r as { paymaster?: string }).paymaster ?? 'n/a'}`)
  state.agentSpend = { userOpHash: hash, tx: r.receipt.transactionHash, success: r.success }; save()
  if (!r.success || after - before !== USDC(1)) throw new Error('agent spend did not land')

  console.log('4. AddressBook composition on the live account')
  const abInstall = encodeInstallAddressBook({ account: address, recipients: [owner.address], deployment })
  installed = await getInstalledPlugins(rpc, { account: address })
  if (!installed.map((p) => p.toLowerCase()).includes(deployment.coldStorageAddressBook.address.toLowerCase())) {
    await send('installAddressBook', { callData: abInstall.data })
  }
  const allowed = await getAllowedRecipients(rpc, { plugin: deployment.coldStorageAddressBook.address, account: address })
  log(`allowlist → ${allowed.join(', ')}`)
  state.addressBook = allowed; save()
  console.log('\nLIVE CANARY GREEN')
  state.finishedAt = new Date().toISOString(); state.result = 'green'; save()
}
main().catch((e) => { console.error('LIVE CANARY FAILED:', e?.shortMessage ?? e?.message ?? e, '\n  details:', e?.details ?? e?.cause?.details ?? e?.cause?.message ?? ''); state.result = `failed: ${String(e?.shortMessage ?? e?.message ?? e).slice(0, 300)}`; save(); process.exit(1) })
