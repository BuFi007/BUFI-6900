// SPDX-License-Identifier: Apache-2.0
/**
 * Solana leg of the Ultimate Treasury: a Squads smart account holds a Circle Gateway balance, and its Gateway
 * delegate is a FROST threshold key split among the same weighted owners.
 *
 *   owners A=2, B=1, C=1, threshold 3  →  FROST shares A:[1,2] B:[3] C:[4], threshold 3 shares
 *
 *   1. create the Squads smart account (settings = all owners, threshold 3)
 *   2. deposit_for: any wallet funds the vault's Gateway balance (no vault transaction needed)
 *   3. add_delegate(groupKey): the vault itself signs, through a Squads transaction all owners co-sign
 *   4. owners A+B produce ONE Ed25519 signature with their shares over a Solana → Arc burn intent
 *   5. POST /v1/transfer → attestation → gatewayMint on Arc testnet → R receives USDC
 *   6. refusals: B+C cannot produce a signature (2 shares < 3); a non-delegate key is refused by Gateway
 *
 *   bun run squads:sdk && DEPLOYER_PK=… bun scripts/gateway-solana-delegate.ts
 *
 * Solana fee payer: ~/.config/solana/id.json (must hold devnet SOL and ≥ 3 devnet USDC).
 * Owner keys, FROST shares: ../../.sandbox/ultimate-treasury/ (gitignored).
 */
import { execFileSync } from 'node:child_process'
import { createPrivateKey, randomBytes, sign as cryptoSign } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { type Hex, createPublicClient, createWalletClient, defineChain, http, parseAbi } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { compileSquads, squadsSteps, type WeightedTreasurySpec } from '../src'

const sdkDir = join(import.meta.dir, '..', '.squads-sdk', 'sdk', 'smart-account')
const req = createRequire(join(sdkDir, 'package.json'))
const web3 = req('@solana/web3.js') as typeof import('@solana/web3.js')
const spl = req('@solana/spl-token') as typeof import('@solana/spl-token')
const BN = req('bn.js')
const sa = req(join(sdkDir, 'lib', 'index.js'))
const { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } = web3

// ── constants (devnet / testnet) ───────────────────────────────────────────────────────────────
const RPC = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com'
const GATEWAY_API = 'https://gateway-api-testnet.circle.com'
const GW_WALLET = new PublicKey('GATEwdfmYNELfp5wDmmR6noSr2vHnAfBPMm2PvCzX5vu')
const SOL_USDC = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU')
const SOLANA_DOMAIN = 5
const ARC_DOMAIN = 26
const ARC_GATEWAY_MINTER = '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B' as const
const ARC_USDC = '0x3600000000000000000000000000000000000000' as const
const TRANSFER_SPEC_MAGIC = 0xca85def7
const BURN_INTENT_MAGIC = 0x070afbc2
const MAX_FEE = 2_010_000n
const DEPOSIT = 3_000_000n
const VALUE = 1_000_000n

const SANDBOX = join(import.meta.dir, '..', '..', '..', '.sandbox', 'ultimate-treasury')
const FROST_BIN = join(import.meta.dir, '..', '..', '..', 'tools', 'frost-delegate', 'target', 'release', 'frost-delegate')
const FROST_DIR = join(SANDBOX, 'frost')

const connection = new Connection(RPC, 'confirmed')
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(homedir(), '.config/solana/id.json'), 'utf8'))))
const evmKeys = JSON.parse(readFileSync(join(SANDBOX, 'keys.json'), 'utf8')) as Record<string, { address: `0x${string}`; privateKey: Hex }>

const log = (...a: unknown[]) => console.log(...a)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Solana owner keys (stand-ins for Circle user-controlled Solana wallets), persisted so reruns reuse them.
function solanaOwners() {
  const file = join(SANDBOX, 'solana-owners.json')
  if (!existsSync(file)) {
    const fresh = Object.fromEntries(['A', 'B', 'C'].map((id) => [id, Array.from(Keypair.generate().secretKey)]))
    writeFileSync(file, JSON.stringify(fresh), { mode: 0o600 })
  }
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, number[]>
  return Object.fromEntries(Object.entries(raw).map(([id, sk]) => [id, Keypair.fromSecretKey(Uint8Array.from(sk))]))
}

// ── Gateway Wallet instructions, built from the on-chain IDL (2-byte discriminators) ─────────
const pda = (...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, GW_WALLET)[0]
const GW_STATE = pda(Buffer.from('gateway_wallet'))
const CUSTODY = pda(Buffer.from('gateway_wallet_custody'), SOL_USDC.toBuffer())
const EVENT_AUTHORITY = pda(Buffer.from('__event_authority'))
const denylist = (k: InstanceType<typeof PublicKey>) => pda(Buffer.from('denylist'), k.toBuffer())

function depositForIx(owner: InstanceType<typeof PublicKey>, ownerAta: InstanceType<typeof PublicKey>, depositor: InstanceType<typeof PublicKey>, amount: bigint) {
  const data = Buffer.alloc(2 + 8 + 32)
  data.set([22, 1], 0)
  data.writeBigUInt64LE(amount, 2)
  depositor.toBuffer().copy(data, 10)
  return new TransactionInstruction({
    programId: GW_WALLET,
    data,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true }, // payer
      { pubkey: owner, isSigner: true, isWritable: false }, // owner
      { pubkey: GW_STATE, isSigner: false, isWritable: false },
      { pubkey: ownerAta, isSigner: false, isWritable: true },
      { pubkey: CUSTODY, isSigner: false, isWritable: true },
      { pubkey: pda(Buffer.from('gateway_deposit'), SOL_USDC.toBuffer(), depositor.toBuffer()), isSigner: false, isWritable: true },
      { pubkey: denylist(owner), isSigner: false, isWritable: false }, // sender_denylist
      { pubkey: denylist(depositor), isSigner: false, isWritable: false }, // depositor_denylist
      { pubkey: spl.TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: GW_WALLET, isSigner: false, isWritable: false },
    ],
  })
}

function addDelegateIx(vault: InstanceType<typeof PublicKey>, delegate: InstanceType<typeof PublicKey>) {
  const data = Buffer.alloc(2 + 32)
  data.set([22, 15], 0)
  delegate.toBuffer().copy(data, 2)
  return new TransactionInstruction({
    programId: GW_WALLET,
    data,
    keys: [
      { pubkey: vault, isSigner: true, isWritable: true }, // payer (the vault pays the delegate account's rent)
      { pubkey: vault, isSigner: true, isWritable: false }, // depositor
      { pubkey: GW_STATE, isSigner: false, isWritable: false },
      { pubkey: SOL_USDC, isSigner: false, isWritable: false },
      { pubkey: pda(Buffer.from('gateway_delegate'), SOL_USDC.toBuffer(), vault.toBuffer(), delegate.toBuffer()), isSigner: false, isWritable: true },
      { pubkey: denylist(vault), isSigner: false, isWritable: false },
      { pubkey: denylist(delegate), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: GW_WALLET, isSigner: false, isWritable: false },
    ],
  })
}

// ── burn intent: Circle's Solana binary layout (big-endian), signed with a 0xff… domain prefix ───
const evmToHex32 = (a: string) => `0x${a.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`
const keyToHex32 = (k: InstanceType<typeof PublicKey>) => `0x${k.toBuffer().toString('hex')}`
const u256be = (v: bigint) => {
  const b = Buffer.alloc(32)
  b.writeBigUInt64BE(v & 0xffffffffffffffffn, 24)
  b.writeBigUInt64BE((v >> 64n) & 0xffffffffffffffffn, 16)
  return b
}
const u32be = (v: number) => {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(v)
  return b
}
const h = (hex: string) => Buffer.from(hex.replace(/^0x/, ''), 'hex')

type Intent = ReturnType<typeof makeIntent>
function makeIntent(p: { depositor: InstanceType<typeof PublicKey>; signer: InstanceType<typeof PublicKey>; recipient: string; maxBlockHeight: bigint }) {
  return {
    maxBlockHeight: p.maxBlockHeight,
    maxFee: MAX_FEE,
    spec: {
      version: 1,
      sourceDomain: SOLANA_DOMAIN,
      destinationDomain: ARC_DOMAIN,
      sourceContract: keyToHex32(GW_WALLET),
      destinationContract: evmToHex32(ARC_GATEWAY_MINTER),
      sourceToken: keyToHex32(SOL_USDC),
      destinationToken: evmToHex32(ARC_USDC),
      sourceDepositor: keyToHex32(p.depositor),
      destinationRecipient: evmToHex32(p.recipient),
      sourceSigner: keyToHex32(p.signer),
      destinationCaller: `0x${'00'.repeat(32)}`,
      value: VALUE,
      salt: `0x${randomBytes(32).toString('hex')}`,
      hookData: '0x',
    },
  }
}

function encodeIntent(bi: Intent): Buffer {
  const hook = h(bi.spec.hookData)
  const s = bi.spec
  const spec = Buffer.concat([
    u32be(TRANSFER_SPEC_MAGIC), u32be(s.version), u32be(s.sourceDomain), u32be(s.destinationDomain),
    h(s.sourceContract), h(s.destinationContract), h(s.sourceToken), h(s.destinationToken),
    h(s.sourceDepositor), h(s.destinationRecipient), h(s.sourceSigner), h(s.destinationCaller),
    u256be(s.value), h(s.salt), u32be(hook.length), hook,
  ])
  if (spec.length !== 340 + hook.length) throw new Error(`transfer spec is ${spec.length} bytes, expected ${340 + hook.length}`)
  return Buffer.concat([u32be(BURN_INTENT_MAGIC), u256be(bi.maxBlockHeight), u256be(bi.maxFee), u32be(spec.length), spec])
}

const SIGNING_DOMAIN = Buffer.from([0xff, ...new Array(15).fill(0)])

/**
 * FROST-sign the prefixed intent with the given owners' shares. Returns null if they are below threshold. frost-delegate
 * is also the policy coordinator: it decodes the intent and checks `<frost dir>/policy.json` against `currentSlot`
 * before any share signs; a policy refusal throws here (this script only builds intents the policy allows).
 */
function frostSign(signers: string[], message: Buffer, currentSlot: bigint): { signature: string; groupKey: string } | null {
  try {
    const out = execFileSync(
      FROST_BIN,
      ['sign', '--dir', FROST_DIR, '--signers', signers.join(','), '--current-slot', currentSlot.toString(), '--message-hex', message.toString('hex')],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    return JSON.parse(out.toString())
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? ''
    if (stderr.includes('below threshold')) return null
    if (stderr.includes('"policy"')) throw new Error(`FROST coordinator policy refused the intent: ${stderr.trim()}`)
    throw err
  }
}

async function postTransfer(bi: Intent, signature: string) {
  const body = JSON.stringify([{ burnIntent: bi, signature }], (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
  const res = await fetch(`${GATEWAY_API}/v1/transfer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
  return { ok: res.ok, status: res.status, text: await res.text() }
}

async function main() {
  if (!existsSync(join(FROST_DIR, 'group.json'))) throw new Error('run `frost-delegate dkg` first (see tools/frost-delegate)')
  const group = JSON.parse(readFileSync(join(FROST_DIR, 'group.json'), 'utf8')) as { group_key_hex: string }
  const delegate = new PublicKey(h(group.group_key_hex))
  const owners = solanaOwners()
  log('payer', payer.publicKey.toBase58(), '· FROST delegate (group key)', delegate.toBase58())

  // 1. Squads smart account: settings = all owners, threshold 3, no timelock (so the admin step can run synchronously).
  const steps = squadsSteps({ web3, spl, BN, sa }, connection)
  const spec: WeightedTreasurySpec = {
    version: 1,
    owners: (['A', 'B', 'C'] as const).map((id, i) => ({ id, weight: [2, 1, 1][i]!, solana: owners[id]!.publicKey.toBase58() })),
    thresholdWeight: 3,
    // The Solana leg's Gateway allowlist is OFF-CHAIN: frost-delegate's policy.json (recipient per destination domain,
    // caps, expiry) is checked before any share signs. It does not bind a share majority signing without the binary.
    allowlist: [{ label: 'R', solana: payer.publicKey.toBase58() }],
    assets: [{ symbol: 'USDC', solanaMint: SOL_USDC.toBase58(), solanaDecimals: 6 }],
    adminTimelockSeconds: 0,
  }
  const stateFile = join(SANDBOX, 'solana-leg.json')
  const reuse = process.argv.includes('--reuse') && existsSync(stateFile)
  let settingsPda: InstanceType<typeof PublicKey>
  let vault: InstanceType<typeof PublicKey>
  if (reuse) {
    const st = JSON.parse(readFileSync(stateFile, 'utf8')) as { settings: string; vault: string }
    settingsPda = new PublicKey(st.settings)
    vault = new PublicKey(st.vault)
    log('1–3. reusing Squads account', st.settings, '· vault', st.vault)
  } else {
  ;({ settingsPda, vault } = await steps.createTreasury(payer, compileSquads(spec)))
  log('1. Squads smart account', settingsPda.toBase58(), '· vault', vault.toBase58())

  // 2. deposit_for the vault (the payer's USDC → the vault's Gateway balance) + a little SOL for the vault's rent.
  const payerAta = spl.getAssociatedTokenAddressSync(SOL_USDC, payer.publicKey)
  const fundTx = new Transaction()
    .add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: vault, lamports: 0.02 * LAMPORTS_PER_SOL }))
    .add(depositForIx(payer.publicKey, payerAta, vault, DEPOSIT))
  const depositSig = await sendAndConfirmTransaction(connection, fundTx, [payer])
  log('2. deposit_for vault 3 USDC:', depositSig)

  // 3. add_delegate: the vault signs via a synchronous Squads transaction co-signed by ALL owners.
  const members = ['A', 'B', 'C'].map((id) => owners[id]!)
  const { instructions, accounts } = sa.utils.instructionsToSynchronousTransactionDetails({
    vaultPda: vault,
    members: members.map((m) => m.publicKey),
    transaction_instructions: [addDelegateIx(vault, delegate)],
  })
  // The SDK's rpc layer does not export the sync helper; build the instruction the way Squads' own tests do.
  const syncIx = sa.instructions.executeTransactionSync({
    settingsPda, numSigners: members.length, accountIndex: 0, instructions, instruction_accounts: accounts, programId: steps.programId,
  })
  const msg = new web3.TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
    instructions: [syncIx],
  }).compileToV0Message()
  const vtx = new web3.VersionedTransaction(msg)
  vtx.sign([payer, ...members])
  const delegateSig = await steps.confirm(await connection.sendRawTransaction(vtx.serialize()))
  log('3. add_delegate(FROST group key) via Squads, all 3 owners:', delegateSig)
  writeFileSync(stateFile, JSON.stringify({ settings: settingsPda.toBase58(), vault: vault.toBase58() }))
  }

  // Wait for Gateway to see the deposit.
  for (let i = 0; i < 30; i++) {
    const r = await fetch(`${GATEWAY_API}/v1/balances`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'USDC', sources: [{ domain: SOLANA_DOMAIN, depositor: vault.toBase58() }] }),
    })
    const bal = ((await r.json()) as { balances?: { balance: string }[] }).balances?.[0]?.balance
    log('   Gateway balance (Solana, vault):', bal)
    if (bal && Number(bal) >= 3) break
    await sleep(5000)
  }

  const slot = BigInt(await connection.getSlot())
  // Gateway's measured minimum on Solana devnet (2026-10-05): 3,024,000 slots above head (14 days at 400 ms).
  // Bounded just above it: a signed intent is a bearer note until it expires.
  const maxBlockHeight = slot + 3_024_000n + 10_000n
  const R = evmKeys.R!.address

  // 6a. B+C hold 2 of 4 shares, below 3: no Ed25519 signature exists for them to produce.
  {
    const bi = makeIntent({ depositor: vault, signer: delegate, recipient: R, maxBlockHeight })
    const sig = frostSign(['B', 'C'], Buffer.concat([SIGNING_DOMAIN, encodeIntent(bi)]), slot)
    log('6a. B+C (2 shares < 3):', sig === null ? 'cannot sign (below threshold)' : 'SIGNED?!')
    if (sig !== null) throw new Error('B+C produced a signature')
  }
  // 6b. A single key that is not the registered delegate: Gateway must refuse.
  {
    const rogue = owners.A!
    const bi = makeIntent({ depositor: vault, signer: rogue.publicKey, recipient: R, maxBlockHeight })
    const key = createPrivateKey({
      key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(rogue.secretKey.slice(0, 32))]),
      format: 'der',
      type: 'pkcs8',
    })
    const sig = `0x${cryptoSign(null, Buffer.concat([SIGNING_DOMAIN, encodeIntent(bi)]), key).toString('hex')}`
    const r = await postTransfer(bi, sig)
    log(`6b. owner A's own key (not the delegate): Gateway ${r.status} ${r.text.slice(0, 160)}`)
    // An unexpected acceptance is a live bearer attestation: print it in full so it can still be minted to R.
    if (r.ok) throw new Error(`Gateway accepted a non-delegate signer; attestation (mint it to R): ${r.text}`)
    if (/maxBlockHeight/.test(r.text)) throw new Error('rogue-key probe failed on expiry, not on the signer: fix the expiry first')
  }

  // 4. A+B sign with their shares → one Ed25519 signature from the group key.
  const bi = makeIntent({ depositor: vault, signer: delegate, recipient: R, maxBlockHeight })
  const signed = frostSign(['A', 'B'], Buffer.concat([SIGNING_DOMAIN, encodeIntent(bi)]), slot)
  if (!signed) throw new Error('A+B could not sign')
  log('4. A+B FROST signature:', `${signed.signature.slice(0, 18)}…`)

  // 5. attestation, then mint on Arc testnet.
  // Gateway indexes the delegate registration with a lag (like deposits). The same signed intent can be resubmitted
  // safely while it is refused: only an accepted intent is consumed.
  let r = await postTransfer(bi, signed.signature)
  for (let i = 0; i < 36 && !r.ok && /not authorized/i.test(r.text); i++) {
    log(`   delegate not indexed by Gateway yet (${i * 5}s), retrying…`)
    await sleep(5000)
    r = await postTransfer(bi, signed.signature)
  }
  log(`5. POST /v1/transfer → ${r.status}`)
  if (!r.ok) throw new Error(`Gateway refused the threshold-signed transfer: ${r.text}`)
  const { attestation, signature: operatorSig } = JSON.parse(r.text) as { attestation: Hex; signature: Hex }
  // Logged BEFORE the mint: if gatewayMint fails, this attestation (already debited) is what must be resubmitted.
  log('   attestation:', attestation)
  log('   operator signature:', operatorSig)

  const arcTestnet = defineChain({ id: 5042002, name: 'Arc Testnet', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.testnet.arc.network'] } } })
  const arc = createPublicClient({ chain: arcTestnet, transport: http() })
  const wallet = createWalletClient({ account: privateKeyToAccount(process.env.DEPLOYER_PK as Hex), chain: arcTestnet, transport: http() })
  const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)'])
  const before = (await arc.readContract({ address: ARC_USDC, abi: erc20, functionName: 'balanceOf', args: [R] })) as bigint
  const mintHash = await wallet.writeContract({ address: ARC_GATEWAY_MINTER, abi: parseAbi(['function gatewayMint(bytes,bytes)']), functionName: 'gatewayMint', args: [attestation, operatorSig] })
  const receipt = await arc.waitForTransactionReceipt({ hash: mintHash })
  if (receipt.status !== 'success') throw new Error(`gatewayMint reverted: ${mintHash}`)
  let after = before
  for (let i = 0; i < 15 && after === before; i++) {
    await sleep(2000)
    after = (await arc.readContract({ address: ARC_USDC, abi: erc20, functionName: 'balanceOf', args: [R] })) as bigint
  }
  log(`   gatewayMint on Arc: ${mintHash} · R ${Number(before) / 1e6} → ${Number(after) / 1e6} USDC`)
  if (after - before !== VALUE) throw new Error('R did not receive exactly 1 USDC on Arc')
  log('\nSOLANA DELEGATE LEG PASSED')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
