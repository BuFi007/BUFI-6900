// SPDX-License-Identifier: Apache-2.0
/**
 * EVM leg: GatewayTreasury (Arc testnet) is its own Gateway signer. The owners sign the EIP-712 BurnIntent hash and the
 * treasury's isValidSignature checks kind 0 = abi.encode(uint8 0, abi.encode(BurnIntent), ownerSigs ascending).
 * Same construction as scripts/gateway-treasury/canary.ts.
 */
import { randomBytes } from 'node:crypto'

import {
  type Address,
  type Hex,
  concat,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  hashTypedData,
  http,
  pad,
  parseAbi,
} from 'viem'
import { privateKeyToAccount, sign } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'

import { DOMAIN, EVM_TREASURY } from '../shared/config'
import type { TreasuryPolicy } from '../shared/types'
import { mintedAmountFromLogs } from './mint-log'
import { readEvmKeys, readFeePayerKey } from './secrets'

export const arcTestnet = defineChain({
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.arc.network'] } },
})

export const GATEWAY_WALLET: Address = '0x0077777d7EBA4688BDeF3E311b846F25870A19B9'
export const GATEWAY_MINTER: Address = '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B'
export const ARC_USDC: Address = '0x3600000000000000000000000000000000000000'
export const BASE_USDC: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
/** Gateway's floor on Arc testnet (1,209,599) + margin, under the treasury's 1,250,000 ceiling. */
export const EVM_EXPIRY_BLOCKS = 1_209_599n + 2_000n
export const MAX_FEE = 2_010_000n

export const arc = createPublicClient({ chain: arcTestnet, transport: http() })
export const base = createPublicClient({ chain: baseSepolia, transport: http() })

export const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)'])
const TREASURY_ABI = parseAbi([
  'function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)',
  'function getOwners() view returns (address[])',
  'function weights(address) view returns (uint16)',
  'function thresholdWeight() view returns (uint256)',
  'function allowedRecipients(bytes32) view returns (bool)',
  'function allowedDestinationDomains(uint32) view returns (bool)',
  'function perIntentCap() view returns (uint256)',
  'function maxFeeCap() view returns (uint256)',
  'function maxExpiryBlocks() view returns (uint256)',
])
const MINTER_ABI = parseAbi(['function gatewayMint(bytes attestationPayload, bytes signature)'])

export const b32 = (a: Address): Hex => pad(a, { size: 32 }).toLowerCase() as Hex

const burnTypes = {
  TransferSpec: [
    { name: 'version', type: 'uint32' },
    { name: 'sourceDomain', type: 'uint32' },
    { name: 'destinationDomain', type: 'uint32' },
    { name: 'sourceContract', type: 'bytes32' },
    { name: 'destinationContract', type: 'bytes32' },
    { name: 'sourceToken', type: 'bytes32' },
    { name: 'destinationToken', type: 'bytes32' },
    { name: 'sourceDepositor', type: 'bytes32' },
    { name: 'destinationRecipient', type: 'bytes32' },
    { name: 'sourceSigner', type: 'bytes32' },
    { name: 'destinationCaller', type: 'bytes32' },
    { name: 'value', type: 'uint256' },
    { name: 'salt', type: 'bytes32' },
    { name: 'hookData', type: 'bytes' },
  ],
  BurnIntent: [
    { name: 'maxBlockHeight', type: 'uint256' },
    { name: 'maxFee', type: 'uint256' },
    { name: 'spec', type: 'TransferSpec' },
  ],
} as const

const BURN_INTENT_TUPLE = [
  {
    type: 'tuple',
    components: [
      { name: 'maxBlockHeight', type: 'uint256' },
      { name: 'maxFee', type: 'uint256' },
      { name: 'spec', type: 'tuple', components: burnTypes.TransferSpec.map((f) => ({ ...f })) },
    ],
  },
] as const

export async function buildEvmIntent(recipient: Address, value: bigint) {
  const head = await arc.getBlockNumber()
  const message = {
    maxBlockHeight: head + EVM_EXPIRY_BLOCKS,
    maxFee: MAX_FEE,
    spec: {
      version: 1,
      sourceDomain: DOMAIN.arc,
      destinationDomain: DOMAIN.baseSepolia,
      sourceContract: b32(GATEWAY_WALLET),
      destinationContract: b32(GATEWAY_MINTER),
      sourceToken: b32(ARC_USDC),
      destinationToken: b32(BASE_USDC),
      sourceDepositor: b32(EVM_TREASURY),
      destinationRecipient: b32(recipient),
      sourceSigner: b32(EVM_TREASURY),
      destinationCaller: pad('0x00', { size: 32 }),
      value,
      salt: `0x${randomBytes(32).toString('hex')}` as Hex,
      hookData: '0x' as Hex,
    },
  }
  const hash = hashTypedData({ domain: { name: 'GatewayWallet', version: '1' }, types: burnTypes, primaryType: 'BurnIntent', message })
  return { message, hash }
}

export type EvmIntent = Awaited<ReturnType<typeof buildEvmIntent>>['message']

/** Owner ECDSA signatures over `hash`, ascending by address, packed r‖s‖v. Unknown ids throw. */
async function ownerSigs(ids: string[], hash: Hex): Promise<Hex> {
  const keys = readEvmKeys()
  const owners = ids.map((id) => {
    const k = keys[id]
    if (!k) throw new Error(`unknown owner ${id}`)
    return k
  })
  owners.sort((x, y) => (BigInt(x.address) < BigInt(y.address) ? -1 : 1))
  return concat(await Promise.all(owners.map((o) => sign({ hash, privateKey: o.privateKey, to: 'hex' }))))
}

/** Kind-0 ERC-1271 signature for the treasury. */
export async function evmContractSignature(message: EvmIntent, hash: Hex, signers: string[]): Promise<Hex> {
  const payload = encodeAbiParameters(BURN_INTENT_TUPLE, [message])
  return encodeAbiParameters([{ type: 'uint8' }, { type: 'bytes' }, { type: 'bytes' }], [0, payload, await ownerSigs(signers, hash)])
}

export async function localIsValidSignature(hash: Hex, signature: Hex): Promise<string> {
  return (await arc.readContract({ address: EVM_TREASURY, abi: TREASURY_ABI, functionName: 'isValidSignature', args: [hash, signature] })) as string
}

export async function isAllowlisted(recipient: Address): Promise<boolean> {
  return (await arc.readContract({ address: EVM_TREASURY, abi: TREASURY_ABI, functionName: 'allowedRecipients', args: [b32(recipient)] })) as boolean
}

/** Live policy read from the deployed treasury. `known` maps key-file ids to addresses (labels only). */
export async function readPolicy(known: Record<string, Address>): Promise<TreasuryPolicy> {
  const r = <T>(functionName: string, args: unknown[] = []) =>
    arc.readContract({ address: EVM_TREASURY, abi: TREASURY_ABI, functionName, args } as never) as Promise<T>
  const idOf = (a: string) => Object.entries(known).find(([, v]) => v.toLowerCase() === a.toLowerCase())?.[0] ?? a.slice(0, 8)
  const ownerAddrs = await r<Address[]>('getOwners')
  const owners = await Promise.all(ownerAddrs.map(async (address) => ({ id: idOf(address), address, weight: Number(await r<number>('weights', [address])) })))
  owners.sort((a, b) => a.id.localeCompare(b.id))
  const candidates = Object.entries(known).filter(([, a]) => !ownerAddrs.some((o) => o.toLowerCase() === a.toLowerCase()))
  const flags = await Promise.all(candidates.map(([, a]) => isAllowlisted(a)))
  const allowlist = candidates.filter((_, i) => flags[i]).map(([id, address]) => ({ id, address }))
  const outsiders = candidates.filter((_, i) => !flags[i]).map(([id, address]) => ({ id, address }))
  const [thresholdWeight, perIntentCap, maxFeeCap, maxExpiryBlocks] = await Promise.all([
    r<bigint>('thresholdWeight'),
    r<bigint>('perIntentCap'),
    r<bigint>('maxFeeCap'),
    r<bigint>('maxExpiryBlocks'),
  ])
  const domains = await Promise.all(([DOMAIN.solana, DOMAIN.baseSepolia, DOMAIN.arc] as number[]).map(async (d): Promise<number | null> => ((await r<boolean>('allowedDestinationDomains', [d])) ? d : null)))
  return {
    live: true,
    thresholdWeight: Number(thresholdWeight),
    owners,
    allowlist,
    outsider: outsiders[0] ?? { id: '?', address: '0x0000000000000000000000000000000000000000' },
    destinationDomains: domains.filter((d): d is number => d !== null),
    perIntentCap: Number(perIntentCap) / 1e6,
    maxFeeCap: Number(maxFeeCap) / 1e6,
    maxExpiryBlocks: Number(maxExpiryBlocks),
  }
}

/**
 * Submit gatewayMint on the destination chain with the fee payer. The minted amount is read from the receipt's own
 * Transfer log (authoritative); the recipient balance is polled only for display, since public RPCs lag the receipt.
 */
export async function gatewayMint(dest: 'base' | 'arc', attestation: Hex, operatorSig: Hex, recipient: Address) {
  const chain = dest === 'base' ? baseSepolia : arcTestnet
  const pub = dest === 'base' ? base : arc
  const token = dest === 'base' ? BASE_USDC : ARC_USDC
  const wallet = createWalletClient({ account: privateKeyToAccount(readFeePayerKey()), chain, transport: http() })
  const balance = () => pub.readContract({ address: token, abi: ERC20, functionName: 'balanceOf', args: [recipient] }) as Promise<bigint>
  const before = await balance()
  const hash = await wallet.writeContract({ address: GATEWAY_MINTER, abi: MINTER_ABI, functionName: 'gatewayMint', args: [attestation, operatorSig] })
  const receipt = await pub.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw Object.assign(new Error(`gatewayMint reverted: ${hash}`), { txHash: hash })
  const minted = mintedAmountFromLogs(receipt.logs, token, recipient)
  let after = before
  for (let i = 0; i < 10 && after === before; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    after = await balance()
  }
  return { hash, before, after, minted }
}
