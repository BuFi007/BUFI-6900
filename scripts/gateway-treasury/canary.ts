// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Live canary: GatewayTreasury as its own Circle Gateway ERC-1271 signer, Arc testnet → Base Sepolia.
 *
 *   1. deposit A: plain USDC transfer to the treasury, then permissionless sweepToGateway
 *   2. deposit B: owners sign an ERC-3009 ReceiveWithAuthorization; GatewayWallet.depositWithAuthorization pulls it
 *                 (the token asks the treasury's isValidSignature, kind 1)
 *   3. wait for the unified balance (GET via POST /v1/balances)
 *   4. owners A+B (weight 3 of 3) sign a burn intent to R on Base Sepolia; POST /v1/transfer contractSigner:true
 *   5. gatewayMint on Base Sepolia; R's USDC balance rises
 *   6. refusals Gateway must return: recipient S (not allowlisted), and B+C (weight 2 < 3)
 *
 * Keys: owners/recipients from `.sandbox/ultimate-treasury/keys.json` (gitignored), fee payer = DEPLOYER_PK env.
 *   DEPLOYER_PK=… TREASURY=0x… bun scripts/gateway-treasury/canary.ts [--skip-deposit]
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
  getAddress,
  hashTypedData,
  isAddress,
  http,
  pad,
  parseAbi,
} from 'viem'
import { baseSepolia } from 'viem/chains'
import { privateKeyToAccount, sign } from 'viem/accounts'

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
const ARC_DOMAIN = 26
const BASE_DOMAIN = 6
// Gateway's measured minimum expiry on Arc testnet (desk burn-intent.ts) + margin, under the treasury's 1,250,000.
const EXPIRY_BLOCKS = 1_209_599n + 2_000n
const MAX_FEE = 2_010_000n

// Fail fast on configuration before anything is sent: a wrong TREASURY would receive real funds in step 1.
if (!process.env.DEPLOYER_PK || !/^0x[0-9a-fA-F]{64}$/.test(process.env.DEPLOYER_PK)) throw new Error('DEPLOYER_PK must be a 0x-prefixed 32-byte hex key')
if (!isAddress(process.env.TREASURY ?? '', { strict: false })) throw new Error(`TREASURY is not an address: ${process.env.TREASURY}`)
const TREASURY = getAddress(process.env.TREASURY as string)
const deployer = privateKeyToAccount(process.env.DEPLOYER_PK as Hex)
const keys = JSON.parse(readFileSync(join(import.meta.dir, '../../.sandbox/ultimate-treasury/keys.json'), 'utf8')) as Record<
  string,
  { address: Address; privateKey: Hex }
>
const skipDeposit = process.argv.includes('--skip-deposit')

const arc = createPublicClient({ chain: arcTestnet, transport: http() })
const base = createPublicClient({ chain: baseSepolia, transport: http() })
const arcWallet = createWalletClient({ account: deployer, chain: arcTestnet, transport: http() })
const baseWallet = createWalletClient({ account: deployer, chain: baseSepolia, transport: http() })

const ERC20 = parseAbi([
  'function transfer(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
])
const TREASURY_ABI = parseAbi([
  'function sweepToGateway(address token)',
  'function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)',
  'function getOwners() view returns (address[])',
  'function gatewayWallet() view returns (address)',
])

/** TREASURY must be the deployed GatewayTreasury of these owners on this Gateway, or nothing is sent. */
async function assertTreasury() {
  const code = await arc.getCode({ address: TREASURY })
  if (!code || code === '0x') throw new Error(`TREASURY ${TREASURY} has no code on Arc testnet: refusing to send funds to it`)
  const [owners, gw] = await Promise.all([
    arc.readContract({ address: TREASURY, abi: TREASURY_ABI, functionName: 'getOwners' }) as Promise<Address[]>,
    arc.readContract({ address: TREASURY, abi: TREASURY_ABI, functionName: 'gatewayWallet' }) as Promise<Address>,
  ]).catch(() => {
    throw new Error(`TREASURY ${TREASURY} is not a GatewayTreasury (getOwners/gatewayWallet failed)`)
  })
  const want = ['A', 'B', 'C'].map((id) => keys[id]!.address.toLowerCase()).sort()
  const got = owners.map((o) => o.toLowerCase()).sort()
  if (JSON.stringify(want) !== JSON.stringify(got)) throw new Error(`TREASURY owners ${got.join(',')} are not the sandbox owners A,B,C`)
  if (gw.toLowerCase() !== GATEWAY_WALLET.toLowerCase()) throw new Error(`TREASURY uses GatewayWallet ${gw}, expected ${GATEWAY_WALLET}`)
}
const GW_ABI = parseAbi([
  'function depositWithAuthorization(address token, address from, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)',
  'function availableBalance(address token, address depositor) view returns (uint256)',
])
const MINTER_ABI = parseAbi(['function gatewayMint(bytes attestationPayload, bytes signature)'])

const b32 = (a: Address): Hex => pad(a, { size: 32 }).toLowerCase() as Hex
const log = (...a: unknown[]) => console.log(...a)
const usdc = (v: bigint) => `${Number(v) / 1e6} USDC`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Owner signatures over `hash`, ascending by address, packed r‖s‖v. */
async function ownerSigs(ids: string[], hash: Hex): Promise<Hex> {
  const owners = ids.map((id) => keys[id]!).sort((x, y) => (BigInt(x.address) < BigInt(y.address) ? -1 : 1))
  const sigs = await Promise.all(owners.map((o) => sign({ hash, privateKey: o.privateKey, to: 'hex' })))
  return concat(sigs)
}

async function send(client: typeof arcWallet | typeof baseWallet, pub: typeof arc | typeof base, req: Parameters<typeof arcWallet.writeContract>[0]) {
  // biome-ignore lint/suspicious/noExplicitAny: viem client union narrowing
  const hash = await (client as any).writeContract(req)
  const receipt = await pub.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`tx ${hash} reverted`)
  return hash as Hex
}

// ── EIP-712 types ────────────────────────────────────────────────────────────
const burnTypes = {
  TransferSpec: [
    { name: 'version', type: 'uint32' },
    { name: 'sourceDomain', type: 'uint32' },
    { name: 'destinationDomain', type: 'uint32' },
    { name: 'sourceContract', type: 'bytes32' },
    { name: 'destinationContract', type: 'bytes32' },
    { name: 'sourceToken', type: 'bytes32' },
    { name: 'destinationToken', type: 'bytes32' },
    { name: 'sourceDepositor', type: 'bytes32' },
    { name: 'destinationRecipient', type: 'bytes32' },
    { name: 'sourceSigner', type: 'bytes32' },
    { name: 'destinationCaller', type: 'bytes32' },
    { name: 'value', type: 'uint256' },
    { name: 'salt', type: 'bytes32' },
    { name: 'hookData', type: 'bytes' },
  ],
  BurnIntent: [
    { name: 'maxBlockHeight', type: 'uint256' },
    { name: 'maxFee', type: 'uint256' },
    { name: 'spec', type: 'TransferSpec' },
  ],
} as const

const BURN_INTENT_TUPLE = [
  {
    type: 'tuple',
    components: [
      { name: 'maxBlockHeight', type: 'uint256' },
      { name: 'maxFee', type: 'uint256' },
      { name: 'spec', type: 'tuple', components: burnTypes.TransferSpec.map((f) => ({ ...f })) },
    ],
  },
] as const

async function buildIntent(recipient: Address, value: bigint) {
  const head = await arc.getBlockNumber()
  const message = {
    maxBlockHeight: head + EXPIRY_BLOCKS,
    maxFee: MAX_FEE,
    spec: {
      version: 1,
      sourceDomain: ARC_DOMAIN,
      destinationDomain: BASE_DOMAIN,
      sourceContract: b32(GATEWAY_WALLET),
      destinationContract: b32(GATEWAY_MINTER),
      sourceToken: b32(ARC_USDC),
      destinationToken: b32(BASE_USDC),
      sourceDepositor: b32(TREASURY),
      destinationRecipient: b32(recipient),
      sourceSigner: b32(TREASURY),
      destinationCaller: pad('0x00', { size: 32 }),
      value,
      salt: `0x${randomBytes(32).toString('hex')}` as Hex,
      hookData: '0x' as Hex,
    },
  }
  const hash = hashTypedData({ domain: { name: 'GatewayWallet', version: '1' }, types: burnTypes, primaryType: 'BurnIntent', message })
  return { message, hash }
}

async function contractSignature(message: Awaited<ReturnType<typeof buildIntent>>['message'], hash: Hex, signers: string[]) {
  const payload = encodeAbiParameters(BURN_INTENT_TUPLE, [message])
  return encodeAbiParameters([{ type: 'uint8' }, { type: 'bytes' }, { type: 'bytes' }], [0, payload, await ownerSigs(signers, hash)])
}

async function postTransfer(message: Awaited<ReturnType<typeof buildIntent>>['message'], signature: Hex) {
  const body = JSON.stringify([{ burnIntent: message, signature, contractSigner: true }], (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
  const res = await fetch(`${GATEWAY_API}/v1/transfer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
  const text = await res.text()
  return { ok: res.ok, status: res.status, text }
}

async function main() {
  log('treasury', TREASURY, '· payer', deployer.address)
  await assertTreasury()

  if (!skipDeposit) {
    // 1. deposit A: transfer + sweep
    const t1 = await send(arcWallet, arc, { address: ARC_USDC, abi: ERC20, functionName: 'transfer', args: [TREASURY, 3_000_000n] } as never)
    const s1 = await send(arcWallet, arc, { address: TREASURY, abi: TREASURY_ABI, functionName: 'sweepToGateway', args: [ARC_USDC] } as never)
    log('1. deposit A (transfer + sweepToGateway 3 USDC):', t1, s1)

    // 2. deposit B: quorum-signed ERC-3009 → depositWithAuthorization
    await send(arcWallet, arc, { address: ARC_USDC, abi: ERC20, functionName: 'transfer', args: [TREASURY, 1_000_000n] } as never)
    const auth = {
      from: TREASURY,
      to: GATEWAY_WALLET,
      value: 1_000_000n,
      validAfter: 0n,
      validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600),
      nonce: `0x${randomBytes(32).toString('hex')}` as Hex,
    }
    const authHash = hashTypedData({
      domain: { name: 'USDC', version: '2', chainId: arcTestnet.id, verifyingContract: ARC_USDC },
      types: {
        ReceiveWithAuthorization: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
        ],
      },
      primaryType: 'ReceiveWithAuthorization',
      message: auth,
    })
    const authPayload = encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }],
      [auth.from, auth.to, auth.value, auth.validAfter, auth.validBefore, auth.nonce],
    )
    const authSig = encodeAbiParameters([{ type: 'uint8' }, { type: 'bytes' }, { type: 'bytes' }], [1, authPayload, await ownerSigs(['A', 'B'], authHash)])
    const d2 = await send(arcWallet, arc, {
      address: GATEWAY_WALLET,
      abi: GW_ABI,
      functionName: 'depositWithAuthorization',
      args: [ARC_USDC, auth.from, auth.value, auth.validAfter, auth.validBefore, auth.nonce, authSig],
    } as never)
    log('2. deposit B (quorum-signed depositWithAuthorization 1 USDC):', d2)
  }

  // 3. on-chain balance + Gateway API balance
  const onchain = await arc.readContract({ address: GATEWAY_WALLET, abi: GW_ABI, functionName: 'availableBalance', args: [ARC_USDC, TREASURY] })
  log('3. GatewayWallet.availableBalance:', usdc(onchain as bigint))
  for (let i = 0; i < 20; i++) {
    const r = await fetch(`${GATEWAY_API}/v1/balances`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'USDC', sources: [{ domain: ARC_DOMAIN, depositor: TREASURY }] }),
    })
    const j = (await r.json()) as { balances?: { balance: string }[] }
    const bal = j.balances?.[0]?.balance
    log('   Gateway API balance:', bal)
    if (bal && Number(bal) >= 3) break
    await sleep(3000)
  }

  // 6a/6b. refusals first (they consume nothing)
  {
    const { message, hash } = await buildIntent(keys.S!.address, 1_000_000n)
    const sig = await contractSignature(message, hash, ['A', 'B'])
    const local = await arc.readContract({ address: TREASURY, abi: TREASURY_ABI, functionName: 'isValidSignature', args: [hash, sig] })
    const r = await postTransfer(message, sig)
    log(`6a. recipient S (not allowlisted): local isValidSignature=${local} · Gateway ${r.status} ${r.text.slice(0, 200)}`)
    if (r.ok) throw new Error(`Gateway ACCEPTED a non-allowlisted recipient; live attestation: ${r.text}`)
  }
  {
    const { message, hash } = await buildIntent(keys.R!.address, 1_000_000n)
    const sig = await contractSignature(message, hash, ['B', 'C'])
    const local = await arc.readContract({ address: TREASURY, abi: TREASURY_ABI, functionName: 'isValidSignature', args: [hash, sig] })
    const r = await postTransfer(message, sig)
    log(`6b. B+C (weight 2 < 3): local isValidSignature=${local} · Gateway ${r.status} ${r.text.slice(0, 200)}`)
    if (r.ok) throw new Error(`Gateway ACCEPTED a sub-threshold quorum; live attestation (mint it to R): ${r.text}`)
  }

  // 4. the real transfer: A+B to R
  const { message, hash } = await buildIntent(keys.R!.address, 1_000_000n)
  const sig = await contractSignature(message, hash, ['A', 'B'])
  const local = await arc.readContract({ address: TREASURY, abi: TREASURY_ABI, functionName: 'isValidSignature', args: [hash, sig] })
  log('4. A+B → R 1 USDC: local isValidSignature =', local)
  const r = await postTransfer(message, sig)
  log(`   POST /v1/transfer contractSigner:true → ${r.status}`)
  if (!r.ok) throw new Error(`Gateway refused the valid transfer: ${r.text}`)
  const { attestation, signature: operatorSig } = JSON.parse(r.text) as { attestation: Hex; signature: Hex }
  // Logged BEFORE the mint: if gatewayMint fails, this attestation (already debited) is what must be resubmitted.
  log('   attestation:', attestation)
  log('   operator signature:', operatorSig)

  // 5. mint on Base Sepolia
  const before = (await base.readContract({ address: BASE_USDC, abi: ERC20, functionName: 'balanceOf', args: [keys.R!.address] })) as bigint
  const mint = await send(baseWallet, base, { address: GATEWAY_MINTER, abi: MINTER_ABI, functionName: 'gatewayMint', args: [attestation, operatorSig] } as never)
  // Public RPCs lag the receipt by a few seconds: poll until the balance reflects the mint.
  let after = before
  for (let i = 0; i < 15 && after === before; i++) {
    await sleep(2000)
    after = (await base.readContract({ address: BASE_USDC, abi: ERC20, functionName: 'balanceOf', args: [keys.R!.address] })) as bigint
  }
  log(`5. gatewayMint on Base Sepolia: ${mint} · R ${usdc(before)} → ${usdc(after)}`)
  if (after - before !== 1_000_000n) throw new Error('R did not receive exactly 1 USDC')
  log('\nCANARY PASSED')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
