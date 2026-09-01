/*
 * @bufi/mock-circle — forge / Circle build-output artifact loading.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import type { Abi, Hex } from 'viem'

import type { Logger } from './config.ts'

let cachedRoot: string | undefined

/** Repo root = the directory holding `contracts/foundry.toml`. Override with `BUFI_6900_ROOT`. */
export function repoRoot(): string {
  if (cachedRoot) return cachedRoot
  const fromEnv = process.env.BUFI_6900_ROOT
  if (fromEnv) {
    cachedRoot = path.resolve(fromEnv)
    return cachedRoot
  }
  let dir = import.meta.dir
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, 'contracts', 'foundry.toml'))) {
      cachedRoot = dir
      return dir
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error('Cannot locate the BUFI-6900 repo root (no contracts/foundry.toml above this package); set BUFI_6900_ROOT')
}

/** Circle's shipped creation bytecode — the exact bytes behind the production addresses. */
export const CIRCLE_BUILD_OUTPUT = 'contracts/lib/buidl-wallet-contracts/script/bytecode-deploy/build-output'
/** Our own forge build (`cd contracts && forge build`, `FOUNDRY_OUT=out`). */
export const FORGE_OUT = 'contracts/out'

export type ArtifactSource = 'circle' | 'forge'

export interface ForgeArtifact {
  abi: Abi
  bytecode: { object: Hex }
  deployedBytecode?: { object: Hex }
}

export function artifactPath(source: ArtifactSource, name: string): string {
  return source === 'circle'
    ? path.join(repoRoot(), CIRCLE_BUILD_OUTPUT, `${name}.json`)
    : path.join(repoRoot(), FORGE_OUT, `${name}.sol`, `${name}.json`)
}

export function artifactExists(source: ArtifactSource, name: string): boolean {
  return existsSync(artifactPath(source, name))
}

/** Returns `null` when the artifact does not exist (BUFI plugins may not be built yet). */
export async function loadArtifact(source: ArtifactSource, name: string): Promise<ForgeArtifact | null> {
  const file = Bun.file(artifactPath(source, name))
  if (!(await file.exists())) return null
  const json = (await file.json()) as Partial<ForgeArtifact>
  if (!json.bytecode?.object || !json.abi) {
    throw new Error(`Artifact ${artifactPath(source, name)} has no .bytecode.object / .abi`)
  }
  return json as ForgeArtifact
}

export async function requireArtifact(source: ArtifactSource, name: string): Promise<ForgeArtifact> {
  const artifact = await loadArtifact(source, name)
  if (!artifact) {
    const hint = source === 'forge' ? ' — run `cd contracts && FOUNDRY_OUT=out forge build`' : ''
    throw new Error(`Missing artifact ${artifactPath(source, name)}${hint}`)
  }
  return artifact
}

const FORGE_LOCK = '/tmp/bufi6900-forge.lock'

async function withFileLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 10 * 60_000
  while (existsSync(lockPath)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${lockPath}`)
    await Bun.sleep(3000)
  }
  await Bun.write(lockPath, String(process.pid))
  try {
    return await fn()
  } finally {
    rmSync(lockPath, { force: true })
  }
}

/** `cd contracts && FOUNDRY_OUT=out forge build`, serialised with other agents through the forge lock file. */
export async function forgeBuild(log: Logger): Promise<void> {
  await withFileLock(FORGE_LOCK, async () => {
    log('running `forge build` (FOUNDRY_OUT=out) …')
    const proc = Bun.spawn(['forge', 'build'], {
      cwd: path.join(repoRoot(), 'contracts'),
      env: { ...process.env, FOUNDRY_OUT: 'out' },
      stdout: 'inherit',
      stderr: 'inherit',
    })
    const code = await proc.exited
    if (code !== 0) throw new Error(`forge build failed with exit code ${code}`)
  })
}

/** Builds once when any of the required forge artifacts is missing. */
export async function ensureForgeArtifacts(names: string[], log: Logger): Promise<void> {
  const missing = names.filter((name) => !artifactExists('forge', name))
  if (missing.length === 0) return
  log(`forge artifacts missing (${missing.join(', ')})`)
  await forgeBuild(log)
  const stillMissing = names.filter((name) => !artifactExists('forge', name))
  if (stillMissing.length > 0) {
    throw new Error(`forge build finished but artifacts are still missing: ${stillMissing.join(', ')}`)
  }
}
