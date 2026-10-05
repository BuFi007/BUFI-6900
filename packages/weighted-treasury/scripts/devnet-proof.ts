// SPDX-License-Identifier: Apache-2.0
/**
 * Devnet proof: one weighted-treasury spec, compiled to the Squads Smart Account Program, behaves
 * like the Circle MSCA weighted multisig + AddressBook.
 *
 *   owners  A=2, B=1, C=1, threshold 3 → minimal coalitions {A,B} and {A,C}; {B,C} is not winning
 *   allow   one recipient wallet R; a stranger wallet S is not on the list
 *
 * Proves, against the live devnet program:
 *   1. admin (creating the policies) needs ALL owners and waits out the timelock
 *   2. {A,B} and {A,C} each spend to R with one co-signed transaction
 *   3. {A,B} cannot spend to S                      (allowlist binds the quorum)
 *   4. {B,C} cannot spend at all                    (losing coalition has no policy)
 *   5. A alone cannot spend                         (policy threshold = coalition size)
 *
 * Owners are fresh ed25519 keypairs standing in for Circle user-controlled Solana wallets: on-chain
 * they are indistinguishable. The fee payer is the local Solana CLI key (`~/.config/solana/id.json`).
 *
 *   bun run squads:sdk && bun run devnet:proof
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { compileSquads, squadsSteps, type WeightedTreasurySpec } from '../src'

const sdkDir = join(import.meta.dir, '..', '.squads-sdk', 'sdk', 'smart-account')
const req = createRequire(join(sdkDir, 'package.json'))
// One copy of web3.js / spl-token / bn.js, the SDK's own, so PublicKey instances line up.
const web3 = req('@solana/web3.js') as typeof import('@solana/web3.js')
const spl = req('@solana/spl-token') as typeof import('@solana/spl-token')
const BN = req('bn.js')
const sa = req(join(sdkDir, 'lib', 'index.js'))

const { Connection, Keypair, LAMPORTS_PER_SOL } = web3
const RPC = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com'
const connection = new Connection(RPC, 'confirmed')
const ADMIN_TIMELOCK = 8

// Localnet (the playground's `solana-test-validator` with SMRT… cloned from mainnet): a fresh payer, airdropped.
// Devnet: the Solana CLI key, which must hold ~0.2 SOL.
const LOCAL = /127\.0\.0\.1|localhost/.test(RPC)
const payer = LOCAL
  ? Keypair.generate()
  : Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(homedir(), '.config/solana/id.json'), 'utf8'))))
const [A, B, C, R, S] = Array.from({ length: 5 }, () => Keypair.generate())

const log = (step: string, detail = '') => console.log(`${step}${detail ? `  ${detail}` : ''}`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const confirm = async (sig: string) => {
  const bh = await connection.getLatestBlockhash()
  await connection.confirmTransaction({ signature: sig, ...bh }, 'confirmed')
  return sig
}

async function expectFailure(label: string, run: () => Promise<unknown>, pattern: RegExp) {
  try {
    const sig = await run()
    if (typeof sig === 'string') await confirm(sig)
  } catch (err) {
    const text = String((err as { logs?: string[] }).logs?.join('\n') ?? '') + String(err)
    if (!pattern.test(text)) throw new Error(`${label}: failed for an unexpected reason:\n${text}`)
    log(`  ✓ rejected: ${label}`, `(${text.match(pattern)?.[0]})`)
    return
  }
  throw new Error(`${label}: SUCCEEDED but must be rejected`)
}

async function main() {
  if (LOCAL) await confirm(await connection.requestAirdrop(payer.publicKey, 10 * LAMPORTS_PER_SOL))
  log('payer', `${payer.publicKey.toBase58()} · ${(await connection.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL} SOL`)
  // Owners hold ZERO SOL: the payer covers every fee and rent, as a sponsor would for Circle user wallets.

  const steps = squadsSteps({ web3, spl, BN, sa }, connection)
  const decimals = 6

  const spec: WeightedTreasurySpec = {
    version: 1,
    owners: [
      { id: 'A', weight: 2, solana: A!.publicKey.toBase58() },
      { id: 'B', weight: 1, solana: B!.publicKey.toBase58() },
      { id: 'C', weight: 1, solana: C!.publicKey.toBase58() },
    ],
    thresholdWeight: 3,
    allowlist: [{ label: 'R', solana: R!.publicKey.toBase58() }],
    // The mint is created after compiling the admin plan's shape; any valid key works as a placeholder
    // because the real mint is substituted below before anything reaches the chain.
    assets: [{ symbol: 'TUSD', solanaMint: payer.publicKey.toBase58(), solanaDecimals: decimals }],
    adminTimelockSeconds: ADMIN_TIMELOCK,
  }

  const { settingsPda, vault } = await steps.createTreasury(payer, compileSquads(spec))
  log('smart account', `settings ${settingsPda.toBase58()} · vault ${vault.toBase58()}`)

  const { mint, vaultAta } = await steps.fundVault(payer, vault, decimals, 1_000_000_000n)
  log('test mint', `${mint.toBase58()} · vault holds 1000 TUSD`)
  const plan = compileSquads({ ...spec, assets: [{ ...spec.assets[0]!, solanaMint: mint.toBase58() }] })
  log('plan', `${plan.policies.length} policies: ${plan.policies.map((p) => `{${p.coalition.join(',')}}`).join(' ')}`)
  for (const note of plan.notes) log('  note', note)

  // ── 1. admin: PolicyCreate for every (coalition × asset), needs ALL owners + timelock ──────
  const txIndex = await steps.nextAdminIndex(settingsPda)
  const policyPdas = steps.policyPdas(settingsPda, plan)
  await steps.proposePolicies(payer, A!, settingsPda, plan, txIndex)
  await steps.approve(payer, settingsPda, txIndex, A!)
  await steps.approve(payer, settingsPda, txIndex, B!)
  log('1. admin change with A+B approved (weight 3, enough on EVM)')
  await expectFailure('admin executes with 2 of 3 owners', () => steps.executeAdmin(payer, settingsPda, txIndex, A!, policyPdas), /InvalidProposalStatus/)
  await steps.approve(payer, settingsPda, txIndex, C!)
  await expectFailure('admin executes before the timelock', () => steps.executeAdmin(payer, settingsPda, txIndex, A!, policyPdas), /TimeLockNotReleased/)
  await sleep((ADMIN_TIMELOCK + 3) * 1000)
  await steps.executeAdmin(payer, settingsPda, txIndex, A!, policyPdas)
  log('  ✓ policies created after all 3 owners + timelock', policyPdas.map((p: { toBase58(): string }) => p.toBase58()).join(' '))

  const rAta = await steps.ata(payer, mint, R!.publicKey)
  const sAta = await steps.ata(payer, mint, S!.publicKey)
  const idx = (ids: string) => plan.policies.findIndex((p) => p.coalition.join(',') === ids)
  const spend = (policyIdx: number, signers: InstanceType<typeof Keypair>[], to: InstanceType<typeof Keypair>, toAta: unknown, amount: bigint) =>
    steps.spend({ payer, policy: policyPdas[policyIdx], signers, vault, vaultAta, mint, destination: to.publicKey, destinationAta: toAta, amount, decimals })

  // ── 2. winning coalitions spend to the allowlisted wallet ─────────────────────────────────
  await spend(idx('A,B'), [A!, B!], R!, rAta, 100_000_000n)
  log('2. ✓ {A,B} sent 100 TUSD to R')
  await spend(idx('A,C'), [A!, C!], R!, rAta, 50_000_000n)
  log('   ✓ {A,C} sent 50 TUSD to R')

  // ── 3–5. everything the weighted rule + allowlist forbids ──────────────────────────────────
  await expectFailure('3. {A,B} to non-allowlisted S', () => spend(idx('A,B'), [A!, B!], S!, sAta, 1_000_000n), /InvalidDestination/)
  await expectFailure('4. {B,C} on the {A,B} policy (weight 2 < 3)', () => spend(idx('A,B'), [B!, C!], R!, rAta, 1_000_000n), /NotASigner/)
  await expectFailure('5. A alone (weight 2 < 3)', () => spend(idx('A,B'), [A!], R!, rAta, 1_000_000n), /InvalidSignerCount/)

  const rBal = await steps.balance(rAta)
  const sBal = await steps.balance(sAta)
  log('balances', `R=${Number(rBal) / 1e6} TUSD · S=${Number(sBal) / 1e6} TUSD`)
  if (rBal !== 150_000_000n || sBal !== 0n) throw new Error('unexpected final balances')
  for (const k of [A, B, C]) if ((await connection.getBalance(k!.publicKey)) !== 0) throw new Error('an owner was charged SOL')
  log('   owners A, B, C still hold 0 SOL')
  log('\nPROOF PASSED', `settings ${settingsPda.toBase58()} (${LOCAL ? 'localnet' : 'devnet'})`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
