/**
 * The session context: the bound kit, the resolved config, the state file, the
 * owner signers and the agent's session key. Built once in `main` and handed
 * to the tools, `/setup` and the prompt builder.
 *
 * Keys live only here. Tools receive signers (address + `signDigest`), never
 * private keys, and the model receives addresses only.
 */
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts'
import type { Address, Hex } from 'viem'
import type { AgentConfig } from './config.js'
import type { KitEnv, OwnerSigner, TreasuryChain, TreasuryChainKey, TreasuryKit } from './kit-contract.js'
import { createStubQuoter, createViemQuoter, type Quoter } from './quote.js'
import { kitMode } from './kit.js'
import { findDeployment, loadState, saveState, type AgentState, type StoredDeployment } from './state.js'

/** Everything a tool or command needs to act on the treasury. */
export interface TreasuryContext {
  kit: TreasuryKit
  env: KitEnv
  config: AgentConfig
  state: AgentState
  /** The agent's session key, as a signer the kit can submit with. */
  sessionKey: OwnerSigner
  /** The quorum's owner signers, in `TREASURY_OWNER_KEYS` order. */
  ownerSigners: OwnerSigner[]
  quoter: Quoter
  /** The kit's chain with this app's conduit/router/vault overrides applied. */
  chainOf(key: TreasuryChainKey): TreasuryChain
  /** The conduit for `key`: the override, else the kit's table, else an error naming the env var. */
  conduitOf(key: TreasuryChainKey): Address
  /** Persist a deployment into the state file. */
  recordDeployment(deployment: StoredDeployment): Promise<void>
  /** The deployment `/setup` recorded for `key`, or an error telling the user to run `/setup`. */
  requireDeployment(key: TreasuryChainKey): StoredDeployment
  /** Resolve which chain a tool call means: the given key, else the only configured chain. */
  resolveChain(key?: string): TreasuryChainKey
}

/** Build the context: load state, mint and persist the session key if there is none. */
export async function createContext(kit: TreasuryKit, config: AgentConfig): Promise<TreasuryContext> {
  let state = await loadState(config.statePath)
  const sessionPrivateKey: Hex = config.sessionKeyFromEnv ?? state.sessionPrivateKey ?? generatePrivateKey()
  if (!config.sessionKeyFromEnv && state.sessionPrivateKey !== sessionPrivateKey) {
    state = { ...state, sessionPrivateKey }
    await saveState(config.statePath, state)
  }
  const sessionKey = kit.localKeySigner(sessionPrivateKey)
  const ownerSigners = config.ownerKeys.map((k) => kit.localKeySigner(k))
  const quoter = kitMode() === 'stub' ? createStubQuoter() : createViemQuoter()

  const chainOf = (key: TreasuryChainKey): TreasuryChain => {
    const base = kit.getChain(key)
    const o = config.overrides(key)
    const conduit = o.conduit ?? base.conduit
    const targets: Record<string, Address> = {}
    if (o.router) targets.router = o.router
    if (o.vault) targets.vault = o.vault
    if (!conduit) return { ...base, targets: { ...base.targets, ...targets } }
    return kit.withConduit(base, conduit, targets)
  }

  const ctx: TreasuryContext = {
    kit,
    env: config.kitEnv,
    config,
    state,
    sessionKey,
    ownerSigners,
    quoter,
    chainOf,
    conduitOf(key) {
      const conduit = chainOf(key).conduit
      if (!conduit) {
        throw new Error(
          `${key} has no TreasuryConduit address: set AGENT_CONDUIT_${key.replace(/-/g, '_')} to the deployed conduit`,
        )
      }
      return conduit
    },
    async recordDeployment(deployment) {
      const others = ctx.state.deployments.filter((d) => d.chain !== deployment.chain)
      ctx.state = { ...ctx.state, deployments: [...others, deployment] }
      await saveState(config.statePath, ctx.state)
    },
    requireDeployment(key) {
      const found = findDeployment(ctx.state, key)
      if (!found) throw new Error(`no treasury on ${key} yet — run /setup first`)
      return found
    },
    resolveChain(key) {
      if (key && key.trim()) {
        const k = key.trim().toUpperCase() as TreasuryChainKey
        if (!config.chains.includes(k)) throw new Error(`${k} is not in AGENT_CHAINS (${config.chains.join(', ')})`)
        return k
      }
      if (config.chains.length === 1) return config.chains[0]!
      throw new Error(`several chains are configured (${config.chains.join(', ')}); say which one`)
    },
  }
  return ctx
}

/** The session key's address, for logs and the prompt. */
export function sessionKeyAddress(ctx: TreasuryContext): Address {
  return ctx.sessionKey.address
}

/** Address of a private key without exposing the key. */
export function addressOf(privateKey: Hex): Address {
  return privateKeyToAddress(privateKey)
}
