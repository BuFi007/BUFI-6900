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
import { compileSquads, toSdkPolicyCreateActions, toSdkSigners, type WeightedTreasurySpec } from '../src'

const sdkDir = join(import.meta.dir, '..', '.squads-sdk', 'sdk', 'smart-account')
const req = createRequire(join(sdkDir, 'package.json'))
// One copy of web3.js / spl-token / bn.js, the SDK's own, so PublicKey instances line up.
const web3 = req('@solana/web3.js') as typeof import('@solana/web3.js')
const spl = req('@solana/spl-token') as typeof import('@solana/spl-token')
const BN = req('bn.js')
const sa = req(join(sdkDir, 'lib', 'index.js'))

const { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, SystemProgram, Transaction, sendAndConfirmTransaction } = web3
const RPC = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com'
const connection = new Connection(RPC, 'confirmed')
const programId = new PublicKey('SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG')
const ADMIN_TIMELOCK = 8

const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(homedir(), '.config/solana/id.json'), 'utf8'))))
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
  log('payer', `${payer.publicKey.toBase58()} · ${(await connection.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL} SOL`)

  // Owners need a little SOL only because Squads requires signers to be writable-free signers; they
  // pay nothing here (the payer funds everything). Fund A..C with dust for safety on sends.
  const fund = new Transaction()
  for (const k of [A, B, C]) fund.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: k!.publicKey, lamports: 0.03 * LAMPORTS_PER_SOL }))
  await sendAndConfirmTransaction(connection, fund, [payer])

  const decimals = 6
  const mint = await spl.createMint(connection, payer, payer.publicKey, null, decimals)
  log('test mint', mint.toBase58())

  const spec: WeightedTreasurySpec = {
    version: 1,
    owners: [
      { id: 'A', weight: 2, solana: A!.publicKey.toBase58() },
      { id: 'B', weight: 1, solana: B!.publicKey.toBase58() },
      { id: 'C', weight: 1, solana: C!.publicKey.toBase58() },
    ],
    thresholdWeight: 3,
    allowlist: [{ label: 'R', solana: R!.publicKey.toBase58() }],
    assets: [{ symbol: 'TUSD', solanaMint: mint.toBase58(), solanaDecimals: decimals }],
    adminTimelockSeconds: ADMIN_TIMELOCK,
  }
  const plan = compileSquads(spec)
  log('plan', `${plan.policies.length} policies: ${plan.policies.map((p) => `{${p.coalition.join(',')}}`).join(' ')}`)
  for (const note of plan.notes) log('  note', note)

  // ── create the smart account: all owners, threshold = all, admin timelock ─────────────────
  const [programConfigPda] = sa.getProgramConfigPda({ programId })
  let settingsPda: InstanceType<typeof PublicKey> | undefined
  for (let attempt = 0; attempt < 5 && !settingsPda; attempt++) {
    const cfg = await sa.accounts.ProgramConfig.fromAccountAddress(connection, programConfigPda)
    const accountIndex = BigInt(cfg.smartAccountIndex.toString()) + 1n
    const [candidate] = sa.getSettingsPda({ accountIndex, programId })
    try {
      await confirm(
        await sa.rpc.createSmartAccount({
          connection,
          treasury: cfg.treasury,
          creator: payer,
          settings: candidate,
          settingsAuthority: null,
          threshold: plan.settings.threshold,
          signers: toSdkSigners(plan.settings.signers, { PublicKey }),
          timeLock: plan.settings.timeLock,
          rentCollector: null,
          programId,
        }),
      )
      settingsPda = candidate
    } catch (err) {
      log('  index race, retrying', String(err).slice(0, 80))
    }
  }
  if (!settingsPda) throw new Error('could not create smart account')
  const [vault] = sa.getSmartAccountPda({ settingsPda, accountIndex: 0, programId })
  log('smart account', `settings ${settingsPda.toBase58()} · vault ${vault.toBase58()}`)

  // ── 1. admin: PolicyCreate for every (coalition × asset), needs ALL owners + timelock ──────
  const actions = toSdkPolicyCreateActions(plan, { PublicKey, BN })
  const policyPdas = actions.map((a) => sa.getPolicyPda({ settingsPda, policySeed: a.seed, programId })[0])
  const txIndex = 1n
  await confirm(await sa.rpc.createSettingsTransaction({ connection, feePayer: payer, settingsPda, transactionIndex: txIndex, creator: A!.publicKey, rentPayer: payer.publicKey, actions, programId, signers: [A!] }))
  await confirm(await sa.rpc.createProposal({ connection, feePayer: payer, settingsPda, transactionIndex: txIndex, creator: A, programId }))
  await confirm(await sa.rpc.approveProposal({ connection, feePayer: payer, settingsPda, transactionIndex: txIndex, signer: A, programId }))
  await confirm(await sa.rpc.approveProposal({ connection, feePayer: payer, settingsPda, transactionIndex: txIndex, signer: B, programId }))
  log('1. admin change with A+B approved (weight 3, enough on EVM)')
  await expectFailure(
    'admin executes with 2 of 3 owners',
    () => sa.rpc.executeSettingsTransaction({ connection, feePayer: payer, settingsPda, transactionIndex: txIndex, signer: A, rentPayer: payer, policies: policyPdas, programId }),
    /InvalidProposalStatus|ProposalNotApproved|0x17/,
  )
  await confirm(await sa.rpc.approveProposal({ connection, feePayer: payer, settingsPda, transactionIndex: txIndex, signer: C, programId }))
  await expectFailure(
    'admin executes before the timelock',
    () => sa.rpc.executeSettingsTransaction({ connection, feePayer: payer, settingsPda, transactionIndex: txIndex, signer: A, rentPayer: payer, policies: policyPdas, programId }),
    /TimeLockNotReleased|TimeLock/,
  )
  await sleep((ADMIN_TIMELOCK + 3) * 1000)
  await confirm(await sa.rpc.executeSettingsTransaction({ connection, feePayer: payer, settingsPda, transactionIndex: txIndex, signer: A, rentPayer: payer, policies: policyPdas, programId }))
  log('  ✓ policies created after all 3 owners + timelock', policyPdas.map((p: { toBase58(): string }) => p.toBase58()).join(' '))

  // ── fund the vault ────────────────────────────────────────────────────────────────────────
  const vaultAta = await spl.getOrCreateAssociatedTokenAccount(connection, payer, mint, vault, true)
  const rAta = await spl.getOrCreateAssociatedTokenAccount(connection, payer, mint, R!.publicKey)
  const sAta = await spl.getOrCreateAssociatedTokenAccount(connection, payer, mint, S!.publicKey)
  await spl.mintTo(connection, payer, mint, vaultAta.address, payer, 1_000_000_000n)

  const spend = (policyIdx: number, signers: InstanceType<typeof Keypair>[], to: InstanceType<typeof Keypair>, toAta: InstanceType<typeof PublicKey>, amount: number) =>
    sa.rpc.executePolicyPayloadSync({
      connection,
      feePayer: payer,
      policy: policyPdas[policyIdx],
      accountIndex: 0,
      numSigners: signers.length,
      policyPayload: { __kind: 'SpendingLimit', fields: [{ amount: new BN(amount), destination: to.publicKey, decimals }] },
      instruction_accounts: [
        ...signers.map((k) => ({ pubkey: k.publicKey, isWritable: false, isSigner: true })),
        { pubkey: vault, isWritable: false, isSigner: false },
        { pubkey: vaultAta.address, isWritable: true, isSigner: false },
        { pubkey: toAta, isWritable: true, isSigner: false },
        { pubkey: mint, isWritable: false, isSigner: false },
        { pubkey: spl.TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
      ],
      signers,
      programId,
    })

  const idx = (ids: string) => plan.policies.findIndex((p) => p.coalition.join(',') === ids)

  // ── 2. winning coalitions spend to the allowlisted wallet ─────────────────────────────────
  await confirm(await spend(idx('A,B'), [A!, B!], R!, rAta.address, 100_000_000))
  log('2. ✓ {A,B} sent 100 TUSD to R')
  await confirm(await spend(idx('A,C'), [A!, C!], R!, rAta.address, 50_000_000))
  log('   ✓ {A,C} sent 50 TUSD to R')

  // ── 3–5. everything the weighted rule + allowlist forbids ──────────────────────────────────
  await expectFailure('3. {A,B} to non-allowlisted S', () => spend(idx('A,B'), [A!, B!], S!, sAta.address, 1_000_000), /InvalidDestination/)
  await expectFailure('4. {B,C} on the {A,B} policy (weight 2 < 3)', () => spend(idx('A,B'), [B!, C!], R!, rAta.address, 1_000_000), /NotASigner|InvalidSignerCount|Unauthorized|InsufficientVotePermissions|InvalidThreshold|0x/)
  await expectFailure('5. A alone (weight 2 < 3)', () => spend(idx('A,B'), [A!], R!, rAta.address, 1_000_000), /InvalidSignerCount|InsufficientAggregatePermissions|InsufficientVotePermissions|Threshold|0x/)

  const rBal = await connection.getTokenAccountBalance(rAta.address)
  const sBal = await connection.getTokenAccountBalance(sAta.address)
  log('balances', `R=${rBal.value.uiAmountString} TUSD · S=${sBal.value.uiAmountString} TUSD`)
  if (rBal.value.amount !== '150000000' || sBal.value.amount !== '0') throw new Error('unexpected final balances')
  log('\nPROOF PASSED', `settings ${settingsPda.toBase58()} (devnet)`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
