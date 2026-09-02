/*
 * BUFI-6900 defensive Tenderly audit driver (Avalanche Fuji vnet, chain 43113).
 *
 * Signs owner (2-of-3 weighted multisig) and session-key userOps locally with anvil's well-known throwaway keys,
 * submits them through EntryPoint v0.7 `handleOps` from a funded EOA (no bundler on the vnet), and prints every
 * assertion as JSON so the audit report can quote raw values. Admin operations (snapshots, funding, time travel,
 * impersonated calls) are done through the Tenderly MCP, NOT here.
 *
 *   VNET_RPC=<public rpc> bun run reports/audit/driver.ts <command> [args]
 *
 * The RPC URL is read from the environment only; it is never written to this repo.
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  type Address,
  type Hex,
  concatHex,
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  decodeEventLog,
  encodeAbiParameters,
  encodeFunctionData,
  getCreate2Address,
  hashMessage,
  http,
  keccak256,
  pad,
  parseAbi,
  parseAbiParameters,
  toHex,
  toBytes,
  hexToBigInt,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { avalancheFuji } from 'viem/chains'

// ───────────────────────────────────────────────────────────── paths / artifacts

const ROOT = resolve(import.meta.dir, '../..')
const OUT = resolve(ROOT, 'contracts/out')
const STATE_FILE = resolve(import.meta.dir, 'state.json')
const LOG_FILE = resolve(import.meta.dir, 'txlog.jsonl')

const art = (p: string) => JSON.parse(readFileSync(resolve(OUT, p), 'utf8'))
const ABI = {
  entryPoint: art('EntryPoint.sol/EntryPoint.json').abi,
  factory: art('UpgradableMSCAFactory.sol/UpgradableMSCAFactory.json').abi,
  msca: art('UpgradableMSCA.sol/UpgradableMSCA.json').abi,
  weighted: art('WeightedWebauthnMultisigPlugin.sol/WeightedWebauthnMultisigPlugin.json').abi,
  addressBook: art('ColdStorageAddressBookPlugin.sol/ColdStorageAddressBookPlugin.json').abi,
  sessionKey: art('BufiSessionKeyPlugin.sol/BufiSessionKeyPlugin.json').abi,
  earn: art('BufiEarnModule.sol/BufiEarnModule.json').abi,
  hook: art('BufiSessionRecipientHookPlugin.sol/BufiSessionRecipientHookPlugin.json').abi,
  vault: art('Mocks.sol/MockVault.json').abi,
  pluginManager: art('PluginManager.sol/PluginManager.json').abi,
  standardExecutor: art('StandardExecutor.sol/StandardExecutor.json').abi,
  pluginExecutor: art('PluginExecutor.sol/PluginExecutor.json').abi,
  baseMsca: art('BaseMSCA.sol/BaseMSCA.json').abi,
}
const HOOK_CREATION: Hex = art('BufiSessionRecipientHookPlugin.sol/BufiSessionRecipientHookPlugin.json').bytecode.object
const VAULT_CREATION: Hex = art('Mocks.sol/MockVault.json').bytecode.object
const ERC20_ABI = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function decimals() view returns (uint8)',
])
const PERM_ABI = parseAbi([
  'function setAccessListType(uint8 t)',
  'function updateAccessListAddressEntry(address contractAddress, bool isOnList, bool checkSelectors)',
  'function updateAccessListFunctionEntry(address contractAddress, bytes4 selector, bool isOnList)',
  'function updateTimeRange(uint48 validAfter, uint48 validUntil)',
  'function setNativeTokenSpendLimit(uint256 spendLimit, uint48 refreshInterval)',
  'function setERC20SpendLimit(address token, uint256 spendLimit, uint48 refreshInterval)',
  'function setGasSpendLimit(uint256 spendLimit, uint48 refreshInterval)',
  'function setRequiredPaymaster(address requiredPaymaster)',
])
const ALL_ABI = [
  ...ABI.entryPoint, ...ABI.factory, ...ABI.msca, ...ABI.weighted, ...ABI.addressBook, ...ABI.sessionKey,
  ...ABI.earn, ...ABI.hook, ...ABI.vault, ...ABI.pluginManager, ...ABI.standardExecutor, ...ABI.pluginExecutor,
  ...ABI.baseMsca, ...ERC20_ABI,
]

// ───────────────────────────────────────────────────────────── addresses (Fuji, Circle production + BUFI)

const FUJI = JSON.parse(readFileSync(resolve(ROOT, 'contracts/deployments/avax-fuji.json'), 'utf8'))
const A = {
  entryPoint: FUJI.entryPoint as Address,
  create2: FUJI.create2Deployer as Address,
  pluginManager: FUJI.pluginManager as Address,
  factory: FUJI.upgradableMscaFactory as Address,
  mscaImpl: FUJI.upgradableMscaImpl as Address,
  weighted: FUJI.plugins.weightedWebauthnMultisig.address as Address,
  addressBook: FUJI.plugins.coldStorageAddressBook.address as Address,
  sessionKey: FUJI.plugins.bufiSessionKey.address as Address,
  earn: FUJI.plugins.bufiEarnModule.address as Address,
  usdc: FUJI.tokens.usdc as Address,
  earnOwner: FUJI.accounts.deployer as Address, // 0x09Ce… — impersonated through the Tenderly MCP, never signed here
}
const CHAIN_ID = 43113n

// anvil well-known throwaway keys (#0..#8). NEVER real user keys.
const K = {
  bundler: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  ownerA: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  ownerB: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  ownerC: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  agent: '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
  relayer: '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
  stranger: '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e',
  allowed: '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356',
  agent2: '0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97',
} as const
const P = Object.fromEntries(Object.entries(K).map(([k, v]) => [k, privateKeyToAccount(v as Hex)])) as Record<keyof typeof K, ReturnType<typeof privateKeyToAccount>>

// ───────────────────────────────────────────────────────────── clients

const RPC = process.env.VNET_RPC
if (!RPC) throw new Error('VNET_RPC env is required')
const pub = createPublicClient({ chain: avalancheFuji, transport: http(RPC) })
const wallet = (acct: ReturnType<typeof privateKeyToAccount>) =>
  createWalletClient({ chain: avalancheFuji, transport: http(RPC), account: acct })

// ───────────────────────────────────────────────────────────── state + logging

type State = Record<string, any>
const loadState = (): State => (existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {})
const saveState = (s: State) => writeFileSync(STATE_FILE, JSON.stringify(s, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2))
const state = loadState()
const out = (o: unknown) => console.log(JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2))
const logTx = (o: Record<string, unknown>) => appendFileSync(LOG_FILE, JSON.stringify({ at: new Date().toISOString(), ...o }, (_, v) => (typeof v === 'bigint' ? v.toString() : v)) + '\n')

// ───────────────────────────────────────────────────────────── helpers

const USDC = (n: number) => BigInt(Math.round(n * 1e6))
const sel = (sig: string) => keccak256(toBytes(sig)).slice(0, 10) as Hex

function revertData(e: any): Hex | undefined {
  const cands = [e?.data, e?.cause?.data, e?.cause?.cause?.data, e?.details, e?.cause?.details, e?.message]
  for (const c of cands) {
    if (typeof c === 'string' && /^0x[0-9a-fA-F]*$/.test(c)) return c as Hex
    if (typeof c === 'string') { const m = c.match(/0x[0-9a-fA-F]{8,}/); if (m) return m[0] as Hex }
    if (c && typeof c === 'object' && typeof c.data === 'string') return c.data as Hex
  }
  return undefined
}

function decodeErr(data?: Hex): { errorName?: string; args?: unknown[]; inner?: unknown; raw?: Hex } {
  if (!data || data === '0x') return { raw: data }
  try {
    const d = decodeErrorResult({ abi: ALL_ABI, data })
    const res: any = { errorName: d.errorName, args: d.args, raw: data }
    // FailedOpWithRevert(idx, reason, inner) / FailToCallOnInstall(plugin, inner) / RuntimeValidationFailed(plugin,id,inner)
    const innerIdx = d.errorName === 'FailedOpWithRevert' ? 2 : d.errorName === 'FailToCallOnInstall' ? 1 : d.errorName === 'RuntimeValidationFailed' ? 2 : -1
    if (innerIdx >= 0 && d.args && typeof d.args[innerIdx] === 'string') res.inner = decodeErr(d.args[innerIdx] as Hex)
    return res
  } catch {
    return { raw: data }
  }
}

async function simulate(from: Address, to: Address, data: Hex, value = 0n) {
  try {
    const r = await pub.request({ method: 'eth_call', params: [{ from, to, data, value: toHex(value) }, 'latest'] } as any)
    return { ok: true, result: r as Hex }
  } catch (e: any) {
    return { ok: false, error: decodeErr(revertData(e)), message: String(e?.shortMessage ?? e?.message ?? e).slice(0, 200) }
  }
}

async function sendTx(label: string, signer: ReturnType<typeof privateKeyToAccount>, tx: { to?: Address; data?: Hex; value?: bigint; gas?: bigint }) {
  const sim = tx.to ? await simulate(signer.address, tx.to, tx.data ?? '0x', tx.value ?? 0n) : { ok: true }
  if (process.env.DRY) {
    const entry = { label, DRY_RUN: true, from: signer.address, to: tx.to, data: tx.data, simulate: sim }
    logTx({ kind: 'tx-dry', ...entry })
    return { rcpt: { transactionHash: '0x', contractAddress: undefined } as any, entry }
  }
  const hash = await wallet(signer).sendTransaction({ to: tx.to, data: tx.data, value: tx.value ?? 0n, gas: tx.gas ?? 6_000_000n, maxFeePerGas: 30_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n })
  const rcpt = await pub.waitForTransactionReceipt({ hash })
  const entry = { label, from: signer.address, to: tx.to ?? rcpt.contractAddress, hash, status: rcpt.status, block: rcpt.blockNumber, gasUsed: rcpt.gasUsed, contractAddress: rcpt.contractAddress, simulate: sim }
  logTx(entry)
  return { rcpt, entry }
}

// EntryPoint v0.7 PackedUserOperation
type Op = { sender: Address; nonce: bigint; initCode: Hex; callData: Hex; accountGasLimits: Hex; preVerificationGas: bigint; gasFees: Hex; paymasterAndData: Hex; signature: Hex }
const packGas = (a: bigint, b: bigint): Hex => concatHex([pad(toHex(a), { size: 16 }), pad(toHex(b), { size: 16 })])
const OWNER_GAS = { verification: 2_000_000n, call: 3_000_000n, preVerification: 100_000n, maxFee: 30_000_000_000n, maxPriority: 1_000_000_000n }
const SK_GAS = { verification: 1_000_000n, call: 1_000_000n, preVerification: 100_000n, maxFee: 30_000_000_000n, maxPriority: 1_000_000_000n }

async function userOpHash(op: Op): Promise<Hex> {
  return (await pub.readContract({ address: A.entryPoint, abi: ABI.entryPoint, functionName: 'getUserOpHash', args: [op] })) as Hex
}

/** BaseMultisigPlugin._getMinimalUserOpDigest: gas fields + paymasterAndData zeroed, then (h, entryPoint, chainId). */
function minimalDigest(op: Op): Hex {
  const h = keccak256(encodeAbiParameters(parseAbiParameters('address,uint256,bytes32,bytes32,bytes32,uint256,bytes32,bytes32'), [
    op.sender, op.nonce, keccak256(op.initCode), keccak256(op.callData), pad('0x0', { size: 32 }), 0n, pad('0x0', { size: 32 }), keccak256('0x'),
  ]))
  return keccak256(encodeAbiParameters(parseAbiParameters('bytes32,address,uint256'), [h, A.entryPoint, CHAIN_ID]))
}

/** Weighted multisig wire format: k×65-byte chunks ascending by owner address; chunk 0 signs the ACTUAL digest (v+32), the rest the MINIMAL digest. */
async function signOwners(op: Op, signers: ReturnType<typeof privateKeyToAccount>[]): Promise<Hex> {
  const sorted = [...signers].sort((x, y) => (hexToBigInt(x.address) < hexToBigInt(y.address) ? -1 : 1))
  const actual = hashMessage({ raw: await userOpHash(op) })
  const minimal = hashMessage({ raw: minimalDigest(op) })
  let sig: Hex = '0x'
  for (let i = 0; i < sorted.length; i++) {
    const s = await sorted[i].sign({ hash: i === 0 ? actual : minimal })
    let v = parseInt(s.slice(-2), 16)
    if (i === 0) v += 32
    sig = concatHex([sig, (s.slice(0, -2) + v.toString(16).padStart(2, '0')) as Hex])
  }
  return sig
}

async function buildOwnerOp(sender: Address, callData: Hex, gas = OWNER_GAS): Promise<Op> {
  const nonce = (await pub.readContract({ address: A.entryPoint, abi: ABI.entryPoint, functionName: 'getNonce', args: [sender, 0n] })) as bigint
  return { sender, nonce, initCode: '0x', callData, accountGasLimits: packGas(gas.verification, gas.call), preVerificationGas: gas.preVerification, gasFees: packGas(gas.maxPriority, gas.maxFee), paymasterAndData: '0x', signature: '0x' }
}

type Call = { target: Address; value: bigint; data: Hex }
const encodeSK = (calls: Call[], key: Address): Hex => encodeFunctionData({ abi: ABI.sessionKey, functionName: 'executeWithSessionKey', args: [calls, key] })

async function buildSessionOp(sender: Address, calls: Call[], agent: ReturnType<typeof privateKeyToAccount>, gas = SK_GAS): Promise<Op> {
  const nonceKey = hexToBigInt(agent.address) // the plugin's rule for gas-limited keys; harmless otherwise
  const nonce = (await pub.readContract({ address: A.entryPoint, abi: ABI.entryPoint, functionName: 'getNonce', args: [sender, nonceKey] })) as bigint
  const op: Op = { sender, nonce, initCode: '0x', callData: encodeSK(calls, agent.address), accountGasLimits: packGas(gas.verification, gas.call), preVerificationGas: gas.preVerification, gasFees: packGas(gas.maxPriority, gas.maxFee), paymasterAndData: '0x', signature: '0x' }
  op.signature = await agent.sign({ hash: hashMessage({ raw: await userOpHash(op) }) })
  return op
}

const handleOpsData = (op: Op) => encodeFunctionData({ abi: ABI.entryPoint, functionName: 'handleOps', args: [[op], P.bundler.address] })

/** Submit one op. Simulates first (to decode a validation revert), then sends on-chain regardless so Tenderly has the trace. */
async function runOp(label: string, op: Op) {
  const data = handleOpsData(op)
  const sim = await simulate(P.bundler.address, A.entryPoint, data)
  if (process.env.DRY) {
    const entry = { label, DRY_RUN: true, userOpHash: await userOpHash(op), validationSimulation: sim, handleOpsCalldata: data, from: P.bundler.address, to: A.entryPoint }
    logTx({ kind: 'userOp-dry', ...entry, opNonce: op.nonce, sender: op.sender })
    return entry as any
  }
  const hash = await wallet(P.bundler).sendTransaction({ to: A.entryPoint, data, gas: 8_000_000n, maxFeePerGas: 30_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n })
  const rcpt = await pub.waitForTransactionReceipt({ hash })
  let opSuccess: boolean | undefined, actualGasCost: bigint | undefined, actualGasUsed: bigint | undefined, revertReason: any
  for (const l of rcpt.logs) {
    try {
      const ev = decodeEventLog({ abi: ABI.entryPoint, data: l.data, topics: l.topics })
      if (ev.eventName === 'UserOperationEvent') { opSuccess = (ev.args as any).success; actualGasCost = (ev.args as any).actualGasCost; actualGasUsed = (ev.args as any).actualGasUsed }
      if (ev.eventName === 'UserOperationRevertReason') revertReason = decodeErr((ev.args as any).revertReason)
    } catch { /* not an EP event */ }
  }
  const entry = { label, hash, txStatus: rcpt.status, block: rcpt.blockNumber, txGasUsed: rcpt.gasUsed, userOpHash: await userOpHash(op), opSuccess, actualGasCost, actualGasUsed, revertReason, validationSimulation: sim }
  logTx({ kind: 'userOp', ...entry, opNonce: op.nonce, sender: op.sender })
  return entry
}

// reads
const read = (address: Address, abi: any, functionName: string, args: unknown[] = []) => pub.readContract({ address, abi, functionName, args }) as Promise<any>
const bal = (who: Address) => read(A.usdc, ERC20_ABI, 'balanceOf', [who]) as Promise<bigint>
const installed = (msca: Address) => read(msca, ABI.msca, 'getInstalledPlugins') as Promise<Address[]>
const fnConfig = (msca: Address, selector: Hex) => read(msca, ABI.msca, 'getExecutionFunctionConfig', [selector])
const preHooks = (msca: Address, selector: Hex) => read(msca, ABI.msca, 'getPreValidationHooks', [selector])
const execHooks = (msca: Address, selector: Hex) => read(msca, ABI.msca, 'getExecutionHooks', [selector])
const manifestHashOf = async (plugin: Address) => keccak256((await pub.request({ method: 'eth_call', params: [{ to: plugin, data: sel('pluginManifest()') }, 'latest'] } as any)) as Hex)

// encoders
const perm = {
  allowAll: () => encodeFunctionData({ abi: PERM_ABI, functionName: 'setAccessListType', args: [2] }),
  addr: (t: Address, on: boolean, checkSel: boolean) => encodeFunctionData({ abi: PERM_ABI, functionName: 'updateAccessListAddressEntry', args: [t, on, checkSel] }),
  fn: (t: Address, s: Hex, on: boolean) => encodeFunctionData({ abi: PERM_ABI, functionName: 'updateAccessListFunctionEntry', args: [t, s, on] }),
  time: (a: number, u: number) => encodeFunctionData({ abi: PERM_ABI, functionName: 'updateTimeRange', args: [a, u] }),
  native: (l: bigint, i: number) => encodeFunctionData({ abi: PERM_ABI, functionName: 'setNativeTokenSpendLimit', args: [l, i] }),
  erc20: (t: Address, l: bigint, i: number) => encodeFunctionData({ abi: PERM_ABI, functionName: 'setERC20SpendLimit', args: [t, l, i] }),
}
const deps = (): { plugin: Address; functionId: number }[] => [{ plugin: A.weighted, functionId: 1 }, { plugin: A.weighted, functionId: 0 }]
const installCalldata = (plugin: Address, manifestHash: Hex, installData: Hex, dependencies: { plugin: Address; functionId: number }[]) =>
  encodeFunctionData({ abi: ABI.msca, functionName: 'installPlugin', args: [plugin, manifestHash, installData, dependencies] })
const uninstallCalldata = (plugin: Address) => encodeFunctionData({ abi: ABI.msca, functionName: 'uninstallPlugin', args: [plugin, '0x', '0x'] })
const executeCalldata = (target: Address, value: bigint, data: Hex) => encodeFunctionData({ abi: ABI.msca, functionName: 'execute', args: [target, value, data] })
const erc20Transfer = (to: Address, amount: bigint): Call => ({ target: A.usdc, value: 0n, data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [to, amount] }) })
const erc20Approve = (spender: Address, amount: bigint): Call => ({ target: A.usdc, value: 0n, data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [spender, amount] }) })
const nativeTransfer = (to: Address, amount: bigint): Call => ({ target: to, value: amount, data: '0x' })
const SEL = {
  executeWithSessionKey: sel('executeWithSessionKey((address,uint256,bytes)[],address)'),
  addSessionKey: sel('addSessionKey(address,bytes32,bytes[])'),
  removeSessionKey: sel('removeSessionKey(address,bytes32)'),
  rotateSessionKey: sel('rotateSessionKey(address,bytes32,address)'),
  updateKeyPermissions: sel('updateKeyPermissions(address,bytes[])'),
  execute: sel('execute(address,uint256,bytes)'),
  executeBatch: sel('executeBatch((address,uint256,bytes)[])'),
  executeFromPluginExternal: sel('executeFromPluginExternal(address,uint256,bytes)'),
  autoEarn: sel('autoEarn(address,uint256)'),
  changeConfigHash: sel('changeConfigHash(uint256)'),
  transfer: sel('transfer(address,uint256)'),
  approve: sel('approve(address,uint256)'),
}

const quorum = () => [P.ownerA, P.ownerB]
const msca = (): Address => { if (!state.msca) throw new Error('run create-msca first'); return state.msca }

// ───────────────────────────────────────────────────────────── commands

const commands: Record<string, (args: string[]) => Promise<void>> = {
  async inventory() {
    const block = await pub.getBlock()
    const codes: Record<string, number> = {}
    for (const [k, v] of Object.entries(A)) codes[k] = ((await pub.getCode({ address: v })) ?? '0x').length / 2 - 1
    out({
      chainId: await pub.getChainId(), block: block.number, timestamp: block.timestamp, baseFeePerGas: block.baseFeePerGas,
      codeBytes: codes,
      manifestHashes: {
        weighted: await manifestHashOf(A.weighted), addressBook: await manifestHashOf(A.addressBook), sessionKey: await manifestHashOf(A.sessionKey), earn: await manifestHashOf(A.earn),
        expected: { weighted: FUJI.plugins.weightedWebauthnMultisig.manifestHash, addressBook: FUJI.plugins.coldStorageAddressBook.manifestHash, sessionKey: FUJI.plugins.bufiSessionKey.manifestHash, earn: FUJI.plugins.bufiEarnModule.manifestHash },
      },
      factoryOwner: await read(A.factory, ABI.factory, 'owner'),
      isPluginAllowed: { weighted: await read(A.factory, ABI.factory, 'isPluginAllowed', [A.weighted]), addressBook: await read(A.factory, ABI.factory, 'isPluginAllowed', [A.addressBook]), sessionKey: await read(A.factory, ABI.factory, 'isPluginAllowed', [A.sessionKey]), earn: await read(A.factory, ABI.factory, 'isPluginAllowed', [A.earn]) },
      earn: { owner: await read(A.earn, ABI.earn, 'owner'), relayerIsDeployer: await read(A.earn, ABI.earn, 'authorizedRelayers', [A.earnOwner]) },
      personas: Object.fromEntries(Object.entries(P).map(([k, v]) => [k, v.address])),
      balances: Object.fromEntries(await Promise.all(Object.entries(P).map(async ([k, v]) => [k, await pub.getBalance({ address: v.address })]))),
    })
  },

  async 'deploy-hook'() {
    const salt = keccak256(toBytes('bufi-6900-plugins-v0.1.0'))
    const expected = getCreate2Address({ from: A.create2, salt, bytecode: HOOK_CREATION })
    const { rcpt, entry } = await sendTx('deploy BufiSessionRecipientHookPlugin (CREATE2 via Arachnid deployer)', P.bundler, { to: A.create2, data: concatHex([salt, HOOK_CREATION]), gas: 4_000_000n })
    const code = await pub.getCode({ address: expected })
    state.hook = expected; state.hookDeployTx = rcpt.transactionHash; saveState(state)
    out({ ...entry, salt, expected, codeBytes: (code ?? '0x').length / 2 - 1, manifestHash: await manifestHashOf(expected), supportsIPlugin: await read(expected, ABI.hook, 'supportsInterface', ['0x0f16f6a6' as Hex]) })
  },

  async 'deploy-vault'(args) {
    const name = args[0] ?? 'vaultA'
    const { rcpt, entry } = await sendTx(`deploy MockVault(${name}) over Fuji USDC`, P.bundler, { data: concatHex([VAULT_CREATION, encodeAbiParameters(parseAbiParameters('address'), [A.usdc])]), gas: 4_000_000n })
    state[name] = rcpt.contractAddress; saveState(state)
    out({ ...entry, name, asset: await read(rcpt.contractAddress!, ABI.vault, 'asset'), decimals: await read(rcpt.contractAddress!, ABI.vault, 'decimals'), totalAssets: await read(rcpt.contractAddress!, ABI.vault, 'totalAssets') })
  },

  async 'create-msca'() {
    const owners = [P.ownerA, P.ownerB, P.ownerC].sort((x, y) => (hexToBigInt(x.address) < hexToBigInt(y.address) ? -1 : 1)).map((o) => o.address)
    const weightedHash = await manifestHashOf(A.weighted)
    const installData = encodeAbiParameters(parseAbiParameters('address[],uint256[],(uint256,uint256)[],uint256[],uint256'), [owners, [1n, 1n, 1n], [], [], 2n])
    const initializingData = encodeAbiParameters(parseAbiParameters('address[],bytes32[],bytes[]'), [[A.weighted], [weightedHash], [installData]])
    const sender = pad(P.ownerA.address, { size: 32 })
    const salt = keccak256(toBytes('bufi-6900-fuji-audit'))
    const [counterfactual, mixedSalt] = (await read(A.factory, ABI.factory, 'getAddress', [sender, salt, initializingData])) as [Address, Hex]
    const { entry } = await sendTx('factory.createAccount (2-of-3 weighted)', P.bundler, { to: A.factory, data: encodeFunctionData({ abi: ABI.factory, functionName: 'createAccount', args: [sender, salt, initializingData] }), gas: 3_000_000n })
    state.msca = counterfactual; state.owners = owners; state.createTx = entry.hash; saveState(state)
    const meta = await read(A.weighted, ABI.weighted, 'ownershipInfoOf', [counterfactual]).catch(() => 'n/a')
    out({ ...entry, msca: counterfactual, mixedSalt, owners, threshold: 2, installedPlugins: await installed(counterfactual), ownershipInfo: meta, codeBytes: ((await pub.getCode({ address: counterfactual })) ?? '0x').length / 2 - 1 })
  },

  async 'balances'() {
    const m = msca()
    out({ msca: m, usdc: { msca: await bal(m), allowed: await bal(P.allowed.address), stranger: await bal(P.stranger.address), vaultA: state.vaultA ? await bal(state.vaultA) : null, vaultB: state.vaultB ? await bal(state.vaultB) : null }, native: { msca: await pub.getBalance({ address: m }), allowed: await pub.getBalance({ address: P.allowed.address }), stranger: await pub.getBalance({ address: P.stranger.address }) }, epDeposit: await read(A.entryPoint, ABI.entryPoint, 'balanceOf', [m]), installed: await installed(m) })
  },

  // S1 — install session-key plugin with fail-closed dependency slots
  async s1() {
    const m = msca()
    const hash = await manifestHashOf(A.sessionKey)
    const installData = encodeAbiParameters(parseAbiParameters('address[],bytes32[],bytes[][]'), [[], [], []])
    const op = await buildOwnerOp(m, installCalldata(A.sessionKey, hash, installData, deps()))
    op.signature = await signOwners(op, quorum())
    const res = await runOp('S1 installPlugin(BufiSessionKeyPlugin) via 2-of-3 userOp', op)
    const cfg: Record<string, any> = {}
    for (const [k, s] of Object.entries(SEL).filter(([k]) => ['executeWithSessionKey', 'addSessionKey', 'removeSessionKey', 'rotateSessionKey', 'updateKeyPermissions'].includes(k))) cfg[k] = await fnConfig(m, s)
    // runtime path to key management must be fail-closed (Weighted id 1 unimplemented): owner EOA + agent EOA.
    const addKeyData = encodeFunctionData({ abi: ABI.sessionKey, functionName: 'addSessionKey', args: [P.agent.address, pad('0x0', { size: 32 }), []] })
    const runtimeOwner = await sendTx('S1 runtime addSessionKey from owner EOA (expect RuntimeValidationFailed)', P.ownerA, { to: m, data: addKeyData, gas: 500_000n })
    const runtimeStranger = await simulate(P.stranger.address, m, addKeyData)
    // below quorum: a single owner signature must be rejected at validation
    const solo = await buildOwnerOp(m, encodeFunctionData({ abi: ABI.sessionKey, functionName: 'addSessionKey', args: [P.stranger.address, pad('0x0', { size: 32 }), []] }))
    solo.signature = await signOwners(solo, [P.ownerA])
    const soloRes = await runOp('S1 addSessionKey signed by ONE owner (expect AA24 / validation revert)', solo)
    out({ install: res, installed: await installed(m), executionFunctionConfigs: cfg, preValidationHooks_executeWithSessionKey: await preHooks(m, SEL.executeWithSessionKey), runtimeOwner: runtimeOwner.entry, runtimeStrangerSim: runtimeStranger, soloOwner: soloRes, isSessionKeyOf_agent: await read(A.sessionKey, ABI.sessionKey, 'isSessionKeyOf', [m, P.agent.address]), isSessionKeyOf_stranger: await read(A.sessionKey, ABI.sessionKey, 'isSessionKeyOf', [m, P.stranger.address]) })
  },

  // S2 — owners grant {USDC.transfer, 500 USDC / 1 day, valid 7 days}; agent spends 200 within budget
  async s2() {
    const m = msca()
    const now = Number((await pub.getBlock()).timestamp)
    const validUntil = now + 7 * 86_400
    state.grant = { limit: '500e6', refreshInterval: 86_400, validAfter: 0, validUntil }; saveState(state)
    const updates = [perm.addr(A.usdc, true, true), perm.fn(A.usdc, SEL.transfer, true), perm.erc20(A.usdc, USDC(500), 86_400), perm.time(0, validUntil)]
    const op = await buildOwnerOp(m, encodeFunctionData({ abi: ABI.sessionKey, functionName: 'addSessionKey', args: [P.agent.address, pad(toHex(toBytes('bu-agent')), { size: 32, dir: 'right' }), updates] }))
    op.signature = await signOwners(op, quorum())
    const grant = await runOp('S2 addSessionKey(agent, grant) via 2-of-3 userOp', op)
    const before = { msca: await bal(m), allowed: await bal(P.allowed.address) }
    const spend = await runOp('S2 agent executeWithSessionKey transfer 200 USDC -> allowed', await buildSessionOp(m, [erc20Transfer(P.allowed.address, USDC(200))], P.agent))
    const after = { msca: await bal(m), allowed: await bal(P.allowed.address) }
    out({ grant, keys: await read(A.sessionKey, ABI.sessionKey, 'sessionKeysOf', [m]), timeRange: await read(A.sessionKey, ABI.sessionKey, 'getKeyTimeRange', [m, P.agent.address]), accessEntry: await read(A.sessionKey, ABI.sessionKey, 'getAccessControlEntry', [m, P.agent.address, A.usdc]), transferOnList: await read(A.sessionKey, ABI.sessionKey, 'isSelectorOnAccessControlList', [m, P.agent.address, A.usdc, SEL.transfer]), spend, before, after, limitInfo: await read(A.sessionKey, ABI.sessionKey, 'getERC20SpendLimitInfo', [m, P.agent.address, A.usdc]) })
  },

  // S3 — over budget: 200 used + 400 > 500 → execution-phase revert, gas paid, no funds move
  async s3() {
    const m = msca()
    const before = { msca: await bal(m), allowed: await bal(P.allowed.address), native: await pub.getBalance({ address: m }), epDeposit: await read(A.entryPoint, ABI.entryPoint, 'balanceOf', [m]) }
    const res = await runOp('S3 agent transfer 400 USDC (over the 500/day budget after 200 used)', await buildSessionOp(m, [erc20Transfer(P.allowed.address, USDC(400))], P.agent))
    const after = { msca: await bal(m), allowed: await bal(P.allowed.address), native: await pub.getBalance({ address: m }), epDeposit: await read(A.entryPoint, ABI.entryPoint, 'balanceOf', [m]) }
    out({ res, before, after, nativeDelta: after.native - before.native, epDepositDelta: after.epDeposit - before.epDeposit, limitInfo: await read(A.sessionKey, ABI.sessionKey, 'getERC20SpendLimitInfo', [m, P.agent.address, A.usdc]) })
  },

  // S4 — expired key (run AFTER increase_time via MCP)
  async s4() {
    const m = msca()
    const block = await pub.getBlock()
    const res = await runOp('S4 agent transfer 1 USDC after validUntil (expect AA22)', await buildSessionOp(m, [erc20Transfer(P.allowed.address, USDC(1))], P.agent))
    out({ blockTimestamp: block.timestamp, validUntil: state.grant?.validUntil, res, allowedBalance: await bal(P.allowed.address) })
  },

  // S4b — owners re-arm the expired key in place (updateKeyPermissions → new validUntil), so S5+ run against a live key.
  // Also a positive control: the very same key that was AA22 a block ago succeeds once the owners extend the window.
  async 's4-rearm'() {
    const m = msca()
    const now = Number((await pub.getBlock()).timestamp)
    const validUntil = now + 7 * 86_400
    const before = await read(A.sessionKey, ABI.sessionKey, 'getKeyTimeRange', [m, P.agent.address])
    const op = await buildOwnerOp(m, encodeFunctionData({ abi: ABI.sessionKey, functionName: 'updateKeyPermissions', args: [P.agent.address, [perm.time(0, validUntil)]] }))
    op.signature = await signOwners(op, quorum())
    const rearm = await runOp('S4 owners updateKeyPermissions(agent, updateTimeRange(0, now+7d)) via 2-of-3 userOp', op)
    state.grant = { ...(state.grant ?? {}), validAfter: 0, validUntil, rearmedAtTimestamp: now, previousValidUntil: state.grant?.validUntil }; saveState(state)
    const allowedBefore = await bal(P.allowed.address)
    const probe = await runOp('S4 agent transfer 1 USDC -> allowed after re-arm (expect success)', await buildSessionOp(m, [erc20Transfer(P.allowed.address, USDC(1))], P.agent))
    out({ blockTimestamp: now, newValidUntil: validUntil, timeRangeBefore: before, rearm, timeRangeAfter: await read(A.sessionKey, ABI.sessionKey, 'getKeyTimeRange', [m, P.agent.address]), probe, allowedBefore, allowedAfter: await bal(P.allowed.address), limitInfo: await read(A.sessionKey, ABI.sessionKey, 'getERC20SpendLimitInfo', [m, P.agent.address, A.usdc]) })
  },

  // read-only view of the earn module + both vault configs (hashes recomputed exactly as s8-calldata does)
  async 'earn-read'() {
    const m = msca()
    const hashFor = (vault: Address) => hexToBigInt(keccak256(encodeAbiParameters(parseAbiParameters('(uint256,address,address)[]'), [[[CHAIN_ID, A.usdc, vault]]])))
    const hA = state.vaultA ? hashFor(state.vaultA) : 0n, hB = state.vaultB ? hashFor(state.vaultB) : 0n
    out({
      owner: await read(A.earn, ABI.earn, 'owner'),
      relayerAuthorized: await read(A.earn, ABI.earn, 'authorizedRelayers', [P.relayer.address]),
      deployerAuthorized: await read(A.earn, ABI.earn, 'authorizedRelayers', [A.earnOwner]),
      strangerAuthorized: await read(A.earn, ABI.earn, 'authorizedRelayers', [P.stranger.address]),
      hashA: hA.toString(), hashAHex: toHex(hA), configA_usdc: hA ? await read(A.earn, ABI.earn, 'config', [hA, CHAIN_ID, A.usdc]) : null,
      hashB: hB.toString(), hashBHex: toHex(hB), configB_usdc: hB ? await read(A.earn, ABI.earn, 'config', [hB, CHAIN_ID, A.usdc]) : null,
      accountConfig: await read(A.earn, ABI.earn, 'accountConfig', [m]),
      installed: await installed(m),
      vaultA: state.vaultA ? { asset: await read(state.vaultA, ABI.vault, 'asset'), totalAssets: await read(state.vaultA, ABI.vault, 'totalAssets'), mscaShares: await read(state.vaultA, ABI.vault, 'balanceOf', [m]) } : null,
      vaultB: state.vaultB ? { asset: await read(state.vaultB, ABI.vault, 'asset'), totalAssets: await read(state.vaultB, ABI.vault, 'totalAssets'), mscaShares: await read(state.vaultB, ABI.vault, 'balanceOf', [m]) } : null,
    })
  },

  // S5 — off-scope: selector (approve) and target (vault / stranger contract) outside the access list
  async s5() {
    const m = msca()
    const a = await runOp('S5 agent USDC.approve(stranger) — selector off-scope (expect AA23 PermissionsCheckFailed)', await buildSessionOp(m, [erc20Approve(P.stranger.address, USDC(1))], P.agent))
    const target = (state.vaultA ?? A.weighted) as Address
    const b = await runOp('S5 agent call to a target off the access list (expect AA23 PermissionsCheckFailed)', await buildSessionOp(m, [{ target, value: 0n, data: sel('totalAssets()') }], P.agent))
    const c = await runOp('S5 agent native transfer 1 wei to allowed — native limit is 0 by default (expect AA23)', await buildSessionOp(m, [nativeTransfer(P.allowed.address, 1n)], P.agent))
    out({ approve: a, offTarget: b, nativeZeroLimit: c, allowance: await read(A.usdc, ERC20_ABI, 'allowance', [m, P.stranger.address]) })
  },

  // S6 — AddressBook installed with [allowed]; owners' execute to a stranger rejected; agent pays the stranger (gap)
  async s6() {
    const m = msca()
    const hash = await manifestHashOf(A.addressBook)
    const op = await buildOwnerOp(m, installCalldata(A.addressBook, hash, encodeAbiParameters(parseAbiParameters('address[]'), [[P.allowed.address]]), deps()))
    op.signature = await signOwners(op, quorum())
    const install = await runOp('S6 installPlugin(ColdStorageAddressBookPlugin, [allowed]) via 2-of-3 userOp', op)
    const own = await buildOwnerOp(m, executeCalldata(A.usdc, 0n, encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [P.stranger.address, USDC(1)] })))
    own.signature = await signOwners(own, quorum())
    const ownersToStranger = await runOp('S6 owners execute(USDC.transfer(stranger)) (expect AA23 UnauthorizedRecipient from AddressBook)', own)
    const ok = await buildOwnerOp(m, executeCalldata(A.usdc, 0n, encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [P.allowed.address, USDC(1)] })))
    ok.signature = await signOwners(ok, quorum())
    const ownersToAllowed = await runOp('S6 owners execute(USDC.transfer(allowed)) (expect success)', ok)
    const before = await bal(P.stranger.address)
    const agentToStranger = await runOp('S6 agent transfer 10 USDC -> stranger (GAP: AddressBook does not hook executeWithSessionKey)', await buildSessionOp(m, [erc20Transfer(P.stranger.address, USDC(10))], P.agent))
    out({ install, installed: await installed(m), allowlist: await read(A.addressBook, ABI.addressBook, 'getAllowedRecipients', [m]), hooks: { execute: await preHooks(m, SEL.execute), executeBatch: await preHooks(m, SEL.executeBatch), executeWithSessionKey: await preHooks(m, SEL.executeWithSessionKey), execHooks_executeFromPluginExternal: await execHooks(m, SEL.executeFromPluginExternal) }, ownersToStranger, ownersToAllowed, agentToStranger, strangerBefore: before, strangerAfter: await bal(P.stranger.address) })
  },

  // S7 — install the recipient hook bound to the AddressBook; stranger rejected, allowed passes, approve(stranger) rejected
  async s7() {
    const m = msca(); const hook = state.hook as Address
    const hash = await manifestHashOf(hook)
    const op = await buildOwnerOp(m, installCalldata(hook, hash, encodeAbiParameters(parseAbiParameters('address'), [A.addressBook]), []))
    op.signature = await signOwners(op, quorum())
    const install = await runOp('S7 installPlugin(BufiSessionRecipientHookPlugin, abi.encode(addressBook)) via 2-of-3 userOp', op)
    const strangerBefore = await bal(P.stranger.address); const allowedBefore = await bal(P.allowed.address)
    const toStranger = await runOp('S7 agent transfer 10 USDC -> stranger (expect AA23 UnauthorizedRecipient from the hook)', await buildSessionOp(m, [erc20Transfer(P.stranger.address, USDC(10))], P.agent))
    const toAllowed = await runOp('S7 agent transfer 10 USDC -> allowed (expect success through the hook)', await buildSessionOp(m, [erc20Transfer(P.allowed.address, USDC(10))], P.agent))
    // second, UNRESTRICTED key so approve/native are within the key's own access list and only the hook decides
    const g = await buildOwnerOp(m, encodeFunctionData({ abi: ABI.sessionKey, functionName: 'addSessionKey', args: [P.agent2.address, pad(toHex(toBytes('unrestricted')), { size: 32, dir: 'right' }), [perm.allowAll(), perm.native(2n ** 256n - 1n, 0)]] }))
    g.signature = await signOwners(g, quorum())
    const grant2 = await runOp('S7 addSessionKey(agent2, unrestricted) via 2-of-3 userOp', g)
    const approveStranger = await runOp('S7 agent2 USDC.approve(stranger) (expect AA23 UnauthorizedRecipient: spender is the recipient)', await buildSessionOp(m, [erc20Approve(P.stranger.address, USDC(5))], P.agent2))
    const approveAllowed = await runOp('S7 agent2 USDC.approve(allowed) (expect success)', await buildSessionOp(m, [erc20Approve(P.allowed.address, USDC(5))], P.agent2))
    const nativeStranger = await runOp('S7 agent2 native 0.01 AVAX -> stranger (expect AA23 UnauthorizedRecipient)', await buildSessionOp(m, [nativeTransfer(P.stranger.address, 10n ** 16n)], P.agent2))
    const mixed = await runOp('S7 agent2 batch [USDC->allowed, native->stranger] (expect AA23, whole batch rejected)', await buildSessionOp(m, [erc20Transfer(P.allowed.address, USDC(1)), nativeTransfer(P.stranger.address, 10n ** 16n)], P.agent2))
    out({ install, installed: await installed(m), hookBoundTo: await read(hook, ABI.hook, 'addressBookOf', [m]), hooksOnSelector: await preHooks(m, SEL.executeWithSessionKey), toStranger, toAllowed, grant2, approveStranger, approveAllowed, nativeStranger, mixed, balances: { strangerBefore, strangerAfter: await bal(P.stranger.address), allowedBefore, allowedAfter: await bal(P.allowed.address) }, allowanceStranger: await read(A.usdc, ERC20_ABI, 'allowance', [m, P.stranger.address]), allowanceAllowed: await read(A.usdc, ERC20_ABI, 'allowance', [m, P.allowed.address]) })
  },

  // S8 — print the impersonated owner calldata (submitted through the Tenderly MCP as 0x09Ce…)
  async 's8-calldata'(args) {
    const vault = (args[0] === 'B' ? state.vaultB : state.vaultA) as Address
    const cfg = [{ chainId: CHAIN_ID, token: A.usdc, vault }]
    const configHash = hexToBigInt(keccak256(encodeAbiParameters(parseAbiParameters('(uint256,address,address)[]'), [cfg.map((c) => [c.chainId, c.token, c.vault] as const)])))
    out({ earnOwner: A.earnOwner, earn: A.earn, vault, configHash: configHash.toString(), configHashHex: toHex(configHash), setConfig: encodeFunctionData({ abi: ABI.earn, functionName: 'setConfig', args: [cfg] }), addAuthorizedRelayer: encodeFunctionData({ abi: ABI.earn, functionName: 'addAuthorizedRelayer', args: [P.relayer.address] }), relayer: P.relayer.address })
  },
  async 's8-install'(args) {
    const m = msca(); const configHash = BigInt(args[0])
    const hash = await manifestHashOf(A.earn)
    const op = await buildOwnerOp(m, installCalldata(A.earn, hash, encodeAbiParameters(parseAbiParameters('uint256'), [configHash]), deps()))
    op.signature = await signOwners(op, quorum())
    const install = await runOp('S8 installPlugin(BufiEarnModule, abi.encode(configHash)) via 2-of-3 userOp', op)
    state.configHashA = configHash.toString(); saveState(state)
    out({ install, installed: await installed(m), accountConfig: await read(A.earn, ABI.earn, 'accountConfig', [m]), configs: await read(A.earn, ABI.earn, 'getAllConfigs', [m]), autoEarnCfg: await fnConfig(m, SEL.autoEarn), changeConfigHashCfg: await fnConfig(m, SEL.changeConfigHash), relayerAuthorized: await read(A.earn, ABI.earn, 'authorizedRelayers', [P.relayer.address]) })
  },
  async 's8-sweep'(args) {
    const m = msca(); const amount = USDC(Number(args[0] ?? 100_000)); const vault = (args[1] === 'B' ? state.vaultB : state.vaultA) as Address
    const data = encodeFunctionData({ abi: ABI.earn, functionName: 'autoEarn', args: [A.usdc, amount] })
    const before = { mscaUsdc: await bal(m), vaultUsdc: await bal(vault), shares: await read(vault, ABI.vault, 'balanceOf', [m]) }
    const relayer = await sendTx('S8 relayer autoEarn (runtime call on the account)', P.relayer, { to: m, data, gas: 1_000_000n })
    const after = { mscaUsdc: await bal(m), vaultUsdc: await bal(vault), shares: await read(vault, ABI.vault, 'balanceOf', [m]), relayerShares: await read(vault, ABI.vault, 'balanceOf', [P.relayer.address]), moduleShares: await read(vault, ABI.vault, 'balanceOf', [A.earn]), allowance: await read(A.usdc, ERC20_ABI, 'allowance', [m, vault]) }
    const stranger = await sendTx('S8 stranger autoEarn (expect RuntimeValidationFailed(NotAuthorized))', P.stranger, { to: m, data, gas: 1_000_000n })
    // autoEarn through a quorum userOp must be rejected (no userOp validation function)
    const op = await buildOwnerOp(m, data); op.signature = await signOwners(op, quorum())
    const viaUserOp = await runOp('S8 autoEarn via 2-of-3 userOp (expect validation revert: no userOp validator)', op)
    out({ vault, before, after, relayer: relayer.entry, stranger: stranger.entry, viaUserOp, allowlist: await read(A.addressBook, ABI.addressBook, 'getAllowedRecipients', [m]) })
  },
  async 's8-change'(args) {
    const m = msca(); const newHash = BigInt(args[0])
    // runtime path from owner EOA is fail-closed
    const data = encodeFunctionData({ abi: ABI.earn, functionName: 'changeConfigHash', args: [newHash] })
    const runtime = await sendTx('S8 runtime changeConfigHash from owner EOA (expect RuntimeValidationFailed)', P.ownerA, { to: m, data, gas: 500_000n })
    // execute(plugin, …) is refused
    const ex = await buildOwnerOp(m, executeCalldata(A.earn, 0n, data)); ex.signature = await signOwners(ex, quorum())
    const viaExecute = await runOp('S8 execute(earn, changeConfigHash) (expect TargetIsPlugin in execution)', ex)
    const op = await buildOwnerOp(m, data); op.signature = await signOwners(op, quorum())
    const adopt = await runOp('S8 changeConfigHash(newHash) via 2-of-3 userOp', op)
    state.configHashB = newHash.toString(); saveState(state)
    out({ runtime: runtime.entry, viaExecute, adopt, accountConfig: await read(A.earn, ABI.earn, 'accountConfig', [m]), configs: await read(A.earn, ABI.earn, 'getAllConfigs', [m]) })
  },

  // S9 — uninstall ordering
  async 's9-a'() {
    const m = msca(); const hook = state.hook as Address
    const u1 = await buildOwnerOp(m, uninstallCalldata(A.sessionKey)); u1.signature = await signOwners(u1, quorum())
    const skFirst = await runOp('S9a uninstall session-key plugin while the hook is installed', u1)
    const hooksAfterSk = await preHooks(m, SEL.executeWithSessionKey)
    const u2 = await buildOwnerOp(m, uninstallCalldata(hook)); u2.signature = await signOwners(u2, quorum())
    const hookAfter = await runOp('S9a uninstall hook after the session-key plugin', u2)
    out({ skFirst, hooksAfterSk, hookAfter, hooksAfterHook: await preHooks(m, SEL.executeWithSessionKey), installed: await installed(m), hookBinding: await read(hook, ABI.hook, 'addressBookOf', [m]), sessionKeys: await read(A.sessionKey, ABI.sessionKey, 'sessionKeysOf', [m]) })
  },
  async 's9-b'() {
    const m = msca(); const hook = state.hook as Address
    const u1 = await buildOwnerOp(m, uninstallCalldata(hook)); u1.signature = await signOwners(u1, quorum())
    const hookFirst = await runOp('S9b uninstall hook first (gap reopens)', u1)
    const gap = await runOp('S9b agent transfer 1 USDC -> stranger after hook removal (expect success: gap reopened)', await buildSessionOp(m, [erc20Transfer(P.stranger.address, USDC(1))], P.agent))
    const u2 = await buildOwnerOp(m, uninstallCalldata(A.sessionKey)); u2.signature = await signOwners(u2, quorum())
    const skAfter = await runOp('S9b uninstall session-key plugin after the hook', u2)
    const w = await buildOwnerOp(m, uninstallCalldata(A.weighted)); w.signature = await signOwners(w, quorum())
    const weighted = await runOp('S9b uninstall WeightedWebauthnMultisigPlugin (expect PluginUsedByOthers: AddressBook + Earn depend on it)', w)
    out({ hookFirst, gap, skAfter, weighted, installed: await installed(m), strangerBalance: await bal(P.stranger.address) })
  },

  // S10 — emit validateUserOp calldata for one session-key op and one hook-gated op (simulated from the EntryPoint via MCP)
  async 's10-calldata'() {
    const m = msca()
    const op = await buildSessionOp(m, [erc20Transfer(P.allowed.address, USDC(1))], P.agent)
    const h = await userOpHash(op)
    out({ msca: m, entryPoint: A.entryPoint, sessionKey: P.agent.address, userOpHash: h, validateUserOp: encodeFunctionData({ abi: ABI.msca, functionName: 'validateUserOp', args: [op, h, 0n] }), op })
  },

  // classify storage keys from a Tenderly access list against ERC-7562 account-associated derivations
  async 's10-classify'(args) {
    const m = msca(); const list = JSON.parse(readFileSync(args[0], 'utf8')) as { address: Address; storageKeys: Hex[] }[]
    const acc = pad(m, { size: 32 })
    const w = (x: Hex) => pad(x, { size: 32 })
    const prefixWord = (s: string) => (keccak256(toBytes(s)).slice(0, 10) + '0'.repeat(56)) as Hex // bytes4 left-aligned
    const ALLS_PREFIX = ('0xf938c976' + '0'.repeat(56)) as Hex
    const known: Record<string, Address> = { agent: P.agent.address, agent2: P.agent2.address, allowed: P.allowed.address, stranger: P.stranger.address, usdc: A.usdc, ownerA: P.ownerA.address, ownerB: P.ownerB.address, ownerC: P.ownerC.address, msca: m, addressBook: A.addressBook }
    const cands = new Map<string, string>()
    const add = (k: Hex, label: string) => { for (let n = 0n; n <= 12n; n++) cands.set(toHex(hexToBigInt(k) + n, { size: 32 }), n === 0n ? label : `${label}+${n}`) }
    for (let s = 0n; s <= 8n; s++) {
      add(keccak256(encodeAbiParameters(parseAbiParameters('address,uint256'), [m, s])), `mapping[account] @slot${s}`)
      const vals: [string, Hex][] = [['SENTINEL', toHex(1n, { size: 32 })], ...Object.entries(known).map(([n, a]) => [n, (a.toLowerCase() + '0'.repeat(24)) as Hex] as [string, Hex])]
      for (const [n, v] of vals) add(keccak256(concatHex([acc, ALLS_PREFIX, w(toHex(s)), v])), `ALLS(slot${s})[${n}]`)
    }
    const ids = [1n, 2n, 3n, 4n]
    for (const [n, a] of Object.entries(known)) add(keccak256(concatHex([acc, prefixWord('SessionKeyId'), w(a)])), `SessionKeyId[${n}]`)
    for (const id of ids) {
      add(keccak256(concatHex([acc, prefixWord('SessionKeyData'), w(toHex(id))])), `SessionKeyData[id${id}]`)
      for (const [n, a] of Object.entries(known)) {
        add(keccak256(concatHex([acc, prefixWord('ContractData'), w(toHex(id)), w(a)])), `ContractData[id${id}][${n}]`)
        for (const [sn, s] of Object.entries(SEL)) add(keccak256(concatHex([acc, prefixWord('FunctionData'), w(toHex(id)), ((s + '0'.repeat(16) + a.slice(2)) as Hex)])), `FunctionData[id${id}][${n}.${sn}]`)
      }
    }
    const report = list.map((e) => ({ address: e.address, keys: e.storageKeys.map((k) => ({ key: k, classification: cands.get(k.toLowerCase() as Hex) ?? cands.get(k) ?? 'UNMATCHED' })) }))
    out(report)
  },
}

const [cmd, ...rest] = process.argv.slice(2)
if (!cmd || !commands[cmd]) { console.error('commands: ' + Object.keys(commands).join(', ')); process.exit(1) }
commands[cmd](rest).catch((e) => { console.error('FAILED', e?.shortMessage ?? e?.message ?? e, e?.cause?.message ?? ''); process.exit(1) })
