// SPDX-License-Identifier: Apache-2.0
/**
 * The send pipeline: approvals → Gateway attestation → mint, recorded as a job the browser polls.
 * One send at a time (a signed intent is a bearer note until it expires; never race two).
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { type Address, type Hex, isAddress, parseUnits } from 'viem'

import { EXPLORER, POSITIONS, type PositionId, fetchGatewayBalances, pickSource } from '../shared/config'
import type { Job, SendRequest, Step, TreasuryPolicy } from '../shared/types'
import { buildEvmIntent, evmContractSignature, gatewayMint, isAllowlisted, localIsValidSignature, readPolicy } from './evm'
import { gatewayMessage, postTransfer } from './gateway'
export { mintedAmountFromLogs } from './mint-log'
import { ATTESTATION_DIR, type FrostOwners, readEvmAddresses, readFrostOwners } from './secrets'
import { SOLANA_EXPIRY_SLOTS, frostSign, makeSolanaIntent, solanaSlot } from './solana'

const ERC1271_MAGIC = '0x1626ba7e'
const jobs = new Map<string, Job>()
let running: string | null = null

let policyCache: { at: number; policy: TreasuryPolicy } | null = null
export async function policy(): Promise<TreasuryPolicy> {
  if (policyCache && Date.now() - policyCache.at < 60_000) return policyCache.policy
  const p = await readPolicy(readEvmAddresses())
  policyCache = { at: Date.now(), policy: p }
  return p
}

export class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id)
}

const short = (s: string, n = 600) => (s.length > n ? `${s.slice(0, n)}…` : s)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Testnet sandbox guard: keep every send small. Applies to refusal demos too: a refusal never needs a big amount. */
export const SANDBOX_CAP_USDC = 1

export interface ValidateInput {
  req: SendRequest
  pol: TreasuryPolicy
  allowlisted: boolean
  balances: Record<PositionId, number>
  /** FROST share map (owners.json). Required for the Solana leg. */
  frostOwners: FrostOwners | null
}

/**
 * Pure request validation. Every cap and the balance check apply unconditionally: `expectRefusal` (client-controlled)
 * only adds a check, it never removes one. For the Solana leg, the FROST share map must match the on-chain weights,
 * or the server's prediction of who can sign (made from on-chain weights) would not be what FROST actually allows.
 */
export function validateSend({ req, pol, allowlisted, balances, frostOwners }: ValidateInput) {
  if (req.asset !== 'USDC') throw new RequestError(400, `${String(req.asset)} is not on Gateway yet; only USDC can move`)
  if (!/^\d+(\.\d{1,6})?$/.test(req.amount ?? '')) throw new RequestError(400, 'amount must be a positive decimal with at most 6 places')
  const value = parseUnits(req.amount, 6)
  if (value <= 0n) throw new RequestError(400, 'amount must be positive')
  if (!isAddress(req.recipient ?? '')) throw new RequestError(400, 'recipient must be an EVM address')
  const signers = [...new Set(req.signers ?? [])]
  if (signers.length === 0) throw new RequestError(400, 'choose at least one owner to approve')
  const unknown = signers.filter((s) => !pol.owners.some((o) => o.id === s))
  if (unknown.length) throw new RequestError(400, `not an owner: ${unknown.join(', ')}`)
  const weight = signers.reduce((sum, id) => sum + (pol.owners.find((o) => o.id === id)?.weight ?? 0), 0)
  const amount = Number(req.amount)

  if (amount > SANDBOX_CAP_USDC) throw new RequestError(400, `this sandbox caps a single send at ${SANDBOX_CAP_USDC} USDC`)
  if (amount > pol.perIntentCap) throw new RequestError(400, `per-intent cap is ${pol.perIntentCap} USDC`)
  if (req.expectRefusal && allowlisted && weight >= pol.thresholdWeight) {
    throw new RequestError(400, 'refusal demo: this request is valid and would move funds; pick a non-allowlisted recipient or a sub-threshold quorum')
  }

  let source: PositionId
  if (req.source === 'auto' || !req.source) {
    const picked = pickSource(balances, amount, pol.perIntentCap)
    if (!picked) throw new RequestError(400, `no position covers ${req.amount} USDC + fee (treasury ${balances.evm}, vault ${balances.solana})`)
    source = picked
  } else if (req.source === 'evm' || req.source === 'solana') {
    source = req.source
    const need = amount + POSITIONS[source].feeEstimate
    if (balances[source] < need) {
      throw new RequestError(400, `${POSITIONS[source].label} holds ${balances[source]} USDC; ${need} needed with fee`)
    }
  } else {
    throw new RequestError(400, 'source must be auto, evm or solana')
  }

  if (source === 'solana') {
    const drift = frostDrift(pol, frostOwners)
    if (drift) throw new RequestError(409, `FROST share map disagrees with the on-chain policy (${drift}); re-run the DKG for the current owners before signing on Solana`)
  }
  return { source, value, signers, weight, amount }
}

/** Null when FROST's share map equals the on-chain weights and threshold; otherwise what differs. */
function frostDrift(pol: TreasuryPolicy, frost: FrostOwners | null): string | null {
  if (!frost) return 'no owners.json'
  if (frost.threshold !== pol.thresholdWeight) return `share threshold ${frost.threshold} vs on-chain threshold ${pol.thresholdWeight}`
  for (const o of pol.owners) {
    const n = frost.shares[o.id]?.length ?? 0
    if (n !== o.weight) return `owner ${o.id}: ${n} shares vs on-chain weight ${o.weight}`
  }
  const extra = Object.keys(frost.shares).filter((id) => !pol.owners.some((o) => o.id === id))
  if (extra.length) return `share holders not on-chain owners: ${extra.join(', ')}`
  return null
}

// ── Accepted-but-unminted attestations ──────────────────────────────────────────────────────────
// An attestation is a bearer note (destinationCaller = 0): once Gateway accepts, the treasury's balance is committed.
// It is kept (in memory and on disk, 0600) until a mint receipt succeeds, and a new send of the same amount to the
// same recipient is refused meanwhile, so a failed or slow mint is RESUMED, never paid twice.
interface PendingMint {
  recipient: string
  value: bigint
  dest?: 'base' | 'arc'
  attestation?: Hex
  signature?: Hex
}
const pendingMints = new Map<string, PendingMint>()

export function recordPendingMint(jobId: string, p: PendingMint) {
  pendingMints.set(jobId, p)
  if (p.attestation) {
    mkdirSync(ATTESTATION_DIR, { recursive: true, mode: 0o700 })
    writeFileSync(
      join(ATTESTATION_DIR, `${jobId}.json`),
      JSON.stringify({ ...p, value: p.value.toString(), savedAt: new Date().toISOString() }),
      { mode: 0o600 },
    )
  }
}

export function clearPendingMint(jobId: string) {
  pendingMints.delete(jobId)
  rmSync(join(ATTESTATION_DIR, `${jobId}.json`), { force: true })
}

export function assertNoPendingMint(recipient: string, value: bigint) {
  for (const [id, p] of pendingMints) {
    if (p.recipient.toLowerCase() === recipient.toLowerCase() && p.value === value) {
      throw new RequestError(409, `job ${id} holds an unminted attestation for this recipient and amount; resume that mint instead of sending again`)
    }
  }
}

/** Reload attestations saved by a previous dev-server run. */
function loadPendingMints() {
  if (!existsSync(ATTESTATION_DIR)) return
  for (const f of readdirSync(ATTESTATION_DIR)) {
    if (!f.endsWith('.json')) continue
    try {
      const j = JSON.parse(readFileSync(join(ATTESTATION_DIR, f), 'utf8')) as PendingMint & { value: string }
      pendingMints.set(f.slice(0, -5), { ...j, value: BigInt(j.value) })
    } catch {
      console.error(`[ut] unreadable attestation file ${f}`)
    }
  }
}
loadPendingMints()

/** Validate, choose the source, and start the job. Throws RequestError for anything the caller got wrong. */
export async function startSend(req: SendRequest): Promise<Job> {
  const pol = await policy()
  const allowlisted = isAddress(req.recipient ?? '') ? await isAllowlisted(req.recipient as Address) : false
  const balances = await fetchGatewayBalances()
  let frostOwners: FrostOwners | null = null
  try {
    frostOwners = readFrostOwners()
  } catch {
    frostOwners = null
  }
  const { source, value, signers, weight } = validateSend({ req, pol, allowlisted, balances, frostOwners })
  assertNoPendingMint(req.recipient, value)

  if (running) throw new RequestError(409, `a send is already running (${running})`)
  const id = randomBytes(8).toString('hex')
  const job: Job = {
    id,
    request: { ...req, signers },
    source,
    destinationChain: POSITIONS[source].destination.chain,
    status: 'running',
    steps: [
      { key: 'approvals', label: 'Approvals collected', state: 'pending' },
      { key: 'attestation', label: 'Gateway attestation', state: 'pending' },
      { key: 'mint', label: 'Minted', state: 'pending' },
    ],
  }
  jobs.set(id, job)
  if (jobs.size > 25) jobs.delete(jobs.keys().next().value as string)
  const ctx = { job, value, weight, allowlisted, pol, signers, recipient: req.recipient as Address }
  track(job, source === 'evm' ? runEvm(ctx) : runSolana(ctx))
  return job
}

/** Resume the mint of a job whose attestation Gateway already issued. Uses the SAME attestation; never a new intent. */
export function resumeMint(jobId: string): Job {
  const job = jobs.get(jobId)
  const p = pendingMints.get(jobId)
  if (!p?.attestation || !p.signature || !p.dest) throw new RequestError(404, 'no unminted attestation for this job')
  if (running) throw new RequestError(409, `a send is already running (${running})`)
  const j: Job =
    job ??
    ({
      id: jobId,
      request: { asset: 'USDC', amount: (Number(p.value) / 1e6).toString(), recipient: p.recipient, signers: [], source: p.dest === 'base' ? 'evm' : 'solana' },
      source: p.dest === 'base' ? 'evm' : 'solana',
      destinationChain: p.dest === 'base' ? 'Base Sepolia' : 'Arc testnet',
      status: 'running',
      steps: [
        { key: 'approvals', label: 'Approvals collected', state: 'done' },
        { key: 'attestation', label: 'Gateway attestation', state: 'done' },
        { key: 'mint', label: 'Minted', state: 'pending' },
      ],
    } satisfies Job)
  jobs.set(jobId, j)
  j.status = 'running'
  j.error = undefined
  j.resumable = false
  const ctx = { job: j, value: p.value, weight: 0, allowlisted: true, pol: null as unknown as TreasuryPolicy, signers: [], recipient: p.recipient as Address }
  track(j, mint(ctx, p.dest, p.attestation, p.signature))
  return j
}

function track(job: Job, work: Promise<unknown>) {
  running = job.id
  void work
    .catch((err: unknown) => {
      const e = err as Error & { txHash?: string }
      job.status = 'error'
      job.error = short(e.message ?? String(err))
      const cur = job.steps.find((s) => s.state === 'running')
      if (cur) {
        cur.state = 'failed'
        cur.detail = job.error
        if (e.txHash) cur.txHash = e.txHash
      }
      if (pendingMints.get(job.id)?.attestation) {
        job.resumable = true
        job.error = `${job.error} · the attestation is saved: resume the mint (do not send again)`
      }
      console.error(`[ut] job ${job.id} failed: ${job.error}`)
    })
    .finally(() => {
      for (const s of job.steps) if (s.state === 'pending') s.state = 'skipped'
      running = null
    })
}

interface Ctx {
  job: Job
  value: bigint
  weight: number
  allowlisted: boolean
  pol: TreasuryPolicy
  signers: string[]
  recipient: Address
}

const step = (job: Job, key: Step['key']) => job.steps.find((s) => s.key === key)!

function refuse(job: Job, at: Step, text: string, detail: string) {
  at.state = 'failed'
  at.detail = detail
  job.status = 'refused'
  job.refusal = text
}

async function mint(ctx: Ctx, dest: 'base' | 'arc', attestation: Hex, signature: Hex) {
  const { job } = ctx
  const s = step(job, 'mint')
  s.state = 'running'
  const { hash, before, after, minted } = await gatewayMint(dest, attestation, signature, ctx.recipient)
  // The receipt succeeded: the attestation is consumed whatever the balance RPC says. Never report this as an error.
  clearPendingMint(job.id)
  s.txHash = hash
  s.link = `${EXPLORER[job.destinationChain]}${hash}`
  job.recipientBalance = { before: (Number(before) / 1e6).toString(), after: (Number(after) / 1e6).toString() }
  s.state = 'done'
  if (minted === ctx.value) {
    s.detail = `${job.destinationChain}: receipt Transfer ${Number(minted) / 1e6} USDC to the recipient · balance ${job.recipientBalance.before} → ${job.recipientBalance.after}`
  } else {
    s.detail = `${job.destinationChain}: mint receipt succeeded; receipt shows ${Number(minted) / 1e6} USDC to the recipient (expected ${Number(ctx.value) / 1e6}), balance ${job.recipientBalance.before} → ${job.recipientBalance.after} (public RPCs lag; check the explorer)`
  }
  job.status = 'minted'
}

/** Gateway accepted: keep the attestation before anything else can fail. */
function accepted(ctx: Ctx, dest: 'base' | 'arc', text: string): { attestation: Hex; signature: Hex } {
  const { attestation, signature } = JSON.parse(text) as { attestation: Hex; signature: Hex }
  recordPendingMint(ctx.job.id, { recipient: ctx.recipient, value: ctx.value, dest, attestation, signature })
  return { attestation, signature }
}

async function runEvm(ctx: Ctx) {
  const { job, signers, weight, pol } = ctx
  const a = step(job, 'approvals')
  a.state = 'running'
  const { message, hash } = await buildEvmIntent(ctx.recipient, ctx.value)
  const sig = await evmContractSignature(message, hash, signers)
  const local = await localIsValidSignature(hash, sig)
  const verdict = local === ERC1271_MAGIC ? 'valid' : 'invalid (policy refuses)'
  a.state = weight >= pol.thresholdWeight ? 'done' : 'failed'
  a.detail = `${signers.join('+')} · weight ${weight} of ${pol.thresholdWeight} · treasury isValidSignature: ${local} (${verdict})${
    ctx.allowlisted ? '' : ' · recipient not on allowlist'
  }`

  const t = step(job, 'attestation')
  t.state = 'running'
  const r = await postTransfer(message, sig, true)
  if (!r.ok) return refuse(job, t, r.text, `Gateway ${r.status}: ${gatewayMessage(r.text)}`)
  const att = accepted(ctx, 'base', r.text)
  t.state = 'done'
  t.detail = `Gateway ${r.status}: attestation issued`
  await mint(ctx, 'base', att.attestation, att.signature)
}

async function runSolana(ctx: Ctx) {
  const { job, signers, weight, pol } = ctx
  const a = step(job, 'approvals')
  a.state = 'running'
  if (!ctx.allowlisted) {
    const text = `Server refused: ${ctx.recipient} is not on the treasury's on-chain allowlist. The Solana vault has no on-chain allowlist; this leg's policy is OFF-CHAIN (this check, then frost-delegate's policy.json) and cannot stop a share majority signing outside it.`
    return refuse(job, a, text, 'refused before signing (allowlist)')
  }
  const slot = await solanaSlot()
  const intent = makeSolanaIntent({ recipient: ctx.recipient, value: ctx.value, maxBlockHeight: slot + SOLANA_EXPIRY_SLOTS })
  const signed = await frostSign(signers, intent, slot)
  if (!signed.ok && signed.reason === 'policy') {
    return refuse(job, a, `FROST coordinator policy refused the intent: ${signed.detail}`, 'refused before signing (coordinator policy)')
  }
  if (!signed.ok) {
    const text = `FROST: ${signers.join('+')} hold fewer than the threshold of shares (weight ${weight} of ${pol.thresholdWeight}); no Ed25519 signature for the delegate key can exist.`
    return refuse(job, a, text, `weight ${weight} of ${pol.thresholdWeight}: cannot sign`)
  }
  const sig = signed.signature
  a.state = 'done'
  a.detail = `${signers.join('+')} · weight ${weight} of ${pol.thresholdWeight} · one FROST Ed25519 signature from the delegate key`

  const t = step(job, 'attestation')
  t.state = 'running'
  // Gateway indexes a new delegate with a lag; a refused intent is not consumed, so resubmitting it is safe.
  let r = await postTransfer(intent, sig, false)
  for (let i = 0; i < 36 && !r.ok && /not authorized/i.test(r.text); i++) {
    t.detail = `delegate not indexed by Gateway yet, retrying (${(i + 1) * 5}s)`
    await sleep(5000)
    r = await postTransfer(intent, sig, false)
  }
  if (!r.ok) return refuse(job, t, r.text, `Gateway ${r.status}: ${gatewayMessage(r.text)}`)
  const att = accepted(ctx, 'arc', r.text)
  t.state = 'done'
  t.detail = `Gateway ${r.status}: attestation issued`
  await mint(ctx, 'arc', att.attestation, att.signature)
}
