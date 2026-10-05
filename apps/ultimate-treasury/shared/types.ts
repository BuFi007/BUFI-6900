// SPDX-License-Identifier: Apache-2.0
import type { PositionId } from './config'

export interface Owner {
  id: string
  address: string
  weight: number
}

export interface TreasuryPolicy {
  live: boolean
  thresholdWeight: number
  owners: Owner[]
  allowlist: { id: string; address: string }[]
  outsider: { id: string; address: string }
  destinationDomains: number[]
  perIntentCap: number
  maxFeeCap: number
  maxExpiryBlocks: number
}

export interface SendRequest {
  asset: 'USDC'
  amount: string
  recipient: string
  signers: string[]
  source: 'auto' | PositionId
  /** Refusal demo: the signer refuses to run a request that would actually succeed (it must never spend). */
  expectRefusal?: boolean
}

export type StepState = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export interface Step {
  key: 'approvals' | 'attestation' | 'mint'
  label: string
  state: StepState
  detail?: string
  txHash?: string
  link?: string
}

export interface Job {
  id: string
  request: SendRequest
  source: PositionId
  destinationChain: string
  status: 'running' | 'minted' | 'refused' | 'error'
  steps: Step[]
  /** Gateway's (or the coordinator's) refusal text, verbatim. */
  refusal?: string
  error?: string
  /** Gateway issued an attestation but the mint did not complete: resume it (same attestation), never send again. */
  resumable?: boolean
  recipientBalance?: { before: string; after: string }
}
