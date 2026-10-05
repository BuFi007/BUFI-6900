/*
 * Copyright (c) 2026 BUFI. Licensed under the Apache License, Version 2.0.
 *
 * State and actions for the Solana view: one weighted-treasury spec, compiled to Squads, driven against a local
 * `solana-test-validator` running the mainnet Smart Account Program (or devnet). Every on-chain step goes through
 * `squadsSteps` from @bufi6900/weighted-treasury, the same code the headless proof runs.
 *
 * Keys are browser keypairs kept in localStorage. They stand in for Circle user-controlled Solana wallets; on-chain
 * the two are indistinguishable. Owners hold no SOL: the demo payer covers every fee and rent.
 */
import './polyfill'

import * as web3 from '@solana/web3.js'
import * as spl from '@solana/spl-token'
import * as sa from '@sqds/smart-account'
import BN from 'bn.js'
import * as React from 'react'

import {
  type SquadsTreasuryPlan,
  type WeightedTreasurySpec,
  compileEvm,
  compileSquads,
  isWinning,
  programErrorName,
  squadsSteps,
} from '@bufi6900/weighted-treasury'

const { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } = web3
type Keypair = InstanceType<typeof Keypair>

export const LOCALNET = 'http://127.0.0.1:8899'
export const DEVNET = 'https://api.devnet.solana.com'
export const DECIMALS = 6
export const OWNER_IDS = ['A', 'B', 'C', 'D', 'E'] as const
const STORE = 'bufi6900.solana.v1'

export interface Attempt {
  id: number
  group: string[]
  destination: 'R' | 'S'
  amount: number
  expected: { pass: boolean; why: string }
  actual: { pass: boolean; detail: string }
  policy: string
}

interface Persisted {
  rpc: string
  keys: Record<string, string> // label → base64 secret key (A..E, R, S, payer)
  weights: number[]
  ownerCount: number
  threshold: number
  timelock: number
  treasury?: { settings: string; vault: string }
  token?: { mint: string; vaultAta: string }
  admin?: { txIndex: string; plan: string; policies: string[]; executed: boolean; owners: { id: string; weight: number }[]; threshold: number }
}

const defaults = (): Persisted => ({
  rpc: LOCALNET,
  keys: {},
  weights: [2, 1, 1, 1, 1],
  ownerCount: 3,
  threshold: 3,
  timelock: 10,
})

const load = (): Persisted => {
  try {
    const raw = localStorage.getItem(STORE)
    return raw ? { ...defaults(), ...(JSON.parse(raw) as Persisted) } : defaults()
  } catch {
    return defaults()
  }
}

const toB64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

/** Illustrative EVM owner/recipient addresses so the EVM side of the same spec can be shown. */
const evmFor = (i: number) => `0x${(0xb0f1 + i).toString(16).padStart(40, '0')}`

export function useSquadsDemo() {
  const [store, setStore] = React.useState<Persisted>(load)
  const save = React.useCallback((patch: Partial<Persisted>) => {
    setStore((prev) => {
      const next = { ...prev, ...patch }
      try {
        localStorage.setItem(STORE, JSON.stringify(next))
      } catch {
        /* storage blocked: the demo still works for this tab */
      }
      return next
    })
  }, [])

  // Generate any missing keypair once, then keep it.
  const keys = React.useMemo(() => {
    const out: Record<string, Keypair> = {}
    const fresh: Record<string, string> = {}
    for (const label of [...OWNER_IDS, 'R', 'S', 'payer']) {
      const existing = store.keys[label]
      const kp = existing ? Keypair.fromSecretKey(fromB64(existing)) : Keypair.generate()
      if (!existing) fresh[label] = toB64(kp.secretKey)
      out[label] = kp
    }
    if (Object.keys(fresh).length) queueMicrotask(() => save({ keys: { ...store.keys, ...fresh } }))
    return out
  }, [store.keys, save])

  const connection = React.useMemo(() => new Connection(store.rpc, 'confirmed'), [store.rpc])
  const steps = React.useMemo(() => squadsSteps({ web3, spl, BN, sa }, connection), [connection])
  const owners = OWNER_IDS.slice(0, store.ownerCount)
  const payer = keys.payer!

  const spec: WeightedTreasurySpec = React.useMemo(
    () => ({
      version: 1,
      owners: owners.map((id, i) => ({ id, weight: store.weights[i] ?? 1, evm: evmFor(i), solana: keys[id]!.publicKey.toBase58() })),
      thresholdWeight: store.threshold,
      allowlist: [{ label: 'R', evm: evmFor(9), solana: keys.R!.publicKey.toBase58() }],
      assets: [{ symbol: 'TUSD', solanaMint: store.token?.mint ?? keys.payer!.publicKey.toBase58(), solanaDecimals: DECIMALS }],
      adminTimelockSeconds: store.timelock,
    }),
    [owners, store.weights, store.threshold, store.timelock, store.token?.mint, keys],
  )

  const compiled = React.useMemo(() => {
    try {
      return { squads: compileSquads(spec), evm: compileEvm(spec), error: undefined as string | undefined }
    } catch (error) {
      return { squads: undefined, evm: undefined, error: (error as Error).message }
    }
  }, [spec])

  // ── live chain state ───────────────────────────────────────────────────────────────────────
  const [chain, setChain] = React.useState<{
    online: boolean
    programDeployed: boolean
    payerSol: number
    ownerSol: Record<string, number>
    settings?: { threshold: number; timeLock: number; signers: string[] }
    proposal?: { status: string; approved: string[]; timestamp?: number } | null
    policies: ({ address: string; signers: string[]; threshold: number } | null)[]
    balances: { vault: bigint; R: bigint; S: bigint }
  }>({ online: false, programDeployed: false, payerSol: 0, ownerSol: {}, policies: [], balances: { vault: 0n, R: 0n, S: 0n } })
  const [tick, setTick] = React.useState(0)
  const refresh = React.useCallback(() => setTick((t) => t + 1), [])

  React.useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const program = await connection.getAccountInfo(steps.programId)
        const payerSol = (await connection.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL
        const ownerSol: Record<string, number> = {}
        for (const id of owners) ownerSol[id] = (await connection.getBalance(keys[id]!.publicKey)) / LAMPORTS_PER_SOL
        let settings
        if (store.treasury) {
          try {
            const s = await sa.accounts.Settings.fromAccountAddress(connection, new PublicKey(store.treasury.settings))
            settings = { threshold: s.threshold, timeLock: s.timeLock, signers: s.signers.map((x: { key: { toBase58(): string } }) => x.key.toBase58()) }
          } catch {
            settings = undefined
          }
        }
        const proposal = store.treasury && store.admin ? await steps.adminProposal(new PublicKey(store.treasury.settings), BigInt(store.admin.txIndex)) : undefined
        const policies = store.admin ? await steps.readPolicies(store.admin.policies.map((p) => new PublicKey(p))) : []
        const bal = async (owner: Keypair | undefined, ata?: string) => {
          if (!store.token) return 0n
          if (ata) return steps.balance(new PublicKey(ata))
          const addr = spl.getAssociatedTokenAddressSync(new PublicKey(store.token.mint), owner!.publicKey, true)
          return steps.balance(addr)
        }
        const balances = { vault: await bal(undefined, store.token?.vaultAta), R: await bal(keys.R), S: await bal(keys.S) }
        if (!cancelled) setChain({ online: true, programDeployed: !!program?.executable, payerSol, ownerSol, settings, proposal, policies, balances })
      } catch {
        if (!cancelled) setChain((c) => ({ ...c, online: false }))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [connection, steps, payer, keys, owners, store.treasury, store.admin, store.token, tick])

  // ── actions ───────────────────────────────────────────────────────────────────────────────
  const [busy, setBusy] = React.useState<string>()
  const [message, setMessage] = React.useState<{ kind: 'ok' | 'error' | 'info'; text: string }>()
  const [attempts, setAttempts] = React.useState<Attempt[]>([])

  const act = React.useCallback(
    async (label: string, fn: () => Promise<string | void>) => {
      setBusy(label)
      setMessage(undefined)
      try {
        const text = await fn()
        setMessage({ kind: 'ok', text: text ?? `${label}: done` })
      } catch (error) {
        setMessage({ kind: 'error', text: `${label}: ${programErrorName(error)}` })
      } finally {
        setBusy(undefined)
        refresh()
      }
    },
    [refresh],
  )

  const plan = compiled.squads
  const settingsPk = store.treasury ? new PublicKey(store.treasury.settings) : undefined
  const savedPlan: SquadsTreasuryPlan | undefined = store.admin ? (JSON.parse(store.admin.plan, reviveBigint) as SquadsTreasuryPlan) : undefined

  const actions = {
    setRpc: (rpc: string) => save({ rpc, treasury: undefined, token: undefined, admin: undefined }),
    setWeight: (i: number, w: number) => save({ weights: store.weights.map((x, j) => (j === i ? w : x)) }),
    setOwnerCount: (n: number) => save({ ownerCount: n }),
    setThreshold: (t: number) => save({ threshold: t }),
    setTimelock: (t: number) => save({ timelock: t }),

    airdrop: () =>
      act('Airdrop 10 SOL to the payer', async () => {
        await steps.confirm(await connection.requestAirdrop(payer.publicKey, 10 * LAMPORTS_PER_SOL))
        return 'Payer funded with 10 SOL'
      }),

    createTreasury: () =>
      act('Create smart account', async () => {
        if (!plan) throw new Error(compiled.error ?? 'spec does not compile')
        const t = await steps.createTreasury(payer, plan)
        save({ treasury: { settings: t.settingsPda.toBase58(), vault: t.vault.toBase58() }, token: undefined, admin: undefined })
        setAttempts([])
        return `Smart account created: settings ${short(t.settingsPda.toBase58())}, all ${plan.settings.signers.length} owners, ${plan.settings.timeLock}s admin timelock`
      }),

    fundVault: () =>
      act('Create test token and fund the vault', async () => {
        if (!store.treasury) throw new Error('create the smart account first')
        const { mint, vaultAta } = await steps.fundVault(payer, new PublicKey(store.treasury.vault), DECIMALS, 1_000_000_000n)
        save({ token: { mint: mint.toBase58(), vaultAta: vaultAta.toBase58() }, admin: undefined })
        return `Vault funded with 1,000 TUSD (mint ${short(mint.toBase58())})`
      }),

    propose: () =>
      act('Propose the spending policies', async () => {
        if (!settingsPk || !store.token || !plan) throw new Error('create and fund the treasury first')
        const txIndex = await steps.nextAdminIndex(settingsPk)
        const policies = steps.policyPdas(settingsPk, plan)
        await steps.proposePolicies(payer, keys.A!, settingsPk, plan, txIndex)
        save({ admin: { txIndex: txIndex.toString(), plan: JSON.stringify(plan, replaceBigint), policies: policies.map((p: { toBase58(): string }) => p.toBase58()), executed: false, owners: spec.owners.map((o) => ({ id: o.id, weight: o.weight })), threshold: spec.thresholdWeight } })
        return `Proposed ${plan.policies.length} policies as A. Every owner must approve.`
      }),

    approve: (id: string) =>
      act(`Approve as ${id}`, async () => {
        if (!settingsPk || !store.admin) throw new Error('propose first')
        await steps.approve(payer, settingsPk, BigInt(store.admin.txIndex), keys[id]!)
        return `${id} approved`
      }),

    execute: () =>
      act('Execute the admin change', async () => {
        if (!settingsPk || !store.admin) throw new Error('propose first')
        await steps.executeAdmin(payer, settingsPk, BigInt(store.admin.txIndex), keys.A!, store.admin.policies.map((p) => new PublicKey(p)))
        save({ admin: { ...store.admin, executed: true } })
        return 'Policies created on-chain'
      }),

    spend: (group: string[], destination: 'R' | 'S', amount: number) =>
      act(`Spend ${amount} TUSD from {${group.join(',')}} to ${destination}`, async () => {
        if (!store.treasury || !store.token || !store.admin || !savedPlan) throw new Error('create the policies first')
        // Judge against the spec the on-chain policies were compiled from, not the editor's current values.
        const weights = store.admin.owners
        const threshold = store.admin.threshold
        const ids = new Set(group)
        const weightOk = isWinning(weights, threshold, ids)
        const destOk = destination === 'R'
        const expected = {
          pass: weightOk && destOk,
          why: !weightOk ? `weight ${sumWeights(weights, ids)} < ${threshold}` : !destOk ? 'S is not on the allowlist' : 'weight reached, R is allowlisted',
        }
        // A policy whose signers are all in the group; otherwise the closest one, to show the program reject it.
        const groupKeys = new Set(group.map((id) => keys[id]!.publicKey.toBase58()))
        let idx = savedPlan.policies.findIndex((p) => p.signers.every((s) => groupKeys.has(s.key)))
        let policyNote = idx >= 0 ? `{${savedPlan.policies[idx]!.coalition.join(',')}}` : ''
        if (idx < 0) {
          idx = bestOverlap(savedPlan, groupKeys)
          policyNote = `none for this group; tried {${savedPlan.policies[idx]!.coalition.join(',')}}`
        }
        const policy = savedPlan.policies[idx]!
        // A group that holds a policy signs with exactly that policy's members; otherwise with the whole group.
        const signerIds = policy.signers.every((s) => groupKeys.has(s.key)) ? policy.coalition : group
        const mint = new PublicKey(store.token.mint)
        const dest = keys[destination]!
        const destinationAta = await steps.ata(payer, mint, dest.publicKey)
        const raw = BigInt(Math.round(amount * 10 ** DECIMALS))
        let actual: Attempt['actual']
        try {
          const sig = await steps.spend({
            payer,
            policy: new PublicKey(store.admin.policies[idx]!),
            signers: signerIds.map((id) => keys[id]!),
            vault: new PublicKey(store.treasury.vault),
            vaultAta: new PublicKey(store.token.vaultAta),
            mint,
            destination: dest.publicKey,
            destinationAta,
            amount: raw,
            decimals: DECIMALS,
          })
          actual = { pass: true, detail: `paid · ${short(sig)}` }
        } catch (error) {
          actual = { pass: false, detail: programErrorName(error) }
        }
        setAttempts((list) => [{ id: Date.now(), group, destination, amount, expected, actual, policy: policyNote }, ...list])
        return actual.pass ? `Paid ${amount} TUSD to ${destination}` : `Rejected by the program: ${actual.detail}`
      }),

    reset: () => {
      save({ treasury: undefined, token: undefined, admin: undefined })
      setAttempts([])
      setMessage({ kind: 'info', text: 'Treasury forgotten. Keys kept.' })
    },
  }

  return { store, keys, owners, spec, compiled, chain, busy, message, attempts, actions, refresh, savedPlan }
}

function sumWeights(owners: readonly { id: string; weight: number }[], ids: Set<string>) {
  return owners.filter((o) => ids.has(o.id)).reduce((a, o) => a + o.weight, 0)
}
function bestOverlap(plan: SquadsTreasuryPlan, keys: Set<string>) {
  let best = 0
  let score = -1
  plan.policies.forEach((p, i) => {
    const s = p.signers.filter((x) => keys.has(x.key)).length
    if (s > score) {
      best = i
      score = s
    }
  })
  return best
}
export const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`
const replaceBigint = (_k: string, v: unknown) => (typeof v === 'bigint' ? { $bigint: v.toString() } : v)
const reviveBigint = (_k: string, v: unknown) =>
  v && typeof v === 'object' && '$bigint' in (v as Record<string, unknown>) ? BigInt((v as { $bigint: string }).$bigint) : v
