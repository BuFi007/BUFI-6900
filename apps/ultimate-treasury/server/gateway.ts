// SPDX-License-Identifier: Apache-2.0
import { GATEWAY_API } from '../shared/config'

export interface TransferResponse {
  ok: boolean
  status: number
  text: string
}

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))

/** POST /v1/transfer for one signed burn intent. `contractSigner` = the source signer is an ERC-1271 contract. */
export async function postTransfer(burnIntent: unknown, signature: string, contractSigner: boolean): Promise<TransferResponse> {
  const entry = contractSigner ? { burnIntent, signature, contractSigner: true } : { burnIntent, signature }
  const res = await fetch(`${GATEWAY_API}/v1/transfer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json([entry]) })
  return { ok: res.ok, status: res.status, text: await res.text() }
}

/** Human message out of a Gateway error body, falling back to the raw text (the UI also shows the raw text). */
export function gatewayMessage(text: string): string {
  try {
    const j = JSON.parse(text) as { message?: string; error?: string }
    return j.message ?? j.error ?? text
  } catch {
    return text
  }
}
