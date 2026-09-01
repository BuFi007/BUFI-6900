/*
 * @bufi/mock-circle — `circle_*` methods of the Modular Wallets API.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import {
  concatHex,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  isAddress,
  keccak256,
  pad,
  toHex,
  zeroHash,
  type Address,
  type Hex,
} from 'viem'

import { factoryAbi, initializingDataAbi, publicKeyCoordinatesAbi, weightedPluginInstallDataAbi } from '../abi.ts'
import { BLOCKCHAIN_NAME, DEFAULT_GAS_LIMITS, SCA_CORE } from '../config.ts'
import type { RpcContext } from './context.ts'
import { invalidParams } from './errors.ts'
import {
  OwnerIdentifierType,
  type AddressMappingOwner,
  type AddressMappingResponse,
  type GetAddressParams,
  type GetUserOperationGasPriceResponse,
  type ModularWallet,
  type WeightedMultisig,
} from './types.ts'

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

function toWeight(value: unknown, field: string): bigint {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return BigInt(value)
  if (typeof value === 'string' && /^\d+$/.test(value) && BigInt(value) > 0n) return BigInt(value)
  throw invalidParams(`${field} must be a positive integer`)
}

function toCoordinate(value: unknown, field: string): bigint {
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value)
  if (typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value)) return BigInt(value)
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value)
  throw invalidParams(`${field} must be a decimal (or 0x) integer string`)
}

export function ownerKey(owner: AddressMappingOwner): string {
  if (owner.type === OwnerIdentifierType.EOA) return `eoa:${owner.identifier.address.toLowerCase()}`
  return `webauthn:${toCoordinate(owner.identifier.publicKeyX, 'publicKeyX')}:${toCoordinate(owner.identifier.publicKeyY, 'publicKeyY')}`
}

function ownersOf(config: WeightedMultisig): AddressMappingOwner[] {
  return [
    ...(config.owners ?? []).map((o) => ({ type: OwnerIdentifierType.EOA, identifier: { address: o.address } }) as const),
    ...(config.webauthnOwners ?? []).map(
      (o) => ({ type: OwnerIdentifierType.WebAuthn, identifier: { publicKeyX: o.publicKeyX, publicKeyY: o.publicKeyY } }) as const,
    ),
  ]
}

/**
 * circle_getAddress — derives the counterfactual MSCA exactly like the SDK does, through the factory:
 *   sender  = bytes32(eoaOwner) | keccak256(abi.encode(x, y))
 *   salt    = bytes32(0)
 *   init    = abi.encode([weightedPlugin], [manifestHash], [abi.encode(owners, weights, pubKeys, pkWeights, threshold)])
 *   address = factory.getAddress(sender, salt, init)
 */
export async function circleGetAddress(ctx: RpcContext, params: unknown[]): Promise<ModularWallet> {
  const p = params[0] as Partial<GetAddressParams> | undefined
  if (!p?.scaConfiguration) throw invalidParams('params[0].scaConfiguration is required')
  if (p.scaConfiguration.scaCore !== SCA_CORE) {
    throw invalidParams(`unsupported scaCore "${String(p.scaConfiguration.scaCore)}" (expected "${SCA_CORE}")`)
  }
  const config = p.scaConfiguration.initialOwnershipConfiguration?.weightedMultisig
  if (!config) throw invalidParams('scaConfiguration.initialOwnershipConfiguration.weightedMultisig is required')

  const eoas = (config.owners ?? []).map((o, i) => {
    if (typeof o?.address !== 'string' || !isAddress(o.address)) throw invalidParams(`owners[${i}].address is not an address`)
    return { address: getAddress(o.address), weight: toWeight(o.weight, `owners[${i}].weight`) }
  })
  const passkeys = (config.webauthnOwners ?? []).map((o, i) => ({
    x: toCoordinate(o?.publicKeyX, `webauthnOwners[${i}].publicKeyX`),
    y: toCoordinate(o?.publicKeyY, `webauthnOwners[${i}].publicKeyY`),
    weight: toWeight(o?.weight, `webauthnOwners[${i}].weight`),
  }))
  if (eoas.length + passkeys.length === 0) throw invalidParams('weightedMultisig needs at least one owner')
  const threshold = toWeight(config.thresholdWeight, 'weightedMultisig.thresholdWeight')

  const weighted = ctx.deployment.plugins.weightedWebauthnMultisig
  const installData = encodeAbiParameters(weightedPluginInstallDataAbi, [
    eoas.map((o) => o.address),
    eoas.map((o) => o.weight),
    passkeys.map((k) => ({ x: k.x, y: k.y })),
    passkeys.map((k) => k.weight),
    threshold,
  ])
  const initializingData = encodeAbiParameters(initializingDataAbi, [[weighted.address], [weighted.manifestHash], [installData]])
  const firstEoa = eoas[0]
  const firstKey = passkeys[0]
  const sender: Hex = firstEoa
    ? pad(firstEoa.address, { size: 32 })
    : keccak256(encodeAbiParameters(publicKeyCoordinatesAbi, [firstKey!.x, firstKey!.y]))
  const salt = zeroHash

  const factory = ctx.deployment.upgradableMscaFactory
  const [address] = await ctx.publicClient.readContract({
    address: factory,
    abi: factoryAbi,
    functionName: 'getAddress',
    args: [sender, salt, initializingData],
  })
  const key = address.toLowerCase()
  const existing = ctx.state.wallets.get(key)
  if (existing) return existing

  const initCode = concatHex([
    factory,
    encodeFunctionData({ abi: factoryAbi, functionName: 'createAccount', args: [sender, salt, initializingData] }),
  ])
  const timestamp = nowIso()
  const wallet: ModularWallet = {
    id: crypto.randomUUID(),
    address,
    blockchain: BLOCKCHAIN_NAME,
    state: 'LIVE',
    scaCore: SCA_CORE,
    scaConfiguration: {
      initialOwnershipConfiguration: {
        ownershipContractAddress: weighted.address,
        weightedMultisig: {
          ...(config.owners ? { owners: eoas.map((o) => ({ address: o.address, weight: Number(o.weight) })) } : {}),
          ...(config.webauthnOwners
            ? {
                webauthnOwners: passkeys.map((k) => ({
                  publicKeyX: k.x.toString(),
                  publicKeyY: k.y.toString(),
                  weight: Number(k.weight),
                })),
              }
            : {}),
          thresholdWeight: Number(threshold),
        },
      },
      initCode,
    },
    createDate: timestamp,
    updateDate: timestamp,
  }
  ctx.state.wallets.set(key, wallet)
  for (const owner of ownersOf(wallet.scaConfiguration.initialOwnershipConfiguration.weightedMultisig)) {
    const ok = ownerKey(owner)
    if (!ctx.state.walletsByOwner.has(ok)) ctx.state.walletsByOwner.set(ok, new Set())
    ctx.state.walletsByOwner.get(ok)!.add(key)
  }
  ctx.log(`circle_getAddress → ${address} (${p.metadata?.name ?? 'unnamed'}; ${eoas.length} EOA, ${passkeys.length} passkey owner(s))`)
  return wallet
}

function parseOwner(raw: unknown, field: string): AddressMappingOwner {
  const owner = raw as Partial<AddressMappingOwner> | undefined
  if (!owner || typeof owner !== 'object') throw invalidParams(`${field} must be an object`)
  if (owner.type === OwnerIdentifierType.EOA) {
    const address = (owner.identifier as { address?: unknown } | undefined)?.address
    if (typeof address !== 'string' || !isAddress(address)) throw invalidParams(`${field}.identifier.address is not an address`)
    return { type: OwnerIdentifierType.EOA, identifier: { address: getAddress(address) } }
  }
  if (owner.type === OwnerIdentifierType.WebAuthn) {
    const id = owner.identifier as { publicKeyX?: unknown; publicKeyY?: unknown } | undefined
    const x = toCoordinate(id?.publicKeyX, `${field}.identifier.publicKeyX`)
    const y = toCoordinate(id?.publicKeyY, `${field}.identifier.publicKeyY`)
    return { type: OwnerIdentifierType.WebAuthn, identifier: { publicKeyX: x.toString(), publicKeyY: y.toString() } }
  }
  throw invalidParams(`${field}.type must be ${OwnerIdentifierType.EOA} or ${OwnerIdentifierType.WebAuthn}`)
}

/** circle_createAddressMapping — `[{ walletAddress, owners: [{ type, identifier }] }]`. */
export function circleCreateAddressMapping(ctx: RpcContext, params: unknown[]): AddressMappingResponse[] {
  const p = params[0] as { walletAddress?: unknown; owners?: unknown } | undefined
  if (typeof p?.walletAddress !== 'string' || !isAddress(p.walletAddress)) throw invalidParams('walletAddress is not an address')
  if (!Array.isArray(p.owners) || p.owners.length === 0) throw invalidParams('owners must be a non-empty array')
  const walletAddress = getAddress(p.walletAddress)
  const created: AddressMappingResponse[] = []
  p.owners.forEach((raw, i) => {
    const owner = parseOwner(raw, `owners[${i}]`)
    const key = ownerKey(owner)
    const rows = ctx.state.addressMappings.get(key) ?? []
    const existing = rows.find((row) => row.walletAddress.toLowerCase() === walletAddress.toLowerCase())
    if (existing) {
      created.push(existing)
      return
    }
    const timestamp = nowIso()
    const row: AddressMappingResponse = {
      id: crypto.randomUUID(),
      blockchain: BLOCKCHAIN_NAME,
      owner,
      walletAddress,
      createDate: timestamp,
      updateDate: timestamp,
    }
    rows.push(row)
    ctx.state.addressMappings.set(key, rows)
    created.push(row)
  })
  return created
}

/** circle_getAddressMapping — `[{ owner }]`; explicit mappings first, then wallets minted via circle_getAddress. */
export function circleGetAddressMapping(ctx: RpcContext, params: unknown[]): AddressMappingResponse[] {
  const p = params[0] as { owner?: unknown } | undefined
  const owner = parseOwner(p?.owner, 'owner')
  const key = ownerKey(owner)
  const explicit = ctx.state.addressMappings.get(key) ?? []
  const seen = new Set(explicit.map((row) => row.walletAddress.toLowerCase()))
  const implicit: AddressMappingResponse[] = []
  for (const walletKey of ctx.state.walletsByOwner.get(key) ?? []) {
    if (seen.has(walletKey)) continue
    const wallet = ctx.state.wallets.get(walletKey)
    if (!wallet) continue
    implicit.push({
      id: wallet.id,
      blockchain: wallet.blockchain,
      owner,
      walletAddress: wallet.address,
      createDate: wallet.createDate,
      updateDate: wallet.updateDate,
    })
  }
  return [...explicit, ...implicit]
}

/** circle_getUserOperationGasPrice — three fee tiers from anvil's base fee, plus the SDK's verification defaults. */
export async function circleGetUserOperationGasPrice(ctx: RpcContext): Promise<GetUserOperationGasPriceResponse> {
  const block = await ctx.publicClient.getBlock({ blockTag: 'latest' })
  const baseFee = block.baseFeePerGas ?? 0n
  let priority = 0n
  try {
    priority = await ctx.publicClient.estimateMaxPriorityFeePerGas()
  } catch {
    priority = 0n
  }
  if (priority < 100_000_000n) priority = 100_000_000n // floor at 0.1 gwei so tiers are distinguishable
  const level = (pct: bigint) => {
    const tip = (priority * pct) / 100n
    // 2× base fee headroom: the op stays valid while anvil's base fee moves between estimate and inclusion.
    return { maxPriorityFeePerGas: toHex(tip), maxFeePerGas: toHex(baseFee * 2n + tip) }
  }
  return {
    low: level(100n),
    medium: level(120n),
    high: level(150n),
    deployed: toHex(DEFAULT_GAS_LIMITS.deployedVerificationGasLimit),
    notDeployed: toHex(DEFAULT_GAS_LIMITS.notDeployedVerificationGasLimit),
  }
}

export function assertKnownWallet(ctx: RpcContext, address: Address): ModularWallet | undefined {
  return ctx.state.wallets.get(address.toLowerCase())
}
