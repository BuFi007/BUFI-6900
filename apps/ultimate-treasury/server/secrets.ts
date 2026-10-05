// SPDX-License-Identifier: Apache-2.0
/**
 * The ONLY place key material is read. Every loader reads at request time (nothing is cached in module state) and
 * nothing here is ever logged or returned to the browser. Dev-only: imported solely by the Vite server plugin.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import type { Address, Hex } from 'viem'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))

export const SANDBOX = process.env.UT_SANDBOX_DIR ?? join(REPO, '.sandbox', 'ultimate-treasury')
export const FROST_DIR = join(SANDBOX, 'frost')
export const FROST_BIN = process.env.UT_FROST_BIN ?? join(REPO, 'tools', 'frost-delegate', 'target', 'release', 'frost-delegate')
/** The EVM fee payer (submits gatewayMint). Read at request time, never logged. */
export const FEE_PAYER_FILE = process.env.UT_FEE_PAYER_FILE ?? join(REPO, '..', 'desk-v1', '.deployer-wallet.json')

export interface EvmKey {
  address: Address
  privateKey: Hex
}

export function readEvmKeys(): Record<string, EvmKey> {
  return JSON.parse(readFileSync(join(SANDBOX, 'keys.json'), 'utf8')) as Record<string, EvmKey>
}

/** Public addresses only (safe to return to the browser). */
export function readEvmAddresses(): Record<string, Address> {
  return Object.fromEntries(Object.entries(readEvmKeys()).map(([id, k]) => [id, k.address]))
}

export function readFeePayerKey(): Hex {
  const pk = (JSON.parse(readFileSync(FEE_PAYER_FILE, 'utf8')) as { privateKey?: string }).privateKey
  if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error(`fee payer file has no usable privateKey: ${FEE_PAYER_FILE}`)
  return pk as Hex
}

/** FROST share map written at DKG time (owner label → share ids, share threshold). Public, no key material. */
export interface FrostOwners {
  threshold: number
  shares: Record<string, number[]>
}

export function readFrostOwners(): FrostOwners {
  return JSON.parse(readFileSync(join(FROST_DIR, 'owners.json'), 'utf8')) as FrostOwners
}

/** Where accepted-but-unminted attestations are kept (owner-only), so a failed mint is resumed, never re-sent. */
export const ATTESTATION_DIR = join(SANDBOX, 'attestations')

export function readFrostGroupKeyHex(): string {
  return (JSON.parse(readFileSync(join(FROST_DIR, 'group.json'), 'utf8')) as { group_key_hex: string }).group_key_hex
}
