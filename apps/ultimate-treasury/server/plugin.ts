// SPDX-License-Identifier: Apache-2.0
/**
 * Dev-only signer. `apply: 'serve'` keeps this plugin out of `vite build` entirely, and nothing under server/ is
 * imported by the browser code, so the production bundle has no keys and no /api/ut endpoints: it fails closed
 * and the page says "connect a signer".
 *
 * Routes (JSON):
 *   GET  /api/ut/status      signer mode + fee payer address
 *   GET  /api/ut/treasury    live policy read from the GatewayTreasury contract
 *   GET  /api/ut/balances    live Gateway balances of both positions
 *   POST /api/ut/send        start a send; returns the job
 *   GET  /api/ut/jobs/:id    poll a job's steps
 *   POST /api/ut/jobs/:id/resume-mint   re-submit a saved attestation's mint (never a new intent)
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

import { privateKeyToAccount } from 'viem/accounts'
import type { Plugin } from 'vite'

import { POSITIONS, SOLANA_SMART_ACCOUNT, fetchGatewayBalances } from '../shared/config'
import type { SendRequest } from '../shared/types'
import { readFeePayerKey } from './secrets'
import { RequestError, getJob, policy, resumeMint, startSend } from './send'
import { delegateBase58 } from './solana'

const PREFIX = '/api/ut/'

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > 16_384) throw new RequestError(413, 'body too large')
    chunks.push(c as Buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new RequestError(400, 'body must be JSON')
  }
}

const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]']

/**
 * Only same-machine pages may drive the signer. Gated on the SOCKET (a client controls the Host and Origin headers,
 * so `vite --host` would otherwise let any LAN peer send `Host: localhost`), then on the Host header (DNS rebinding),
 * then on the FULL Origin, port included: a page on another localhost port (another dev server) is not this page.
 */
export function localOnly(req: IncomingMessage): boolean {
  if (!LOOPBACK_PEERS.has(req.socket?.remoteAddress ?? '')) return false
  const host = (req.headers.host ?? '').replace(/:\d+$/, '')
  if (!LOCAL_HOSTS.includes(host)) return false
  const origin = req.headers.origin
  if (!origin) return true
  const port = req.socket.localPort
  return LOCAL_HOSTS.some((h) => origin === `http://${h}:${port}`)
}

async function route(req: IncomingMessage, res: ServerResponse) {
  const path = (req.url ?? '').split('?')[0]!.slice(PREFIX.length)
  if (req.method === 'GET' && path === 'status') {
    let feePayer: string | null = null
    try {
      feePayer = privateKeyToAccount(readFeePayerKey()).address
    } catch {
      feePayer = null
    }
    return send(res, 200, { signer: 'dev', feePayer })
  }
  if (req.method === 'GET' && path === 'treasury') {
    return send(res, 200, { policy: await policy(), positions: POSITIONS, solana: { smartAccount: SOLANA_SMART_ACCOUNT, delegate: delegateBase58() } })
  }
  if (req.method === 'GET' && path === 'balances') {
    const b = await fetchGatewayBalances()
    return send(res, 200, { token: 'USDC', positions: b, total: Math.round((b.evm + b.solana) * 1e6) / 1e6 })
  }
  if (req.method === 'POST' && path === 'send') {
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new RequestError(415, 'Content-Type must be application/json')
    const job = await startSend((await readJson(req)) as SendRequest)
    return send(res, 202, job)
  }
  const r = /^jobs\/([0-9a-f]{16})\/resume-mint$/.exec(path)
  if (req.method === 'POST' && r) {
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new RequestError(415, 'Content-Type must be application/json')
    return send(res, 202, resumeMint(r[1]!))
  }
  const m = /^jobs\/([0-9a-f]{16})$/.exec(path)
  if (req.method === 'GET' && m) {
    const job = getJob(m[1]!)
    return job ? send(res, 200, job) : send(res, 404, { error: 'no such job' })
  }
  return send(res, 404, { error: 'not found' })
}

export function devSigner(): Plugin {
  return {
    name: 'ultimate-treasury-dev-signer',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith(PREFIX)) return next()
        // No CORS, ever: answer every preflight with a plain 403 and no Access-Control-* headers.
        if (req.method === 'OPTIONS') return send(res, 403, { error: 'no cross-origin access to the dev signer' })
        if (!localOnly(req)) return send(res, 403, { error: 'the dev signer only answers local pages' })
        route(req, res).catch((err: unknown) => {
          if (err instanceof RequestError) return send(res, err.status, { error: err.message })
          const msg = (err as Error).message ?? String(err)
          console.error(`[ut] ${req.method} ${req.url}: ${msg.slice(0, 300)}`)
          send(res, 500, { error: msg.slice(0, 600) })
        })
      })
    },
  }
}
