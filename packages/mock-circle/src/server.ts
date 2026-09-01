/*
 * @bufi/mock-circle — the HTTP endpoint (`POST /v1/rpc/w3s/buidl`, JSON-RPC 2.0, Bearer auth).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import type { Server } from 'bun'
import type { Hex } from 'viem'

import { consoleLogger, envConfig, RPC_PATH, type Logger } from './config.ts'
import { formatDeploymentSummary, readDeployment, type LocalDeployment } from './deployments.ts'
import { createRpcContext, type RpcContext } from './rpc/context.ts'
import { RPC_ERROR } from './rpc/errors.ts'
import { handleRpcRequest, SUPPORTED_METHODS, type JsonRpcResponse } from './rpc/router.ts'

export { RPC_PATH }

export interface MockCircleServerOptions {
  port?: number
  hostname?: string
  /** anvil JSON-RPC URL; defaults to `ANVIL_RPC_URL` / the deployment's rpcUrl. */
  anvilRpcUrl?: string
  /** In-memory deployment; when absent it is read from `deploymentsPath`. */
  deployment?: LocalDeployment
  deploymentsPath?: string
  bundlerKey?: Hex
  paymasterSignerKey?: Hex
  rpId?: string
  paymasterValiditySecs?: number
  log?: Logger
}

export interface MockCircleServer {
  server: Server<undefined>
  hostname: string
  port: number
  /** `http://host:port` */
  url: string
  /** `http://host:port/v1/rpc/w3s/buidl` — what `toModularTransport(clientUrl, clientKey)` takes. */
  rpcUrl: string
  deployment: LocalDeployment
  context: RpcContext
  stop(): Promise<void>
}

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, x-appinfo',
  'access-control-max-age': '86400',
}

/** bigints anywhere in a result become 0x quantities. */
const jsonBody = (value: unknown) =>
  JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? `0x${v.toString(16)}` : v))

const json = (value: unknown, status = 200) =>
  new Response(jsonBody(value), { status, headers: { 'content-type': 'application/json', ...CORS_HEADERS } })

const rpcErrorResponse = (id: string | number | null, code: number, message: string, status = 200) =>
  json({ jsonrpc: '2.0', id, error: { code, message } } satisfies JsonRpcResponse, status)

export async function createMockCircleServer(options: MockCircleServerOptions = {}): Promise<MockCircleServer> {
  const cfg = envConfig()
  const log = options.log ?? consoleLogger
  const deployment = options.deployment ?? (await readDeployment(options.deploymentsPath ?? cfg.deploymentsPath))
  const anvilRpcUrl = options.anvilRpcUrl ?? process.env.ANVIL_RPC_URL ?? deployment.rpcUrl
  const context = await createRpcContext({
    rpcUrl: anvilRpcUrl,
    deployment,
    bundlerKey: options.bundlerKey,
    paymasterSignerKey: options.paymasterSignerKey,
    rpId: options.rpId ?? cfg.rpId,
    paymasterValiditySecs: options.paymasterValiditySecs ?? cfg.paymasterValiditySecs,
    log,
  })
  const hostname = options.hostname ?? cfg.hostname

  const server = Bun.serve({
    hostname,
    port: options.port ?? cfg.port,
    async fetch(request) {
      const url = new URL(request.url)
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS })
      if (request.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
        return json({
          ok: true,
          service: '@bufi/mock-circle',
          rpcPath: RPC_PATH,
          chainId: deployment.chainId,
          anvilRpcUrl,
          entryPoint: deployment.entryPoint,
          factory: deployment.upgradableMscaFactory,
          paymaster: deployment.paymaster?.address ?? null,
          methods: SUPPORTED_METHODS,
        })
      }
      if (url.pathname !== RPC_PATH) return json({ error: `not found — the RPC endpoint is POST ${RPC_PATH}` }, 404)
      if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405)

      const authorization = request.headers.get('authorization') ?? ''
      if (!/^Bearer\s+\S+/i.test(authorization)) {
        return rpcErrorResponse(null, RPC_ERROR.UNAUTHORIZED, 'Unauthorized: send `Authorization: Bearer <client key>`', 401)
      }

      let body: unknown
      try {
        body = await request.json()
      } catch {
        return rpcErrorResponse(null, RPC_ERROR.PARSE, 'Parse error: body is not JSON')
      }
      if (Array.isArray(body)) {
        if (body.length === 0) return rpcErrorResponse(null, RPC_ERROR.INVALID_REQUEST, 'Invalid Request: empty batch')
        return json(await Promise.all(body.map((entry) => handleRpcRequest(context, entry))))
      }
      return json(await handleRpcRequest(context, body))
    },
    error(error) {
      log(`unhandled server error: ${error.message}`)
      return rpcErrorResponse(null, RPC_ERROR.INTERNAL, error.message, 500)
    },
  })

  const port = server.port ?? options.port ?? cfg.port
  const url = `http://${hostname}:${port}`
  log(`mock Circle Modular Wallets API listening on ${url}${RPC_PATH} (anvil ${anvilRpcUrl}, chainId ${deployment.chainId})`)
  return {
    server,
    hostname,
    port,
    url,
    rpcUrl: `${url}${RPC_PATH}`,
    deployment,
    context,
    async stop() {
      await server.stop(true)
    },
  }
}

if (import.meta.main) {
  const cfg = envConfig()
  const mock = await createMockCircleServer({ port: cfg.port, hostname: cfg.hostname })
  console.log(`\nBUFI-6900 sandbox stack (from ${cfg.deploymentsPath})\n${formatDeploymentSummary(mock.deployment)}\n`)
  console.log(`  Modular Wallets API  ${mock.rpcUrl}`)
  console.log(`  clientKey            any non-empty string (e.g. "sandbox")\n`)
}
