/**
 * Everything the app reads from the environment, resolved once at startup.
 * Secrets stay in these structures and never reach the model: the system
 * prompt gets chain names and addresses only.
 */
import { privateKeyToAddress } from 'viem/accounts'
import type { Address, Hex } from 'viem'
import type { KitEnv, TreasuryChainKey } from './kit-contract.js'

/** The LLM providers this app can drive. */
export type LLMProvider = 'anthropic' | 'openai'

/** Who serves the model, the key that pays for it, and which model. */
export interface ProviderConfig {
  provider: LLMProvider
  providerApiKey: string
  model: string
}

/** Provider config plus an optional fallback used when the primary fails. */
export interface AgentProviderConfig extends ProviderConfig {
  fallback?: ProviderConfig
}

const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5'
/** Circle's starter kit default; override with `LLM_MODEL`. */
const DEFAULT_OPENAI_MODEL = 'gpt-5.6-sol'

/** All chain keys the kit knows. Mirrors `TreasuryChainKey`. */
export const CHAIN_KEYS: readonly TreasuryChainKey[] = [
  'LOCAL',
  'ARC-TESTNET',
  'AVAX-FUJI',
  'ARB-SEPOLIA',
  'BASE-SEPOLIA',
  'ARC',
  'AVAX',
]

/** anvil's default account #3 — a public test key, fine to embed. */
export const ANVIL_OWNER_3: Hex = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6'
/** anvil's default account #4 — a public test key, fine to embed. */
export const ANVIL_OWNER_4: Hex = '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a'

const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/
const ADDRESS = /^0x[0-9a-fA-F]{40}$/

/** Resolve provider config the way Circle's kits do: Anthropic first, OpenAI as fallback or alone. */
export function loadProviderConfig(env: NodeJS.ProcessEnv = process.env): AgentProviderConfig {
  const anthropicKey = env.ANTHROPIC_API_KEY?.trim()
  const openaiKey = env.OPENAI_API_KEY?.trim()
  const override = env.LLM_MODEL?.trim()
  if (anthropicKey) {
    return {
      provider: 'anthropic',
      providerApiKey: anthropicKey,
      model: override || DEFAULT_ANTHROPIC_MODEL,
      fallback: openaiKey ? { provider: 'openai', providerApiKey: openaiKey, model: DEFAULT_OPENAI_MODEL } : undefined,
    }
  }
  if (openaiKey) {
    return { provider: 'openai', providerApiKey: openaiKey, model: override || DEFAULT_OPENAI_MODEL }
  }
  throw new Error('No LLM provider key found. Set ANTHROPIC_API_KEY (preferred) or OPENAI_API_KEY in apps/agent/.env.')
}

/** Parse `AGENT_CHAINS` (comma-separated chain keys; default `LOCAL`). */
export function parseChains(raw: string | undefined): TreasuryChainKey[] {
  const keys = (raw ?? 'LOCAL')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
  const bad = keys.filter((k) => !CHAIN_KEYS.includes(k as TreasuryChainKey))
  if (bad.length > 0) throw new Error(`AGENT_CHAINS has unknown chain(s) ${bad.join(', ')}; known: ${CHAIN_KEYS.join(', ')}`)
  if (keys.length === 0) throw new Error('AGENT_CHAINS is empty')
  return [...new Set(keys)] as TreasuryChainKey[]
}

/** Owner keys for the quorum: `TREASURY_OWNER_KEYS` (comma-separated), else anvil #3 and #4 on LOCAL only. */
export function parseOwnerKeys(raw: string | undefined, chains: readonly TreasuryChainKey[]): Hex[] {
  const listed = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (listed.length === 0) {
    const onlyLocal = chains.every((c) => c === 'LOCAL')
    if (!onlyLocal) throw new Error('TREASURY_OWNER_KEYS is required for non-LOCAL chains (two funded private keys, comma-separated)')
    return [ANVIL_OWNER_3, ANVIL_OWNER_4]
  }
  for (const k of listed) {
    if (!PRIVATE_KEY.test(k)) throw new Error('TREASURY_OWNER_KEYS entries must be 0x-prefixed 32-byte hex private keys')
  }
  if (listed.length !== 2) throw new Error(`the demo treasury is 2-of-2: TREASURY_OWNER_KEYS needs exactly two keys, got ${listed.length}`)
  return listed as Hex[]
}

/** Env name for a per-chain override, e.g. `AGENT_CONDUIT_ARC_TESTNET`. */
export function chainEnvName(prefix: string, chain: TreasuryChainKey): string {
  return `${prefix}_${chain.replace(/-/g, '_')}`
}

function readAddress(env: NodeJS.ProcessEnv, name: string): Address | undefined {
  const v = env[name]?.trim()
  if (!v) return undefined
  if (!ADDRESS.test(v)) throw new Error(`${name} is not an address`)
  return v as Address
}

/** Per-chain address overrides the demo may need before the kit's chain table carries them. */
export interface ChainOverrides {
  conduit?: Address
  router?: Address
  vault?: Address
}

/** Read `AGENT_CONDUIT_<CHAIN>`, `AGENT_SWAP_ROUTER_<CHAIN>`, `AGENT_EARN_VAULT_<CHAIN>`. */
export function loadChainOverrides(env: NodeJS.ProcessEnv, chain: TreasuryChainKey): ChainOverrides {
  return {
    conduit: readAddress(env, chainEnvName('AGENT_CONDUIT', chain)),
    router: readAddress(env, chainEnvName('AGENT_SWAP_ROUTER', chain)),
    vault: readAddress(env, chainEnvName('AGENT_EARN_VAULT', chain)),
  }
}

/** The kit's transport env, read from `CIRCLE_CLIENT_URL/KEY`, `MOCK_CIRCLE_URL`, `RPC_URL_<CHAIN>`. */
export function loadKitEnv(env: NodeJS.ProcessEnv = process.env): KitEnv {
  const rpcUrls: Partial<Record<TreasuryChainKey, string>> = {}
  for (const key of CHAIN_KEYS) {
    const url = env[chainEnvName('RPC_URL', key)]?.trim()
    if (url) rpcUrls[key] = url
  }
  return {
    circleClientUrl: env.CIRCLE_CLIENT_URL?.trim() || undefined,
    circleClientKey: env.CIRCLE_CLIENT_KEY?.trim() || undefined,
    mockCircleUrl: env.MOCK_CIRCLE_URL?.trim() || 'http://127.0.0.1:8788/v1/rpc/w3s/buidl',
    rpcUrls,
  }
}

/** The resolved app configuration. */
export interface AgentConfig {
  provider: AgentProviderConfig
  chains: TreasuryChainKey[]
  ownerKeys: Hex[]
  ownerAddresses: Address[]
  /** `AGENT_SESSION_KEY` when set; otherwise the state file supplies or mints one. */
  sessionKeyFromEnv?: Hex
  kitEnv: KitEnv
  overrides: (chain: TreasuryChainKey) => ChainOverrides
  /** Where `.agent-state.json` lives. */
  statePath: string
}

/** Resolve the whole configuration from `env`. Throws with a plain message on anything missing. */
export function loadConfig(env: NodeJS.ProcessEnv, statePath: string): AgentConfig {
  const chains = parseChains(env.AGENT_CHAINS)
  const ownerKeys = parseOwnerKeys(env.TREASURY_OWNER_KEYS, chains)
  const sessionKey = env.AGENT_SESSION_KEY?.trim()
  if (sessionKey && !PRIVATE_KEY.test(sessionKey)) throw new Error('AGENT_SESSION_KEY must be a 0x-prefixed 32-byte hex private key')
  return {
    provider: loadProviderConfig(env),
    chains,
    ownerKeys,
    ownerAddresses: ownerKeys.map((k) => privateKeyToAddress(k)),
    sessionKeyFromEnv: sessionKey ? (sessionKey as Hex) : undefined,
    kitEnv: loadKitEnv(env),
    overrides: (chain) => loadChainOverrides(env, chain),
    statePath,
  }
}
