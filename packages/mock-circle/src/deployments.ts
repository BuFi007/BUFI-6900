/*
 * @bufi/mock-circle — `contracts/deployments/local.json`, the shape `toStackDeployment` in the SDK fork parses.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { Address, Hex } from 'viem'

export interface PluginDeployment {
  address: Address
  manifestHash: Hex
}

export interface LocalDeployment {
  chainId: number
  rpcUrl: string
  entryPoint: Address
  create2Deployer: Address
  pluginManager: Address
  upgradableMscaFactory: Address
  upgradableMscaImpl: Address
  plugins: {
    weightedWebauthnMultisig: PluginDeployment
    coldStorageAddressBook: PluginDeployment
    bufiSessionKey: PluginDeployment | null
    bufiEarnModule: PluginDeployment | null
  }
  paymaster: { address: Address; signer: Address } | null
  tokens: { usdc: Address }
  accounts: { deployer: Address; bundler: Address; factoryOwner: Address }
}

export async function writeDeployment(filePath: string, deployment: LocalDeployment): Promise<void> {
  mkdirSync(path.dirname(filePath), { recursive: true })
  await Bun.write(filePath, `${JSON.stringify(deployment, null, 2)}\n`)
}

export async function readDeployment(filePath: string): Promise<LocalDeployment> {
  const file = Bun.file(filePath)
  if (!(await file.exists())) {
    throw new Error(`No deployment file at ${filePath} — run \`bun run --cwd packages/mock-circle deploy\` first`)
  }
  const json = (await file.json()) as Partial<LocalDeployment>
  for (const key of ['chainId', 'entryPoint', 'upgradableMscaFactory', 'plugins', 'tokens', 'accounts'] as const) {
    if (json[key] === undefined) throw new Error(`${filePath}: missing "${key}"`)
  }
  return json as LocalDeployment
}

/** Human summary printed by the CLIs. */
export function formatDeploymentSummary(d: LocalDeployment): string {
  const rows: Array<[string, string]> = [
    ['chainId', String(d.chainId)],
    ['rpcUrl', d.rpcUrl],
    ['EntryPoint v0.7', d.entryPoint],
    ['CREATE2 deployer', d.create2Deployer],
    ['PluginManager', d.pluginManager],
    ['UpgradableMSCAFactory', d.upgradableMscaFactory],
    ['UpgradableMSCA (impl)', d.upgradableMscaImpl],
    ['WeightedWebauthnMultisigPlugin', `${d.plugins.weightedWebauthnMultisig.address}  manifest ${d.plugins.weightedWebauthnMultisig.manifestHash}`],
    ['ColdStorageAddressBookPlugin', `${d.plugins.coldStorageAddressBook.address}  manifest ${d.plugins.coldStorageAddressBook.manifestHash}`],
    [
      'BufiSessionKeyPlugin',
      d.plugins.bufiSessionKey
        ? `${d.plugins.bufiSessionKey.address}  manifest ${d.plugins.bufiSessionKey.manifestHash}`
        : '(not built yet)',
    ],
    [
      'BufiEarnModule',
      d.plugins.bufiEarnModule
        ? `${d.plugins.bufiEarnModule.address}  manifest ${d.plugins.bufiEarnModule.manifestHash}`
        : '(not built yet)',
    ],
    ['SponsorPaymaster (proxy)', d.paymaster ? `${d.paymaster.address}  signer ${d.paymaster.signer}` : '(none)'],
    ['SandboxUSDC', d.tokens.usdc],
    ['deployer', d.accounts.deployer],
    ['bundler', d.accounts.bundler],
    ['factory owner (impersonated)', d.accounts.factoryOwner],
  ]
  const width = Math.max(...rows.map(([k]) => k.length))
  return rows.map(([k, v]) => `  ${k.padEnd(width)}  ${v}`).join('\n')
}
