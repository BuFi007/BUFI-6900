// SPDX-License-Identifier: Apache-2.0
/**
 * Solana leg: the Squads vault's Gateway delegate is a FROST Ed25519 group key. Owners sign with their shares
 * (tools/frost-delegate); Gateway verifies one ordinary Ed25519 signature over Circle's binary burn-intent layout,
 * prefixed with a 16-byte 0xff00… domain. Encoder lifted from packages/weighted-treasury/scripts/gateway-solana-delegate.ts,
 * without web3.js (only base58 → bytes is needed here).
 */
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'

import { DOMAIN, SOLANA_VAULT } from '../shared/config'
import { ARC_USDC, GATEWAY_MINTER, MAX_FEE } from './evm'
import { FROST_BIN, FROST_DIR, readFrostGroupKeyHex } from './secrets'

export const SOLANA_RPC = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com'
const GW_WALLET = 'GATEwdfmYNELfp5wDmmR6noSr2vHnAfBPMm2PvCzX5vu'
const SOL_USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
const TRANSFER_SPEC_MAGIC = 0xca85def7
const BURN_INTENT_MAGIC = 0x070afbc2
/** Gateway's floor on Solana devnet (3,024,000 slots, measured 2026-10-05) + margin. */
export const SOLANA_EXPIRY_SLOTS = 3_024_000n + 10_000n
export const SIGNING_DOMAIN = Buffer.from([0xff, ...new Array(15).fill(0)])

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
/** Base58 → 32-byte public key. */
export function base58ToBytes32(s: string): Buffer {
  let n = 0n
  for (const c of s) {
    const i = B58.indexOf(c)
    if (i < 0) throw new Error(`bad base58: ${s}`)
    n = n * 58n + BigInt(i)
  }
  const hex = n.toString(16).padStart(64, '0')
  if (hex.length !== 64) throw new Error(`not a 32-byte key: ${s}`)
  return Buffer.from(hex, 'hex')
}
export function bytesToBase58(b: Buffer): string {
  let n = BigInt(`0x${b.toString('hex') || '0'}`)
  let out = ''
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out
    n /= 58n
  }
  for (const byte of b) {
    if (byte !== 0) break
    out = `1${out}`
  }
  return out
}

const keyHex32 = (b58: string) => `0x${base58ToBytes32(b58).toString('hex')}`
const evmHex32 = (a: string) => `0x${a.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`
const u256be = (v: bigint) => {
  const b = Buffer.alloc(32)
  b.writeBigUInt64BE(v & 0xffffffffffffffffn, 24)
  b.writeBigUInt64BE((v >> 64n) & 0xffffffffffffffffn, 16)
  b.writeBigUInt64BE((v >> 128n) & 0xffffffffffffffffn, 8)
  b.writeBigUInt64BE((v >> 192n) & 0xffffffffffffffffn, 0)
  return b
}
const u32be = (v: number) => {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(v)
  return b
}
const h = (hex: string) => Buffer.from(hex.replace(/^0x/, ''), 'hex')

export function delegateBase58(): string {
  return bytesToBase58(h(readFrostGroupKeyHex()))
}

export function makeSolanaIntent(p: { recipient: string; value: bigint; maxBlockHeight: bigint }) {
  return {
    maxBlockHeight: p.maxBlockHeight,
    maxFee: MAX_FEE,
    spec: {
      version: 1,
      sourceDomain: DOMAIN.solana,
      destinationDomain: DOMAIN.arc,
      sourceContract: keyHex32(GW_WALLET),
      destinationContract: evmHex32(GATEWAY_MINTER),
      sourceToken: keyHex32(SOL_USDC),
      destinationToken: evmHex32(ARC_USDC),
      sourceDepositor: keyHex32(SOLANA_VAULT),
      destinationRecipient: evmHex32(p.recipient),
      sourceSigner: `0x${readFrostGroupKeyHex().replace(/^0x/, '')}`,
      destinationCaller: `0x${'00'.repeat(32)}`,
      value: p.value,
      salt: `0x${randomBytes(32).toString('hex')}`,
      hookData: '0x',
    },
  }
}
export type SolanaIntent = ReturnType<typeof makeSolanaIntent>

/** Circle's Solana burn-intent binary layout (big-endian). */
export function encodeSolanaIntent(bi: SolanaIntent): Buffer {
  const hook = h(bi.spec.hookData)
  const s = bi.spec
  const spec = Buffer.concat([
    u32be(TRANSFER_SPEC_MAGIC), u32be(s.version), u32be(s.sourceDomain), u32be(s.destinationDomain),
    h(s.sourceContract), h(s.destinationContract), h(s.sourceToken), h(s.destinationToken),
    h(s.sourceDepositor), h(s.destinationRecipient), h(s.sourceSigner), h(s.destinationCaller),
    u256be(s.value), h(s.salt), u32be(hook.length), hook,
  ])
  if (spec.length !== 340 + hook.length) throw new Error(`transfer spec is ${spec.length} bytes, expected ${340 + hook.length}`)
  return Buffer.concat([u32be(BURN_INTENT_MAGIC), u256be(bi.maxBlockHeight), u256be(bi.maxFee), u32be(spec.length), spec])
}

export type FrostResult =
  | { ok: true; signature: string }
  /** The listed owners hold fewer than the threshold of shares: no signature can exist. */
  | { ok: false; reason: 'below-threshold'; detail: string }
  /** The coordinator decoded the intent and its policy (policy.json) refused it before any share signed. */
  | { ok: false; reason: 'policy'; detail: string }

/**
 * FROST-sign the domain-prefixed intent with the given owners' shares. frost-delegate is also the policy coordinator:
 * it decodes the burn intent and checks it against `<frost dir>/policy.json` (recipient per domain, caps, expiry
 * against `currentSlot`, depositor, minter) before any share signs.
 */
export function frostSign(signers: string[], intent: SolanaIntent, currentSlot: bigint): Promise<FrostResult> {
  const message = Buffer.concat([SIGNING_DOMAIN, encodeSolanaIntent(intent)])
  const args = ['sign', '--dir', FROST_DIR, '--signers', signers.join(','), '--current-slot', currentSlot.toString(), '--message-hex', message.toString('hex')]
  return new Promise((resolve, reject) => {
    execFile(FROST_BIN, args, { timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) {
        const text = String(stderr).trim()
        const code = (err as { code?: number }).code
        if (code === 2 || text.includes('below threshold')) return resolve({ ok: false, reason: 'below-threshold', detail: text })
        if (code === 3) {
          let detail = text
          try {
            detail = (JSON.parse(text.split('\n')[0] ?? '') as { reason?: string }).reason ?? text
          } catch {}
          return resolve({ ok: false, reason: 'policy', detail })
        }
        return reject(new Error(`frost-delegate failed: ${text || err.message}`))
      }
      resolve({ ok: true, signature: (JSON.parse(String(stdout)) as { signature: string }).signature })
    })
  })
}

export async function solanaSlot(): Promise<bigint> {
  const res = await fetch(SOLANA_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot', params: [{ commitment: 'confirmed' }] }),
  })
  const j = (await res.json()) as { result?: number; error?: unknown }
  if (typeof j.result !== 'number') throw new Error(`getSlot failed: ${JSON.stringify(j.error)}`)
  return BigInt(j.result)
}
