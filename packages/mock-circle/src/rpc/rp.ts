/*
 * @bufi/mock-circle — `rp_*` WebAuthn relying-party stubs.
 *
 * These are DETERMINISTIC STUBS, not a relying party: no attestation is parsed, no assertion signature is checked
 * and challenges are not tracked. Registration remembers the credential id (and the SPKI public key when the
 * browser's `PublicKeyCredential.toJSON()` includes `response.publicKey`); login hands that key back so
 * `toWebAuthnCredential({ mode: 'Login' })` can rebuild the owner. Shapes follow `types/rp.ts` of the SDK.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import type { RpcContext } from './context.ts'
import { invalidParams } from './errors.ts'
import type {
  CustomPublicKeyCredentialCreationOptions,
  CustomPublicKeyCredentialRequestOptions,
  StoredCredential,
} from './types.ts'

const base64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url')
const randomBase64url = (length: number) => base64url(crypto.getRandomValues(new Uint8Array(length)))

/** COSE algorithms Circle's relying party advertises (see the SDK's Rp.Mock fixture). */
const PUB_KEY_CRED_PARAMS = [-7, -35, -36, -257, -258, -259, -37, -38, -39, -8].map((alg) => ({
  type: 'public-key' as const,
  alg,
}))

interface SerializedCredential {
  id?: unknown
  rawId?: unknown
  type?: unknown
  response?: { publicKey?: unknown; clientDataJSON?: unknown; attestationObject?: unknown; signature?: unknown }
}

function parseCredential(raw: unknown): SerializedCredential & { id: string } {
  const credential = raw as SerializedCredential | undefined
  if (!credential || typeof credential !== 'object') throw invalidParams('credential must be a serialised PublicKeyCredential')
  const id = typeof credential.id === 'string' ? credential.id : typeof credential.rawId === 'string' ? credential.rawId : undefined
  if (!id) throw invalidParams('credential.id is required')
  return { ...credential, id }
}

/** rp_getRegistrationOptions — `[username]`. */
export function rpGetRegistrationOptions(ctx: RpcContext, params: unknown[]): CustomPublicKeyCredentialCreationOptions {
  const username = typeof params[0] === 'string' && params[0].length > 0 ? params[0] : 'bufi-sandbox-user'
  return {
    rp: { name: 'BUFI sandbox (mock Circle RP)', id: ctx.rpId },
    user: { id: randomBase64url(16), name: username, displayName: username },
    challenge: randomBase64url(32),
    pubKeyCredParams: PUB_KEY_CRED_PARAMS,
    timeout: 1_000_000,
    attestation: 'none',
    authenticatorSelection: { requireResidentKey: true, residentKey: 'required', userVerification: 'required' },
  }
}

/** rp_getRegistrationVerification — `[credential]`; always verifies, records the credential. */
export function rpGetRegistrationVerification(ctx: RpcContext, params: unknown[]): { verified: boolean } {
  const credential = parseCredential(params[0])
  const publicKey = typeof credential.response?.publicKey === 'string' ? credential.response.publicKey : undefined
  const record: StoredCredential = {
    id: credential.id,
    ...(publicKey ? { publicKey } : {}),
    registeredAt: new Date().toISOString(),
  }
  ctx.state.credentials.set(credential.id, record)
  ctx.log(`rp_getRegistrationVerification: recorded credential ${credential.id}${publicKey ? '' : ' (no response.publicKey in payload)'}`)
  return { verified: true }
}

/** rp_getLoginOptions — `[credentialId]` (the SDK passes the credential id as "userId"; empty → discoverable). */
export function rpGetLoginOptions(ctx: RpcContext, params: unknown[]): CustomPublicKeyCredentialRequestOptions {
  const credentialId = typeof params[0] === 'string' && params[0].length > 0 ? params[0] : undefined
  return {
    challenge: randomBase64url(32),
    rpId: ctx.rpId,
    timeout: 1_000_000,
    userVerification: 'required',
    ...(credentialId ? { allowCredentials: [{ id: credentialId, type: 'public-key' }] } : {}),
  }
}

/** rp_getLoginVerification — `[credential]`; returns the public key recorded at registration. */
export function rpGetLoginVerification(ctx: RpcContext, params: unknown[]): { publicKey: string } {
  const credential = parseCredential(params[0])
  const record = ctx.state.credentials.get(credential.id)
  if (!record) {
    throw invalidParams(`unknown credential ${credential.id} — register it through rp_getRegistrationVerification on this mock first`)
  }
  if (!record.publicKey) {
    throw invalidParams(
      `credential ${credential.id} was registered without response.publicKey, so the mock has no key to return; ` +
        'register from a browser whose PublicKeyCredential.toJSON() includes response.publicKey',
    )
  }
  return { publicKey: record.publicKey }
}
