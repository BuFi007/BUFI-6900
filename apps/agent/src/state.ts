/**
 * `.agent-state.json` — the agent's session key and what `/setup` deployed,
 * kept beside the app and never committed. Bigints are stored as decimal
 * strings; `Hex`/`Address` as-is.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import type { Address, Hex } from 'viem'
import type { AgentGrant, TreasuryChainKey } from './kit-contract.js'

const hex = z.string().regex(/^0x[0-9a-fA-F]*$/)
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/)
const privateKey = z.string().regex(/^0x[0-9a-fA-F]{64}$/)
const bigintString = z.string().regex(/^\d+$/)

const grantSchema = z.object({
  allow: z.array(z.object({ target: address, selectors: z.array(hex).optional() })),
  erc20Budget: z
    .array(z.object({ token: address, limit: bigintString, refreshIntervalSeconds: z.number().int() }))
    .optional(),
  gasBudget: z.object({ limit: bigintString, refreshIntervalSeconds: z.number().int() }).optional(),
  validUntil: z.number().int(),
})

const chainKey = z.enum(['LOCAL', 'ARC-TESTNET', 'AVAX-FUJI', 'ARB-SEPOLIA', 'BASE-SEPOLIA', 'ARC', 'AVAX'])

const deploymentSchema = z.object({
  chain: chainKey,
  treasury: address,
  conduit: address,
  owners: z.array(z.object({ address, weight: bigintString })),
  thresholdWeight: bigintString,
  allowlist: z.array(address),
  agent: z
    .object({
      address,
      sessionKey: address,
      grant: grantSchema,
    })
    .optional(),
})

const stateSchema = z.object({
  version: z.literal(1),
  /** The agent's session private key. Minted on first run unless `AGENT_SESSION_KEY` is set. */
  sessionPrivateKey: privateKey.optional(),
  deployments: z.array(deploymentSchema),
})

type GrantJson = z.infer<typeof grantSchema>
type StateJson = z.infer<typeof stateSchema>

/** One chain's deployment as persisted. */
export interface StoredDeployment {
  chain: TreasuryChainKey
  treasury: Address
  conduit: Address
  owners: { address: Address; weight: bigint }[]
  thresholdWeight: bigint
  allowlist: Address[]
  agent?: { address: Address; sessionKey: Address; grant: AgentGrant }
}

/** The whole state file. */
export interface AgentState {
  version: 1
  sessionPrivateKey?: Hex
  deployments: StoredDeployment[]
}

/** A fresh, empty state. */
export function emptyState(): AgentState {
  return { version: 1, deployments: [] }
}

function grantFromJson(g: GrantJson): AgentGrant {
  return {
    allow: g.allow.map((a) => ({ target: a.target as Address, selectors: a.selectors as Hex[] | undefined })),
    erc20Budget: g.erc20Budget?.map((b) => ({
      token: b.token as Address,
      limit: BigInt(b.limit),
      refreshIntervalSeconds: b.refreshIntervalSeconds,
    })),
    gasBudget: g.gasBudget
      ? { limit: BigInt(g.gasBudget.limit), refreshIntervalSeconds: g.gasBudget.refreshIntervalSeconds }
      : undefined,
    validUntil: g.validUntil,
  }
}

function grantToJson(g: AgentGrant): GrantJson {
  return {
    allow: g.allow.map((a) => ({ target: a.target, selectors: a.selectors ? [...a.selectors] : undefined })),
    erc20Budget: g.erc20Budget?.map((b) => ({
      token: b.token,
      limit: b.limit.toString(),
      refreshIntervalSeconds: b.refreshIntervalSeconds,
    })),
    gasBudget: g.gasBudget
      ? { limit: g.gasBudget.limit.toString(), refreshIntervalSeconds: g.gasBudget.refreshIntervalSeconds }
      : undefined,
    validUntil: g.validUntil,
  }
}

/** Parse the JSON text of a state file. Throws on a malformed file rather than silently starting over. */
export function parseState(text: string): AgentState {
  const raw = stateSchema.parse(JSON.parse(text))
  return {
    version: 1,
    sessionPrivateKey: raw.sessionPrivateKey as Hex | undefined,
    deployments: raw.deployments.map((d) => ({
      chain: d.chain,
      treasury: d.treasury as Address,
      conduit: d.conduit as Address,
      owners: d.owners.map((o) => ({ address: o.address as Address, weight: BigInt(o.weight) })),
      thresholdWeight: BigInt(d.thresholdWeight),
      allowlist: d.allowlist as Address[],
      agent: d.agent
        ? {
            address: d.agent.address as Address,
            sessionKey: d.agent.sessionKey as Address,
            grant: grantFromJson(d.agent.grant),
          }
        : undefined,
    })),
  }
}

/** Serialise a state to the JSON text the file holds. */
export function serializeState(state: AgentState): string {
  const json: StateJson = {
    version: 1,
    sessionPrivateKey: state.sessionPrivateKey,
    deployments: state.deployments.map((d) => ({
      chain: d.chain,
      treasury: d.treasury,
      conduit: d.conduit,
      owners: d.owners.map((o) => ({ address: o.address, weight: o.weight.toString() })),
      thresholdWeight: d.thresholdWeight.toString(),
      allowlist: d.allowlist,
      agent: d.agent
        ? { address: d.agent.address, sessionKey: d.agent.sessionKey, grant: grantToJson(d.agent.grant) }
        : undefined,
    })),
  }
  return `${JSON.stringify(json, null, 2)}\n`
}

/** Load the state file, or an empty state when it does not exist yet. */
export async function loadState(path: string): Promise<AgentState> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState()
    throw error
  }
  return parseState(text)
}

/** Write the state file (owner-only permissions: it holds the session key). */
export async function saveState(path: string, state: AgentState): Promise<void> {
  await writeFile(path, serializeState(state), { mode: 0o600 })
}

/** Replace or add the deployment for `chain`. Returns a new state. */
export function upsertDeployment(state: AgentState, deployment: StoredDeployment): AgentState {
  const others = state.deployments.filter((d) => d.chain !== deployment.chain)
  return { ...state, deployments: [...others, deployment] }
}

/** The deployment on `chain`, if `/setup` ran for it. */
export function findDeployment(state: AgentState, chain: TreasuryChainKey): StoredDeployment | undefined {
  return state.deployments.find((d) => d.chain === chain)
}
