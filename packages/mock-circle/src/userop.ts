/*
 * @bufi/mock-circle — ERC-4337 v0.7 wire format (what bundler JSON-RPC carries) ⇄ PackedUserOperation.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import { concatHex, getAddress, isHex, pad, size, toHex, type Address, type Hex } from 'viem'

import { invalidParams } from './rpc/errors.ts'

/** Unpacked v0.7 userOp as sent over `eth_sendUserOperation` / `pm_*` (all quantities are hex strings). */
export interface RpcUserOperationV07 {
  sender: Address
  nonce: Hex
  factory?: Address | null
  factoryData?: Hex | null
  callData: Hex
  callGasLimit?: Hex
  verificationGasLimit?: Hex
  preVerificationGas?: Hex
  maxFeePerGas?: Hex
  maxPriorityFeePerGas?: Hex
  paymaster?: Address | null
  paymasterVerificationGasLimit?: Hex | null
  paymasterPostOpGasLimit?: Hex | null
  paymasterData?: Hex | null
  signature?: Hex
  /** v0.6-style packed fields — accepted for leniency, `factory`/`paymaster` win when both are present. */
  initCode?: Hex
  paymasterAndData?: Hex
}

export interface PackedUserOperation {
  sender: Address
  nonce: bigint
  initCode: Hex
  callData: Hex
  accountGasLimits: Hex
  preVerificationGas: bigint
  gasFees: Hex
  paymasterAndData: Hex
  signature: Hex
}

export function hexToBig(value: Hex | string | number | bigint | null | undefined, field: string, fallback?: bigint): bigint {
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback
    throw invalidParams(`userOperation.${field} is required`)
  }
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') return BigInt(value)
  if (isHex(value)) return BigInt(value)
  if (/^\d+$/.test(value)) return BigInt(value)
  throw invalidParams(`userOperation.${field} is not a quantity: ${String(value)}`)
}

export function bigToHex(value: bigint): Hex {
  return toHex(value)
}

/** `bytes32(uint128(a) ‖ uint128(b))` — accountGasLimits and gasFees. */
export function packUint128Pair(a: bigint, b: bigint): Hex {
  return concatHex([pad(toHex(a), { size: 16 }), pad(toHex(b), { size: 16 })])
}

export function unpackUint128Pair(word: Hex): [bigint, bigint] {
  const body = word.slice(2).padStart(64, '0')
  return [BigInt(`0x${body.slice(0, 32)}`), BigInt(`0x${body.slice(32, 64)}`)]
}

function optionalHex(value: Hex | null | undefined, field: string): Hex {
  if (value === undefined || value === null) return '0x'
  if (!isHex(value)) throw invalidParams(`userOperation.${field} is not hex`)
  return value
}

function requireAddress(value: unknown, field: string): Address {
  if (typeof value !== 'string' || !isHex(value) || size(value) !== 20) {
    throw invalidParams(`userOperation.${field} is not an address`)
  }
  return getAddress(value)
}

/** Validates the wire shape and normalises addresses; throws JSON-RPC -32602 on malformed input. */
export function parseRpcUserOperation(raw: unknown): RpcUserOperationV07 {
  if (!raw || typeof raw !== 'object') throw invalidParams('userOperation must be an object')
  const op = raw as Record<string, unknown>
  const out: RpcUserOperationV07 = {
    sender: requireAddress(op.sender, 'sender'),
    nonce: toHex(hexToBig(op.nonce as Hex, 'nonce')),
    callData: optionalHex(op.callData as Hex, 'callData'),
  }
  if (op.factory) out.factory = requireAddress(op.factory, 'factory')
  if (op.factoryData) out.factoryData = optionalHex(op.factoryData as Hex, 'factoryData')
  if (op.initCode) out.initCode = optionalHex(op.initCode as Hex, 'initCode')
  if (op.paymaster) out.paymaster = requireAddress(op.paymaster, 'paymaster')
  if (op.paymasterData) out.paymasterData = optionalHex(op.paymasterData as Hex, 'paymasterData')
  if (op.paymasterAndData) out.paymasterAndData = optionalHex(op.paymasterAndData as Hex, 'paymasterAndData')
  for (const field of [
    'callGasLimit',
    'verificationGasLimit',
    'preVerificationGas',
    'maxFeePerGas',
    'maxPriorityFeePerGas',
    'paymasterVerificationGasLimit',
    'paymasterPostOpGasLimit',
  ] as const) {
    const value = op[field]
    if (value !== undefined && value !== null) out[field] = toHex(hexToBig(value as Hex, field))
  }
  if (op.signature !== undefined) out.signature = optionalHex(op.signature as Hex, 'signature')
  return out
}

/** initCode = factory ‖ factoryData (v0.7) — or the v0.6 `initCode` when that is all we got. */
export function initCodeOf(op: RpcUserOperationV07): Hex {
  if (op.factory) return concatHex([op.factory, op.factoryData ?? '0x'])
  return op.initCode ?? '0x'
}

/** paymasterAndData = paymaster ‖ uint128(verificationGas) ‖ uint128(postOpGas) ‖ paymasterData. */
export function paymasterAndDataOf(op: RpcUserOperationV07): Hex {
  if (op.paymaster) {
    return concatHex([
      op.paymaster,
      pad(toHex(hexToBig(op.paymasterVerificationGasLimit, 'paymasterVerificationGasLimit', 0n)), { size: 16 }),
      pad(toHex(hexToBig(op.paymasterPostOpGasLimit, 'paymasterPostOpGasLimit', 0n)), { size: 16 }),
      op.paymasterData ?? '0x',
    ])
  }
  return op.paymasterAndData ?? '0x'
}

/**
 * Packs a wire userOp into the EntryPoint v0.7 struct. Missing gas fields default to zero — callers that need
 * a submittable op (`eth_sendUserOperation`) validate presence themselves; `pm_getPaymasterStubData` legitimately
 * arrives before estimation.
 */
export function packUserOperation(op: RpcUserOperationV07): PackedUserOperation {
  return {
    sender: op.sender,
    nonce: hexToBig(op.nonce, 'nonce'),
    initCode: initCodeOf(op),
    callData: op.callData,
    accountGasLimits: packUint128Pair(
      hexToBig(op.verificationGasLimit, 'verificationGasLimit', 0n),
      hexToBig(op.callGasLimit, 'callGasLimit', 0n),
    ),
    preVerificationGas: hexToBig(op.preVerificationGas, 'preVerificationGas', 0n),
    gasFees: packUint128Pair(
      hexToBig(op.maxPriorityFeePerGas, 'maxPriorityFeePerGas', 0n),
      hexToBig(op.maxFeePerGas, 'maxFeePerGas', 0n),
    ),
    paymasterAndData: paymasterAndDataOf(op),
    signature: op.signature ?? '0x',
  }
}

/** The fields `eth_sendUserOperation` cannot do without. */
export function assertSubmittable(op: RpcUserOperationV07): void {
  for (const field of ['callGasLimit', 'verificationGasLimit', 'preVerificationGas', 'maxFeePerGas', 'maxPriorityFeePerGas'] as const) {
    if (op[field] === undefined) throw invalidParams(`userOperation.${field} is required for eth_sendUserOperation`)
  }
  if (!op.signature || op.signature === '0x') throw invalidParams('userOperation.signature is required')
}
