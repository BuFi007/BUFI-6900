/**
 * Rendering of what a human reads before approving, and of what happened after.
 * Pure functions over the kit's `ConduitRequest` / `ConduitReceipt`.
 */
import { formatUnits } from 'viem'
import type { ConduitReceipt, ConduitRequest } from './kit-contract.js'

/** The prompt label of the approval gate. Every money move shows exactly this. */
export const GATE_LABEL = 'Quorum approval — owners sign the ERC-3009 authorization'

const KIND_TITLES: Record<ConduitRequest['facts']['kind'], string> = {
  swap: 'Swap',
  'earn-deposit': 'Earn deposit',
  'earn-withdraw': 'Earn withdrawal',
  custom: 'Custom protocol call',
}

/** Format an atomic amount with the demo's stablecoin decimals. */
export function formatAmount(atomic: bigint, decimals = 6): string {
  return formatUnits(atomic, decimals)
}

/** The block the terminal prints above the gate: a title, then the kit's `facts.lines`. */
export function renderFacts(request: ConduitRequest): string {
  const f = request.facts
  const head = `${KIND_TITLES[f.kind]} on ${f.chain} — treasury ${f.treasury}`
  const summary = `Spend ${f.spend.amount} ${f.spend.symbol} → receive at least ${f.receive.minimum} ${f.receive.symbol} (deadline ${f.deadline})`
  const lines = f.lines.map((line) => `  • ${line}`)
  return [head, summary, ...lines].join('\n')
}

/** What the model and the human see after a submit: chain, tx hash, what the treasury gained. */
export function renderReceipt(receipt: ConduitReceipt, request: ConduitRequest): string {
  return [
    `Executed on ${receipt.chain}`,
    `tx ${receipt.txHash}`,
    `treasury gained ${formatAmount(receipt.gained)} ${request.facts.receive.symbol} (${receipt.tokenOut})`,
  ].join('\n')
}

/** The line returned to the model when the owners decline. Nothing was signed. */
export const REJECTED_LINE = 'The owners did not approve. Nothing was signed and nothing moved.'
