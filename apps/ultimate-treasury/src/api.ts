// SPDX-License-Identifier: Apache-2.0
/**
 * Browser side of the signer boundary. In a production build `import.meta.env.DEV` is false, so SIGNER is null and the
 * signer routes are compiled out: the page reads public Gateway balances directly and shows "connect a signer".
 */
import { DEPLOYED_POLICY, type PositionId, fetchGatewayBalances } from '../shared/config'
import type { Job, SendRequest, TreasuryPolicy } from '../shared/types'

const SIGNER: string | null = import.meta.env.DEV ? '/api/ut' : null

export const signerCompiledIn = SIGNER !== null

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  if (!SIGNER) throw new Error('no signer in this build: connect a signer')
  const res = await fetch(`${SIGNER}${path}`, init)
  const body = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error(body.error ?? `${res.status}`)
  return body
}

export async function signerStatus(): Promise<{ signer: 'dev'; feePayer: string | null } | null> {
  if (!SIGNER) return null
  try {
    return await call('/status')
  } catch {
    return null
  }
}

export async function loadPolicy(): Promise<TreasuryPolicy> {
  if (!SIGNER) return { ...DEPLOYED_POLICY, live: false }
  return (await call<{ policy: TreasuryPolicy }>('/treasury')).policy
}

export async function loadBalances(): Promise<Record<PositionId, number>> {
  if (!SIGNER) return fetchGatewayBalances()
  return (await call<{ positions: Record<PositionId, number> }>('/balances')).positions
}

export function startSend(req: SendRequest): Promise<Job> {
  return call('/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req) })
}

export function pollJob(id: string): Promise<Job> {
  return call(`/jobs/${id}`)
}

export function resumeMint(id: string): Promise<Job> {
  return call(`/jobs/${id}/resume-mint`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
}
