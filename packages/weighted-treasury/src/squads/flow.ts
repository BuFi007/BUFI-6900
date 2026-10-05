// SPDX-License-Identifier: Apache-2.0
/**
 * The Squads treasury lifecycle as plain async steps: create the smart account, propose the policies,
 * collect owner approvals, execute after the timelock, spend through a policy, read state back.
 *
 * Shared by `scripts/devnet-proof.ts` and the playground UI, so the demo and the proof run the same code.
 * The Solana SDKs are injected (`SquadsRuntime`) instead of imported: this package has no Solana dependency,
 * and the caller passes the single web3.js / spl-token / bn.js copy its `@sqds/smart-account` build uses.
 */
import type { SquadsTreasuryPlan } from './compile'
import { toSdkPolicyCreateActions, toSdkSigners } from './sdk-args'

/* eslint-disable @typescript-eslint/no-explicit-any -- the injected SDKs are untyped at this boundary on purpose */
type Any = any

export interface SquadsRuntime {
  web3: Any
  spl: Any
  BN: Any
  /** `@sqds/smart-account` */
  sa: Any
}

export const SMART_ACCOUNT_PROGRAM = 'SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG'

export interface TreasuryHandle {
  settingsPda: Any
  vault: Any
}

/** The program error name in a failed send (`InvalidDestination`, `NotASigner`, …), or the raw message. */
export function programErrorName(err: unknown): string {
  const e = err as { logs?: string[]; message?: string }
  const text = `${e?.logs?.join('\n') ?? ''}\n${e?.message ?? String(err)}`
  const named = text.match(/Error Code: (\w+)/) ?? text.match(/\b(InvalidDestination|NotASigner|InvalidSignerCount|InvalidProposalStatus|TimeLockNotReleased|InsufficientVotePermissions|Unauthorized|AlreadyApproved|InvalidThreshold|SpendingLimitExceeded\w*)\b/)
  if (named) return named[1]!
  // SPL Token's InsufficientFunds is error 0x1, which says nothing on its own.
  if (/insufficient funds/i.test(text)) return 'InsufficientFunds'
  const custom = text.match(/custom program error: (0x[0-9a-f]+)/i)
  return custom ? `custom error ${custom[1]}` : (e?.message ?? String(err)).slice(0, 200)
}

async function confirm(connection: Any, signature: string): Promise<string> {
  const bh = await connection.getLatestBlockhash()
  const res = await connection.confirmTransaction({ signature, ...bh }, 'confirmed')
  if (res.value?.err) throw new Error(`transaction ${signature} failed: ${JSON.stringify(res.value.err)}`)
  return signature
}

export function squadsSteps(rt: SquadsRuntime, connection: Any) {
  const { web3, spl, BN, sa } = rt
  const programId = new web3.PublicKey(SMART_ACCOUNT_PROGRAM)
  const send = async (p: Promise<string>) => confirm(connection, await p)

  return {
    programId,
    confirm: (sig: string) => confirm(connection, sig),

    /** Settings = every owner, threshold = all, admin timelock. Retries the account-index race. */
    async createTreasury(payer: Any, plan: SquadsTreasuryPlan): Promise<TreasuryHandle & { signature: string }> {
      const [programConfigPda] = sa.getProgramConfigPda({ programId })
      let lastError: unknown
      for (let attempt = 0; attempt < 5; attempt++) {
        const cfg = await sa.accounts.ProgramConfig.fromAccountAddress(connection, programConfigPda)
        const accountIndex = BigInt(cfg.smartAccountIndex.toString()) + 1n
        const [settingsPda] = sa.getSettingsPda({ accountIndex, programId })
        try {
          const signature = await send(
            sa.rpc.createSmartAccount({
              connection,
              treasury: cfg.treasury,
              creator: payer,
              settings: settingsPda,
              settingsAuthority: null,
              threshold: plan.settings.threshold,
              signers: toSdkSigners(plan.settings.signers, web3),
              timeLock: plan.settings.timeLock,
              rentCollector: null,
              programId,
            }),
          )
          const [vault] = sa.getSmartAccountPda({ settingsPda, accountIndex: 0, programId })
          return { settingsPda, vault, signature }
        } catch (err) {
          lastError = err
        }
      }
      throw lastError
    },

    /** Next settings transaction index and the PDAs the policies will get. */
    async nextAdminIndex(settingsPda: Any): Promise<bigint> {
      const settings = await sa.accounts.Settings.fromAccountAddress(connection, settingsPda)
      return BigInt(settings.transactionIndex.toString()) + 1n
    },

    policyPdas(settingsPda: Any, plan: SquadsTreasuryPlan, firstSeed = 1): Any[] {
      return plan.policies.map((_, i) => sa.getPolicyPda({ settingsPda, policySeed: firstSeed + i, programId })[0])
    },

    /** Admin step 1: a settings transaction with every PolicyCreate, plus its proposal. */
    async proposePolicies(payer: Any, creator: Any, settingsPda: Any, plan: SquadsTreasuryPlan, transactionIndex: bigint) {
      const actions = toSdkPolicyCreateActions(plan, { PublicKey: web3.PublicKey, BN })
      await send(
        sa.rpc.createSettingsTransaction({
          connection, feePayer: payer, settingsPda, transactionIndex, creator: creator.publicKey,
          rentPayer: payer.publicKey, actions, programId, signers: [creator],
        }),
      )
      await send(sa.rpc.createProposal({ connection, feePayer: payer, settingsPda, transactionIndex, creator, rentPayer: payer, programId }))
    },

    approve: (payer: Any, settingsPda: Any, transactionIndex: bigint, signer: Any) =>
      send(sa.rpc.approveProposal({ connection, feePayer: payer, settingsPda, transactionIndex, signer, programId })),

    executeAdmin: (payer: Any, settingsPda: Any, transactionIndex: bigint, signer: Any, policies: Any[]) =>
      send(sa.rpc.executeSettingsTransaction({ connection, feePayer: payer, settingsPda, transactionIndex, signer, rentPayer: payer, policies, programId })),

    /** Proposal status + approvers for an admin transaction (null if it does not exist yet). */
    async adminProposal(settingsPda: Any, transactionIndex: bigint): Promise<{ status: string; approved: string[]; timestamp?: number } | null> {
      const [proposalPda] = sa.getProposalPda({ settingsPda, transactionIndex, programId })
      try {
        const p = await sa.accounts.Proposal.fromAccountAddress(connection, proposalPda)
        const ts = (p.status as { timestamp?: { toString(): string } }).timestamp
        return { status: p.status.__kind, approved: p.approved.map((k: Any) => k.toBase58()), timestamp: ts ? Number(ts.toString()) : undefined }
      } catch {
        return null
      }
    },

    /** Policies that exist on-chain, with their signers. */
    async readPolicies(policies: Any[]): Promise<({ address: string; signers: string[]; threshold: number } | null)[]> {
      return Promise.all(
        policies.map(async (pda) => {
          try {
            const p = await sa.accounts.Policy.fromAccountAddress(connection, pda)
            return { address: pda.toBase58(), signers: p.signers.map((s: Any) => s.key.toBase58()), threshold: p.threshold }
          } catch {
            return null
          }
        }),
      )
    },

    /** A token the payer controls, an ATA for the vault, and `amount` minted into it. */
    async fundVault(payer: Any, vault: Any, decimals: number, amount: bigint) {
      const mint = await spl.createMint(connection, payer, payer.publicKey, null, decimals)
      const vaultAta = await spl.getOrCreateAssociatedTokenAccount(connection, payer, mint, vault, true)
      await spl.mintTo(connection, payer, mint, vaultAta.address, payer, amount)
      return { mint, vaultAta: vaultAta.address }
    },

    ata: async (payer: Any, mint: Any, owner: Any) =>
      (await spl.getOrCreateAssociatedTokenAccount(connection, payer, mint, owner, true)).address,

    balance: async (tokenAccount: Any): Promise<bigint> => {
      try {
        return BigInt((await connection.getTokenAccountBalance(tokenAccount)).value.amount)
      } catch {
        return 0n
      }
    },

    /** One co-signed transaction through a SpendingLimit policy. No proposal round-trip. */
    spend(input: { payer: Any; policy: Any; signers: Any[]; vault: Any; vaultAta: Any; mint: Any; destination: Any; destinationAta: Any; amount: bigint; decimals: number }) {
      const { payer, policy, signers, vault, vaultAta, mint, destination, destinationAta, amount, decimals } = input
      return send(
        sa.rpc.executePolicyPayloadSync({
          connection,
          feePayer: payer,
          policy,
          accountIndex: 0,
          numSigners: signers.length,
          policyPayload: { __kind: 'SpendingLimit', fields: [{ amount: new BN(amount.toString()), destination, decimals }] },
          instruction_accounts: [
            ...signers.map((k: Any) => ({ pubkey: k.publicKey, isWritable: false, isSigner: true })),
            { pubkey: vault, isWritable: false, isSigner: false },
            { pubkey: vaultAta, isWritable: true, isSigner: false },
            { pubkey: destinationAta, isWritable: true, isSigner: false },
            { pubkey: mint, isWritable: false, isSigner: false },
            { pubkey: spl.TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
          ],
          signers,
          programId,
        }),
      )
    },
  }
}
