/**
 * The approval gate. A money-moving tool builds a `ConduitRequest`, prints its
 * facts, and asks the owners `[y/N]`. On `y` the local owner keys sign the
 * ERC-3009 authorization (`approveWithQuorum`) and the agent submits it through
 * its session key (`submitApproved`). On anything else nothing is signed.
 *
 * The agent never signs on the owners' behalf: the owner signers are created
 * from keys that live in env/state and are passed here, never to the model.
 */
import type { Address } from 'viem'
import { GATE_LABEL, REJECTED_LINE, renderFacts, renderReceipt } from './facts.js'
import type { ConduitReceipt, ConduitRequest, KitEnv, OwnerSigner, Quorum, TreasuryKit } from './kit-contract.js'

/** Whether an answer at the gate is an approval. Only an explicit yes is; the default is No. */
export function parseApproval(answer: string): 'approve' | 'reject' {
  const a = answer.trim().toLowerCase()
  return a === 'y' || a === 'yes' ? 'approve' : 'reject'
}

/** The exact question the gate asks. */
export function gatePrompt(): string {
  return `${GATE_LABEL} [y/N] `
}

/** How the gate reaches the human and the terminal. */
export interface GateIo {
  ask(question: string): Promise<string>
  print(text: string): void
}

/** Who signs and who submits for a given chain. */
export interface GateSigners {
  owners: readonly OwnerSigner[]
  agent: { address: Address; sessionKey: OwnerSigner }
}

/** Outcome of running a request through the gate. */
export type GateOutcome =
  | { status: 'rejected'; text: string }
  | { status: 'executed'; receipt: ConduitReceipt; text: string }

/**
 * Print the facts, ask, and act on the answer. Signing and submitting happen
 * only after an explicit `y`.
 */
export async function runGate(input: {
  kit: TreasuryKit
  env: KitEnv
  request: ConduitRequest
  signers: GateSigners
  io: GateIo
}): Promise<GateOutcome> {
  const { kit, env, request, signers, io } = input
  io.print(`\n${renderFacts(request)}\n`)
  const answer = await io.ask(gatePrompt())
  if (parseApproval(answer) === 'reject') {
    io.print(REJECTED_LINE)
    return { status: 'rejected', text: REJECTED_LINE }
  }
  const quorum: Quorum = { treasury: request.intent.beneficiary, chain: request.chain, owners: signers.owners }
  io.print(`owners signing (${signers.owners.map((o) => o.address).join(', ')}) …`)
  const approved = await kit.approveWithQuorum(request, quorum, env)
  io.print(`agent ${signers.agent.address} submitting through its session key ${signers.agent.sessionKey.address} …`)
  const receipt = await kit.submitApproved(
    approved,
    { kind: 'agent', agent: signers.agent.address, sessionKey: signers.agent.sessionKey },
    env,
  )
  const text = renderReceipt(receipt, request)
  io.print(text)
  return { status: 'executed', receipt, text }
}
