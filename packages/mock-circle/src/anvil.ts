/*
 * @bufi/mock-circle — spawn / probe anvil.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import type { Subprocess } from 'bun'

import type { Logger } from './config.ts'

export interface AnvilOptions {
  host?: string
  port?: number
  chainId?: number
  codeSizeLimit?: number
  /** ETH per default account. */
  balance?: number
  binary?: string
  /** Extra CLI flags appended verbatim. */
  extraArgs?: string[]
  silent?: boolean
  log?: Logger
}

export interface AnvilHandle {
  rpcUrl: string
  host: string
  port: number
  proc: Subprocess
  stop(): Promise<void>
}

export const DEFAULT_ANVIL = {
  host: '127.0.0.1',
  port: 8545,
  chainId: 31337,
  codeSizeLimit: 250_000,
  balance: 1_000_000,
} as const

/** Same flags as the root `bun run anvil` script. */
export function anvilArgs(opts: AnvilOptions = {}): string[] {
  return [
    '--chain-id',
    String(opts.chainId ?? DEFAULT_ANVIL.chainId),
    '--code-size-limit',
    String(opts.codeSizeLimit ?? DEFAULT_ANVIL.codeSizeLimit),
    '--balance',
    String(opts.balance ?? DEFAULT_ANVIL.balance),
    '--host',
    opts.host ?? DEFAULT_ANVIL.host,
    '--port',
    String(opts.port ?? DEFAULT_ANVIL.port),
    ...(opts.silent ? ['--silent'] : []),
    ...(opts.extraArgs ?? []),
  ]
}

export async function isRpcListening(rpcUrl: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return false
    const json = (await response.json()) as { result?: unknown }
    return typeof json.result === 'string'
  } catch {
    return false
  }
}

export async function waitForRpc(rpcUrl: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isRpcListening(rpcUrl, 1000)) return
    await Bun.sleep(150)
  }
  throw new Error(`RPC at ${rpcUrl} did not come up within ${timeoutMs}ms`)
}

/** A port nothing is listening on right now (bind :0, read it back, release it). */
export async function getFreePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') })
  const port = probe.port
  await probe.stop(true)
  if (!port) throw new Error('could not allocate a free port')
  return port
}

export async function startAnvil(opts: AnvilOptions = {}): Promise<AnvilHandle> {
  const host = opts.host ?? DEFAULT_ANVIL.host
  const port = opts.port ?? DEFAULT_ANVIL.port
  const rpcUrl = `http://${host}:${port}`
  const log = opts.log ?? (() => {})
  const args = anvilArgs({ ...opts, host, port })
  log(`spawning anvil ${args.join(' ')}`)
  const proc = Bun.spawn([opts.binary ?? 'anvil', ...args], {
    stdout: opts.silent ? 'ignore' : 'inherit',
    stderr: 'inherit',
  })
  try {
    await waitForRpc(rpcUrl)
  } catch (error) {
    proc.kill()
    throw error
  }
  return {
    rpcUrl,
    host,
    port,
    proc,
    async stop() {
      if (proc.exitCode === null && !proc.killed) proc.kill()
      await proc.exited
    },
  }
}
