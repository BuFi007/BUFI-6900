// SPDX-License-Identifier: Apache-2.0
/**
 * Regression tests for the 2026-10-05 review of the dev signer (UT-1, UT-2, UT-4, UT-5). Run: `bun test` from this
 * app. The Vite test boots the real dev server on a random port; nothing here signs or submits anything.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { IncomingMessage } from 'node:http'
import { fileURLToPath } from 'node:url'

import { type ViteDevServer, createServer } from 'vite'

import type { SendRequest, TreasuryPolicy } from '../shared/types'
import { localOnly } from './plugin'
import { assertNoPendingMint, clearPendingMint, mintedAmountFromLogs, recordPendingMint, validateSend } from './send'

const APP = fileURLToPath(new URL('..', import.meta.url))
const REPO = fileURLToPath(new URL('../../../', import.meta.url))

// ── UT-1: the dev server must not serve the sandbox key directory ───────────────────────────────
describe('UT-1 dev server file exposure', () => {
  let server: ViteDevServer
  let base: string
  beforeAll(async () => {
    server = await createServer({ root: APP, configFile: `${APP}vite.config.ts`, server: { port: 0, host: '127.0.0.1' }, logLevel: 'silent' })
    await server.listen()
    const addr = server.httpServer?.address()
    if (!addr || typeof addr === 'string') throw new Error('no address')
    base = `http://127.0.0.1:${addr.port}`
  })
  afterAll(async () => {
    await server?.close()
  })

  for (const rel of ['.sandbox/ultimate-treasury/keys.json', '.sandbox/ultimate-treasury/frost/share-1.json', '.sandbox/ultimate-treasury/solana-owners.json']) {
    for (const q of ['', '?raw', '?import']) {
      test(`/@fs/${rel}${q} is refused`, async () => {
        const res = await fetch(`${base}/@fs/${REPO}${rel}${q}`)
        const body = await res.text()
        expect(res.status).toBe(403)
        expect(body).not.toContain('privateKey')
        expect(body).not.toContain('signing_share')
      })
    }
  }

  test('the app itself still serves', async () => {
    const res = await fetch(`${base}/`)
    expect(res.status).toBe(200)
  })

  test('OPTIONS on the signer is refused (no CORS preflight answer)', async () => {
    const res = await fetch(`${base}/api/ut/send`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:3000', 'Access-Control-Request-Method': 'POST' } })
    expect(res.status).toBe(403)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })
})

// ── UT-4: the signer gates on the socket and the full origin, not on spoofable headers ──────────
describe('UT-4 localOnly', () => {
  const req = (remoteAddress: string, headers: Record<string, string>, localPort = 5180) =>
    ({ socket: { remoteAddress, localPort }, headers }) as unknown as IncomingMessage

  test('a LAN peer spoofing Host: localhost is refused', () => {
    expect(localOnly(req('192.168.1.23', { host: 'localhost' }))).toBe(false)
    expect(localOnly(req('::ffff:10.0.0.4', { host: '127.0.0.1:5180' }))).toBe(false)
  })
  test('loopback without Origin is allowed', () => {
    expect(localOnly(req('127.0.0.1', { host: '127.0.0.1:5180' }))).toBe(true)
    expect(localOnly(req('::1', { host: 'localhost:5180' }))).toBe(true)
    expect(localOnly(req('::ffff:127.0.0.1', { host: 'localhost:5180' }))).toBe(true)
  })
  test('a page on another localhost port is refused', () => {
    expect(localOnly(req('127.0.0.1', { host: 'localhost:5180', origin: 'http://localhost:3000' }))).toBe(false)
    expect(localOnly(req('127.0.0.1', { host: 'localhost:5180', origin: 'https://localhost:5180' }))).toBe(false)
  })
  test('the dev page itself is allowed', () => {
    expect(localOnly(req('127.0.0.1', { host: 'localhost:5180', origin: 'http://localhost:5180' }))).toBe(true)
    expect(localOnly(req('127.0.0.1', { host: '127.0.0.1:5180', origin: 'http://127.0.0.1:5180' }))).toBe(true)
  })
  test('DNS rebinding (foreign Host) is still refused', () => {
    expect(localOnly(req('127.0.0.1', { host: 'evil.example:5180' }))).toBe(false)
  })
})

// ── UT-2: caps and balance are unconditional; Solana refuses when FROST and on-chain weights disagree ─
describe('UT-2 send validation', () => {
  const pol: TreasuryPolicy = {
    live: true,
    thresholdWeight: 3,
    owners: [
      { id: 'A', address: '0xa', weight: 2 },
      { id: 'B', address: '0xb', weight: 1 },
      { id: 'C', address: '0xc', weight: 1 },
    ],
    allowlist: [],
    outsider: { id: 'S', address: '0xs' },
    destinationDomains: [6],
    perIntentCap: 2,
    maxFeeCap: 2.01,
    maxExpiryBlocks: 1_250_000,
  }
  const frost = { threshold: 3, shares: { A: [1, 2], B: [3], C: [4] } }
  const balances = { evm: 10, solana: 10 }
  const base: SendRequest = { asset: 'USDC', amount: '0.25', recipient: '0x0000000000000000000000000000000000000001', signers: ['A', 'B'], source: 'solana' }
  const v = (req: Partial<SendRequest>, over: { pol?: TreasuryPolicy; allowlisted?: boolean; balances?: typeof balances } = {}) =>
    validateSend({ req: { ...base, ...req }, pol: over.pol ?? pol, allowlisted: over.allowlisted ?? true, balances: over.balances ?? balances, frostOwners: frost })

  test('a refusal request cannot lift the sandbox cap', () => {
    expect(() => v({ expectRefusal: true, amount: '1000', signers: ['B', 'C'] })).toThrow(/caps a single send/)
    expect(() => v({ expectRefusal: true, amount: '1000', recipient: '0x0000000000000000000000000000000000000002' }, { allowlisted: false })).toThrow(
      /caps a single send/,
    )
  })
  test('a refusal request cannot skip the balance check', () => {
    expect(() => v({ expectRefusal: true, signers: ['B', 'C'] }, { balances: { evm: 0, solana: 0 } })).toThrow(/holds 0 USDC/)
  })
  test('Solana leg refuses when on-chain weights drifted from the FROST share map', () => {
    const drifted = { ...pol, thresholdWeight: 4 }
    // On-chain says A+B (3) < 4 so it "would refuse", but FROST A+B still holds 3 of 3 shares and WOULD sign.
    expect(() => v({ expectRefusal: true, signers: ['A', 'B'] }, { pol: drifted })).toThrow(/FROST share map/)
    const demoted = { ...pol, owners: pol.owners.map((o) => (o.id === 'A' ? { ...o, weight: 1 } : o)) }
    expect(() => v({ signers: ['A', 'C'] }, { pol: demoted })).toThrow(/FROST share map/)
  })
  test('a consistent request still validates', () => {
    expect(v({}).source).toBe('solana')
    expect(v({ expectRefusal: true, signers: ['B', 'C'] }).source).toBe('solana')
  })
})

// ── UT-5: an attestation is never thrown away, and a successful receipt is never an error ───────
describe('UT-5 mint bookkeeping', () => {
  test('a second send to the same recipient + amount is blocked while an attestation is unminted', () => {
    recordPendingMint('job1', { recipient: '0x00000000000000000000000000000000000000AA', value: 1_000_000n })
    expect(() => assertNoPendingMint('0x00000000000000000000000000000000000000aa', 1_000_000n)).toThrow(/unminted attestation/)
    expect(() => assertNoPendingMint('0x00000000000000000000000000000000000000aa', 2_000_000n)).not.toThrow()
    clearPendingMint('job1')
    expect(() => assertNoPendingMint('0x00000000000000000000000000000000000000aa', 1_000_000n)).not.toThrow()
  })
  test('minted amount is read from the receipt Transfer log, not a lagging balanceOf', () => {
    const token = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
    const recipient = '0xF7D0520C36717e25c5b77F977A89741d2974589C'
    const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
    const pad = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, '0')}`
    const logs = [
      { address: token, topics: [TRANSFER, pad('0x0000000000000000000000000000000000000000'), pad(recipient)], data: `0x${(1_000_000n).toString(16).padStart(64, '0')}` },
      { address: '0x0000000000000000000000000000000000000bad', topics: [TRANSFER, pad('0x0000000000000000000000000000000000000000'), pad(recipient)], data: `0x${(5n).toString(16).padStart(64, '0')}` },
    ]
    expect(mintedAmountFromLogs(logs as never, token, recipient)).toBe(1_000_000n)
    expect(mintedAmountFromLogs([] as never, token, recipient)).toBe(0n)
  })
})
