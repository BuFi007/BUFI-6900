// SPDX-License-Identifier: Apache-2.0
/**
 * Public, key-free facts about the treasury. Imported by the browser bundle AND the dev-only signer, so nothing in
 * here may ever be secret: addresses, domains, caps, explorer URLs.
 */

export const GATEWAY_API = 'https://gateway-api-testnet.circle.com'

/** Circle Gateway domain ids (testnet). */
export const DOMAIN = { solana: 5, baseSepolia: 6, arc: 26 } as const

export type PositionId = 'evm' | 'solana'

export interface PositionInfo {
  id: PositionId
  /** What the user reads when they open the breakdown. Chains are shown only here. */
  label: string
  chain: string
  domain: number
  /** Gateway depositor (EVM: the GatewayTreasury contract; Solana: the Squads vault PDA). */
  depositor: string
  /** Where a send from this position is minted. */
  destination: { chain: string; domain: number }
  /** How the quorum is enforced for this position. */
  enforcement: string
  /** Typical Gateway fee observed on testnet, used only to choose a source that can cover amount + fee. */
  feeEstimate: number
}

export const EVM_TREASURY = '0x692Db08885870fA99ADA4Acdee02633947669daF' as const
export const SOLANA_VAULT = 'AtBgen532MGQmGjhmKcXRHxaBpSDz1ML6WXuUYw1yy9B'
export const SOLANA_SMART_ACCOUNT = 'AVfkRovDYbmb3Nf7nUGdrubYWykeoY4vtphPusjnMshz'
export const SOLANA_DELEGATE = 'EBjX3U8y1S1weZBNGooB7Ab3YmsFLNGK5W6EVYKhL3c2'

export const POSITIONS: Record<PositionId, PositionInfo> = {
  evm: {
    id: 'evm',
    label: 'Treasury contract',
    chain: 'Arc testnet',
    domain: DOMAIN.arc,
    depositor: EVM_TREASURY,
    destination: { chain: 'Base Sepolia', domain: DOMAIN.baseSepolia },
    enforcement: 'On-chain: GatewayTreasury.isValidSignature (ERC-1271) checks quorum, allowlist, domain, caps; Gateway runs it.',
    feeEstimate: 0.01,
  },
  solana: {
    id: 'solana',
    label: 'Squads vault',
    chain: 'Solana devnet',
    domain: DOMAIN.solana,
    depositor: SOLANA_VAULT,
    destination: { chain: 'Arc testnet', domain: DOMAIN.arc },
    enforcement: 'Threshold key: the Gateway delegate is a FROST group key (3 of 4 shares). The allowlist and caps are enforced OFF-CHAIN by the signing coordinator (frost-delegate policy.json), before any share signs.',
    feeEstimate: 0.2,
  },
}

/** Policy as deployed (2026-10-05). The dev signer replaces it with a live on-chain read. */
export const DEPLOYED_POLICY = {
  thresholdWeight: 3,
  owners: [
    { id: 'A', address: '0x5fC11d3f4C37a02EaB41B71E18Af0486D6348c06', weight: 2 },
    { id: 'B', address: '0x13898C82DF06B860a4ded8896c601Cb82394870d', weight: 1 },
    { id: 'C', address: '0xCf1478c67eE1e073988Fc9018bCb0DFA5FB0f2E7', weight: 1 },
  ],
  allowlist: [{ id: 'R', address: '0xF7D0520C36717e25c5b77F977A89741d2974589C' }],
  /** A known address that is NOT on the allowlist, used by the refusal demo. */
  outsider: { id: 'S', address: '0xd21389825CeB0843d108F639c9C70B55caa30A28' },
  destinationDomains: [DOMAIN.baseSepolia],
  perIntentCap: 2,
  maxFeeCap: 2.01,
  maxExpiryBlocks: 1_250_000,
}

export const EXPLORER: Record<string, string> = {
  'Base Sepolia': 'https://sepolia.basescan.org/tx/',
  'Arc testnet': 'https://testnet.arcscan.app/tx/',
}

export const ASSETS: { symbol: string; name: string; onGateway: boolean }[] = [
  { symbol: 'USDC', name: 'USD Coin', onGateway: true },
  { symbol: 'EURC', name: 'Euro Coin', onGateway: false },
  { symbol: 'cirBTC', name: 'Circle Bitcoin', onGateway: false },
  { symbol: 'StableFX', name: 'Other StableFX assets', onGateway: false },
]

export interface GatewayBalanceRow {
  domain: number
  depositor: string
  balance: string
}

/** Read-only, public: POST /v1/balances for both positions. Used by the dev signer and the production page alike. */
export async function fetchGatewayBalances(fetchImpl: typeof fetch = fetch): Promise<Record<PositionId, number>> {
  const res = await fetchImpl(`${GATEWAY_API}/v1/balances`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: 'USDC',
      sources: [
        { domain: POSITIONS.evm.domain, depositor: POSITIONS.evm.depositor },
        { domain: POSITIONS.solana.domain, depositor: POSITIONS.solana.depositor },
      ],
    }),
  })
  if (!res.ok) throw new Error(`Gateway /v1/balances ${res.status}: ${await res.text()}`)
  const json = (await res.json()) as { balances?: GatewayBalanceRow[] }
  const find = (p: PositionInfo) =>
    Number(json.balances?.find((b) => b.domain === p.domain && b.depositor.toLowerCase() === p.depositor.toLowerCase())?.balance ?? 0)
  return { evm: find(POSITIONS.evm), solana: find(POSITIONS.solana) }
}

/**
 * Choose the source automatically: among positions that can cover amount + typical fee (and the EVM per-intent cap),
 * the one with the larger balance. Returns null when none can.
 */
export function pickSource(balances: Record<PositionId, number>, amount: number, perIntentCap: number): PositionId | null {
  const can = (Object.keys(POSITIONS) as PositionId[]).filter((id) => {
    if (id === 'evm' && amount > perIntentCap) return false
    return balances[id] >= amount + POSITIONS[id].feeEstimate
  })
  if (can.length === 0) return null
  return can.sort((a, b) => balances[b] - balances[a])[0]!
}
