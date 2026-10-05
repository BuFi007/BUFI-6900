// SPDX-License-Identifier: Apache-2.0
import { DOMAIN } from '../shared/config'

export const usd = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })
export const shortAddr = (a: string) => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a)

const DOMAIN_NAMES: Record<number, string> = { [DOMAIN.solana]: 'Solana devnet', [DOMAIN.baseSepolia]: 'Base Sepolia', [DOMAIN.arc]: 'Arc testnet' }
export const domainName = (d: number) => DOMAIN_NAMES[d] ?? `domain ${d}`
