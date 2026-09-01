/*
 * @bufi/mock-circle — `bun run --cwd packages/mock-circle dev`: anvil (unless one is listening) → deploy → serve.
 *
 * Flags: --no-anvil (never spawn; fail if nothing listens), --port <n> (mock API port), --rpc-url <url> (anvil).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import { isRpcListening, startAnvil, type AnvilHandle } from '../anvil.ts'
import { consoleLogger, envConfig, RPC_PATH } from '../config.ts'
import { deployStack } from '../deploy.ts'
import { formatDeploymentSummary } from '../deployments.ts'
import { createMockCircleServer } from '../server.ts'

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

const cfg = envConfig()
const anvilRpcUrl = flag('--rpc-url') ?? cfg.anvilRpcUrl
const port = Number(flag('--port') ?? cfg.port)
const noAnvil = process.argv.includes('--no-anvil')
const log = consoleLogger

let anvil: AnvilHandle | undefined
if (await isRpcListening(anvilRpcUrl)) {
  log(`anvil already listening at ${anvilRpcUrl} — reusing it`)
} else if (noAnvil) {
  console.error(`[mock-circle] nothing listens at ${anvilRpcUrl} and --no-anvil was given`)
  process.exit(1)
} else {
  const url = new URL(anvilRpcUrl)
  anvil = await startAnvil({ host: url.hostname, port: Number(url.port || 8545), log })
  log(`anvil up at ${anvil.rpcUrl} (pid ${anvil.proc.pid})`)
}

const deployment = await deployStack({ rpcUrl: anvilRpcUrl, deploymentsPath: cfg.deploymentsPath, log })
const mock = await createMockCircleServer({ port, hostname: cfg.hostname, anvilRpcUrl, deployment, log })

console.log(`
BUFI-6900 sandbox — Circle stack at Circle's addresses on anvil
${formatDeploymentSummary(deployment)}

  deployment file      ${cfg.deploymentsPath}
  anvil                ${anvilRpcUrl}
  Modular Wallets API  ${mock.rpcUrl}
  clientKey            any non-empty string

  SDK:   toModularTransport('${mock.url}${RPC_PATH}', 'sandbox')
  curl:  curl -s ${mock.rpcUrl} -H 'Authorization: Bearer sandbox' -H 'content-type: application/json' \\
           -d '{"jsonrpc":"2.0","id":1,"method":"eth_supportedEntryPoints","params":[]}'
`)

const shutdown = async () => {
  log('shutting down')
  await mock.stop()
  if (anvil) await anvil.stop()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
