// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Live Gateway canary for the two pieces that previously ran in forge only (Arc testnet → Base Sepolia):
 *
 *   NESTED  GatewayTreasury v3 whose owners are EOA A (weight 2) and a real Circle v0.7 MSCA M1 (weight 1,
 *           itself 2-of-3). Gateway's enclave must follow treasury.isValidSignature → M1.isValidSignature.
 *   GUARD   A real Circle v0.7 MSCA M2 (A=2, B=1, C=1, threshold 3) with GatewayIntentGuardPlugin installed.
 *           Gateway must run the account's pre-runtime hook and treat a guard revert as an invalid signature.
 *
 * Addresses: contracts/deployments/arc-testnet.gateway-live.json (written by script/gateway-guard/LiveGatewaySetup.s.sol).
 *   DEPLOYER_PK=… bun scripts/gateway-treasury/live-nested-and-guard.ts [--only nested|guard]
 */
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  type Address,
  type Hex,
  concat,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  hashTypedData,
  http,
  keccak256,
  pad,
  parseAbi,
  toHex,
} from 'viem'
import { privateKeyToAccount, sign } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'

const arcTestnet = defineChain({
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.arc.network'] } },
})
const GATEWAY_API = 'https://gateway-api-testnet.circle.com'
const GATEWAY_WALLET: Address = '0x0077777d7EBA4688BDeF3E311b846F25870A19B9'
const GATEWAY_MINTER: Address = '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B'
const ARC_USDC: Address = '0x3600000000000000000000000000000000000000'
const BASE_USDC: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const WEIGHTED: Address = '0x0000000C984AFf541D6cE86Bb697e68ec57873C8'
const EXPIRY_BLOCKS = 1_209_599n + 2_000n
const MAX_FEE = 2_010_000n
const ENVELOPE_MAGIC = keccak256(toHex('BUFI.GatewayIntentGuard.envelope.v1'))

const ROOT = join(import.meta.dir, '..', '..')
const live = JSON.parse(readFileSync(join(ROOT, 'contracts/deployments/arc-testnet.gateway-live.json'), 'utf8')) as {
  nestedOwnerMsca: Address
  treasuryV3: Address
  guardedMsca: Address
  guardPlugin: Address
}
type K = { address: Address; privateKey: Hex }
const keys = JSON.parse(readFileSync(join(ROOT, '.sandbox/ultimate-treasury/keys.json'), 'utf8')) as Record<string, K>
const nkeys = JSON.parse(readFileSync(join(ROOT, '.sandbox/ultimate-treasury/nested-owner-keys.json'), 'utf8')) as Record<string, K>
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : undefined

const deployer = privateKeyToAccount(process.env.DEPLOYER_PK as Hex)
const arc = createPublicClient({ chain: arcTestnet, transport: http() })
const base = createPublicClient({ chain: baseSepolia, transport: http() })
const arcWallet = createWalletClient({ account: deployer, chain: arcTestnet, transport: http() })
const baseWallet = createWalletClient({ account: deployer, chain: baseSepolia, transport: http() })

const ERC20 = parseAbi(['function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)'])
const IS_VALID = parseAbi(['function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)'])
const WEIGHTED_ABI = parseAbi(['function getReplaySafeMessageHash(address account, bytes32 message) view returns (bytes32)'])
const GW_ABI = parseAbi([
  'function depositWithAuthorization(address token, address from, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)',
  'function availableBalance(address token, address depositor) view returns (uint256)',
])
const log = (...a: unknown[]) => console.log(...a)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const b32 = (a: Address): Hex => pad(a, { size: 32 }).toLowerCase() as Hex
const usdc = (v: bigint) => `${Number(v) / 1e6} USDC`
const asc = (ks: K[]) => [...ks].sort((x, y) => (BigInt(x.address) < BigInt(y.address) ? -1 : 1))

async function send(req: Record<string, unknown>, onBase = false) {
  // biome-ignore lint/suspicious/noExplicitAny: viem write request union
  const hash = (await (onBase ? baseWallet : arcWallet).writeContract(req as any)) as Hex
  const r = await (onBase ? base : arc).waitForTransactionReceipt({ hash })
  if (r.status !== 'success') throw new Error(`tx ${hash} reverted`)
  return hash
}

/** Circle weighted-multisig ERC-1271 signature: owners ascending, raw ECDSA over the plugin's replay-safe hash. */
async function circleQuorumSig(account: Address, hash: Hex, signers: K[]): Promise<Hex> {
  const wrapped = (await arc.readContract({ address: WEIGHTED, abi: WEIGHTED_ABI, functionName: 'getReplaySafeMessageHash', args: [account, hash] })) as Hex
  return concat(await Promise.all(asc(signers).map((k) => sign({ hash: wrapped, privateKey: k.privateKey, to: 'hex' }))))
}

const burnTypes = {
  TransferSpec: [
    { name: 'version', type: 'uint32' }, { name: 'sourceDomain', type: 'uint32' }, { name: 'destinationDomain', type: 'uint32' },
    { name: 'sourceContract', type: 'bytes32' }, { name: 'destinationContract', type: 'bytes32' }, { name: 'sourceToken', type: 'bytes32' },
    { name: 'destinationToken', type: 'bytes32' }, { name: 'sourceDepositor', type: 'bytes32' }, { name: 'destinationRecipient', type: 'bytes32' },
    { name: 'sourceSigner', type: 'bytes32' }, { name: 'destinationCaller', type: 'bytes32' }, { name: 'value', type: 'uint256' },
    { name: 'salt', type: 'bytes32' }, { name: 'hookData', type: 'bytes' },
  ],
  BurnIntent: [{ name: 'maxBlockHeight', type: 'uint256' }, { name: 'maxFee', type: 'uint256' }, { name: 'spec', type: 'TransferSpec' }],
} as const
const BURN_TUPLE = [{ type: 'tuple', components: [
  { name: 'maxBlockHeight', type: 'uint256' }, { name: 'maxFee', type: 'uint256' },
  { name: 'spec', type: 'tuple', components: burnTypes.TransferSpec.map((f) => ({ ...f })) },
] }] as const

async function buildIntent(depositor: Address, recipient: Address, value: bigint) {
  const head = await arc.getBlockNumber()
  const message = {
    maxBlockHeight: head + EXPIRY_BLOCKS,
    maxFee: MAX_FEE,
    spec: {
      version: 1, sourceDomain: 26, destinationDomain: 6,
      sourceContract: b32(GATEWAY_WALLET), destinationContract: b32(GATEWAY_MINTER),
      sourceToken: b32(ARC_USDC), destinationToken: b32(BASE_USDC),
      sourceDepositor: b32(depositor), destinationRecipient: b32(recipient), sourceSigner: b32(depositor),
      destinationCaller: pad('0x00', { size: 32 }), value,
      salt: `0x${randomBytes(32).toString('hex')}` as Hex, hookData: '0x' as Hex,
    },
  }
  const hash = hashTypedData({ domain: { name: 'GatewayWallet', version: '1' }, types: burnTypes, primaryType: 'BurnIntent', message })
  return { message, hash }
}
type Intent = Awaited<ReturnType<typeof buildIntent>>['message']

async function postTransfer(message: Intent, signature: Hex) {
  const body = JSON.stringify([{ burnIntent: message, signature, contractSigner: true }], (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
  const res = await fetch(`${GATEWAY_API}/v1/transfer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
  return { ok: res.ok, status: res.status, text: await res.text() }
}

async function localCheck(account: Address, hash: Hex, sig: Hex) {
  try {
    return (await arc.readContract({ address: account, abi: IS_VALID, functionName: 'isValidSignature', args: [hash, sig] })) as string
  } catch (e) {
    return `reverted (${String((e as Error).message).split('\n')[0].slice(0, 90)})`
  }
}

async function waitBalance(depositor: Address, min: number) {
  for (let i = 0; i < 30; i++) {
    const r = await fetch(`${GATEWAY_API}/v1/balances`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'USDC', sources: [{ domain: 26, depositor }] }) })
    const bal = ((await r.json()) as { balances?: { balance: string }[] }).balances?.[0]?.balance
    if (bal && Number(bal) >= min) return bal
    await sleep(3000)
  }
  throw new Error('Gateway never showed the deposit')
}

async function mintAndCheck(text: string, recipient: Address) {
  const { attestation, signature } = JSON.parse(text) as { attestation: Hex; signature: Hex }
  const before = (await base.readContract({ address: BASE_USDC, abi: ERC20, functionName: 'balanceOf', args: [recipient] })) as bigint
  const mint = await send({ address: GATEWAY_MINTER, abi: parseAbi(['function gatewayMint(bytes,bytes)']), functionName: 'gatewayMint', args: [attestation, signature] }, true)
  let after = before
  for (let i = 0; i < 15 && after === before; i++) {
    await sleep(2000)
    after = (await base.readContract({ address: BASE_USDC, abi: ERC20, functionName: 'balanceOf', args: [recipient] })) as bigint
  }
  log(`   gatewayMint on Base Sepolia ${mint} · R ${usdc(before)} → ${usdc(after)}`)
  if (after - before !== 1_000_000n) throw new Error('R did not receive exactly 1 USDC')
  return mint
}

// ── NESTED: treasury v3 owned by EOA A (2) + Circle MSCA M1 (1) ─────────────────────────────────────────
async function nested() {
  const T = live.treasuryV3
  const M1 = live.nestedOwnerMsca
  log(`\nNESTED · treasury v3 ${T} · owner MSCA ${M1}`)
  const t1 = await send({ address: ARC_USDC, abi: ERC20, functionName: 'transfer', args: [T, 3_000_000n] })
  const s1 = await send({ address: T, abi: parseAbi(['function sweepToGateway(address)']), functionName: 'sweepToGateway', args: [ARC_USDC] })
  log('1. deposit (transfer + sweepToGateway 3 USDC):', t1, s1)
  log('   Gateway balance:', await waitBalance(T, 3))

  // Treasury blob: Safe-style slots ascending by owner; a contract owner slot is r = owner, s = offset, v = 0,
  // its signature appended as uint256(len) ‖ bytes.
  const blob = async (hash: Hex, m1Signers: K[]) => {
    const a = keys.A!
    const eoa = await sign({ hash, privateKey: a.privateKey, to: 'hex' })
    const m1sig = await circleQuorumSig(M1, hash, m1Signers)
    const parts = [
      { owner: a.address, contract: false, sig: eoa },
      { owner: M1, contract: true, sig: m1sig },
    ].sort((x, y) => (BigInt(x.owner) < BigInt(y.owner) ? -1 : 1))
    let offset = BigInt(parts.length * 65)
    const statics: Hex[] = []
    const dyn: Hex[] = []
    for (const p of parts) {
      if (p.contract) {
        statics.push(concat([b32(p.owner), pad(toHex(offset), { size: 32 }), '0x00']))
        const d = concat([pad(toHex(BigInt((p.sig.length - 2) / 2)), { size: 32 }), p.sig])
        dyn.push(d)
        offset += BigInt((d.length - 2) / 2)
      } else statics.push(p.sig)
    }
    return concat([...statics, ...dyn])
  }
  const wrap = (message: Intent, ownerBlob: Hex) =>
    encodeAbiParameters([{ type: 'uint8' }, { type: 'bytes' }, { type: 'bytes' }], [0, encodeAbiParameters(BURN_TUPLE, [message]), ownerBlob])

  {
    const { message, hash } = await buildIntent(T, keys.R!.address, 1_000_000n)
    const sig = wrap(message, await blob(hash, [nkeys.N1!])) // M1 with 1 of its 2 required owners
    const r = await postTransfer(message, sig)
    log(`2a. A + M1 (M1 signed 1-of-3, below its own threshold): local ${await localCheck(T, hash, sig)} · Gateway ${r.status} ${r.text.slice(0, 120)}`)
    if (r.ok) throw new Error('Gateway accepted an under-signed nested owner')
  }
  const { message, hash } = await buildIntent(T, keys.R!.address, 1_000_000n)
  const sig = wrap(message, await blob(hash, [nkeys.N1!, nkeys.N2!]))
  log(`2b. A + M1 (2-of-3): local ${await localCheck(T, hash, sig)}`)
  const r = await postTransfer(message, sig)
  log(`    POST /v1/transfer contractSigner:true → ${r.status}${r.ok ? '' : ` ${r.text}`}`)
  if (!r.ok) throw new Error('Gateway refused the nested-owner transfer')
  return mintAndCheck(r.text, keys.R!.address)
}

// ── GUARD: Circle MSCA M2 with GatewayIntentGuardPlugin ──────────────────────────────────────────────────
async function guard() {
  const M2 = live.guardedMsca
  log(`\nGUARD · Circle MSCA ${M2} · guard ${live.guardPlugin}`)
  const quorum = [keys.A!, keys.B!] // weights 2 + 1 = 3
  const envelope = (kind: number, payload: Hex) => {
    const env = encodeAbiParameters([{ type: 'uint8' }, { type: 'bytes' }], [kind, payload])
    return concat([env, pad(toHex(BigInt((env.length - 2) / 2)), { size: 32 }), ENVELOPE_MAGIC])
  }

  // 1. deposit by quorum-signed ERC-3009: USDC asks M2.isValidSignature → guard (kind 1, to must be GatewayWallet).
  await send({ address: ARC_USDC, abi: ERC20, functionName: 'transfer', args: [M2, 3_000_000n] })
  const auth = { from: M2, to: GATEWAY_WALLET, value: 3_000_000n, validAfter: 0n, validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600), nonce: `0x${randomBytes(32).toString('hex')}` as Hex }
  const authHash = hashTypedData({
    domain: { name: 'USDC', version: '2', chainId: arcTestnet.id, verifyingContract: ARC_USDC },
    types: { ReceiveWithAuthorization: [
      { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' } ] },
    primaryType: 'ReceiveWithAuthorization', message: auth,
  })
  const authPayload = encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }],
    [auth.from, auth.to, auth.value, auth.validAfter, auth.validBefore, auth.nonce],
  )
  const authSig = concat([await circleQuorumSig(M2, authHash, quorum), envelope(1, authPayload)])
  const d = await send({ address: GATEWAY_WALLET, abi: GW_ABI, functionName: 'depositWithAuthorization', args: [ARC_USDC, auth.from, auth.value, auth.validAfter, auth.validBefore, auth.nonce, authSig] })
  log('1. deposit (guard-checked depositWithAuthorization 3 USDC):', d)
  log('   Gateway balance:', await waitBalance(M2, 3))

  const sigFor = async (message: Intent, hash: Hex, signers: K[]) =>
    concat([await circleQuorumSig(M2, hash, signers), envelope(0, encodeAbiParameters(BURN_TUPLE, [message]))])

  {
    const { message, hash } = await buildIntent(M2, keys.S!.address, 1_000_000n)
    const sig = await sigFor(message, hash, quorum)
    const r = await postTransfer(message, sig)
    log(`2a. full quorum → S (not allowlisted): local ${await localCheck(M2, hash, sig)} · Gateway ${r.status} ${r.text.slice(0, 120)}`)
    if (r.ok) throw new Error('Gateway accepted a transfer the guard forbids')
  }
  {
    const { message, hash } = await buildIntent(M2, keys.R!.address, 1_000_000n)
    const sig = concat([await circleQuorumSig(M2, hash, quorum)]) // quorum signature WITHOUT the intent envelope
    const r = await postTransfer(message, sig)
    log(`2b. full quorum → R but no intent envelope: local ${await localCheck(M2, hash, sig)} · Gateway ${r.status} ${r.text.slice(0, 120)}`)
    if (r.ok) throw new Error('Gateway accepted a blind quorum signature on a guarded account')
  }
  const { message, hash } = await buildIntent(M2, keys.R!.address, 1_000_000n)
  const sig = await sigFor(message, hash, quorum)
  log(`2c. A+B → R with the intent envelope: local ${await localCheck(M2, hash, sig)}`)
  const r = await postTransfer(message, sig)
  log(`    POST /v1/transfer contractSigner:true → ${r.status}${r.ok ? '' : ` ${r.text}`}`)
  if (!r.ok) throw new Error('Gateway refused the guarded transfer')
  return mintAndCheck(r.text, keys.R!.address)
}

async function main() {
  log('payer', deployer.address)
  if (only !== 'guard') await nested()
  if (only !== 'nested') await guard()
  log('\nLIVE NESTED + GUARD CANARY PASSED')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
