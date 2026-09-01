/*
 * @bufi/mock-circle — ERC-4337 v0.7 bundler methods, backed by a direct `EntryPoint.handleOps` submitter.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  decodeAbiParameters,
  decodeErrorResult,
  getAbiItem,
  getAddress,
  isAddress,
  isHex,
  toEventSelector,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem'

import { entryPointAbi } from '../abi.ts'
import { rawJsonRpc, UpstreamRpcError } from '../chain.ts'
import { DEFAULT_GAS_LIMITS } from '../config.ts'
import { assertSubmittable, hexToBig, packUserOperation, parseRpcUserOperation, type RpcUserOperationV07 } from '../userop.ts'
import { enqueue, type RpcContext } from './context.ts'
import { invalidParams, JsonRpcError, RPC_ERROR } from './errors.ts'
import type {
  EstimateUserOperationGasResponse,
  RpcLog,
  RpcTransactionReceipt,
  StoredUserOp,
  UserOperationByHashResponse,
  UserOperationReceiptResponse,
} from './types.ts'

/** Plain node methods the SDK routes through the Circle endpoint — forwarded to anvil verbatim. */
export const PROXIED_METHODS = new Set([
  'eth_chainId',
  'eth_getBalance',
  'eth_blockNumber',
  'eth_call',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_maxPriorityFeePerGas',
  'eth_gasPrice',
  'eth_getCode',
  'eth_feeHistory',
  'eth_estimateGas',
  'eth_getTransactionCount',
  'eth_getTransactionReceipt',
  'eth_getTransactionByHash',
  'eth_getLogs',
  'eth_getStorageAt',
])

export async function proxyToAnvil(ctx: RpcContext, method: string, params: unknown[]): Promise<unknown> {
  try {
    return await rawJsonRpc(ctx.rpcUrl, method, params)
  } catch (error) {
    if (error instanceof UpstreamRpcError) throw new JsonRpcError(error.code, error.message, error.data)
    throw error
  }
}

function assertEntryPoint(ctx: RpcContext, raw: unknown): Address {
  if (raw === undefined || raw === null) return ctx.deployment.entryPoint
  if (typeof raw !== 'string' || !isAddress(raw)) throw invalidParams('entryPoint must be an address')
  if (getAddress(raw) !== getAddress(ctx.deployment.entryPoint)) {
    throw invalidParams(`unsupported EntryPoint ${raw} (sandbox serves ${ctx.deployment.entryPoint})`)
  }
  return ctx.deployment.entryPoint
}

export function ethSupportedEntryPoints(ctx: RpcContext): Address[] {
  return [ctx.deployment.entryPoint]
}

/** Static, generous limits — the sandbox never simulates for gas (the EntryPoint refunds what is unused). */
export function ethEstimateUserOperationGas(ctx: RpcContext, params: unknown[]): EstimateUserOperationGasResponse {
  const op = parseRpcUserOperation(params[0])
  assertEntryPoint(ctx, params[1])
  const response: EstimateUserOperationGasResponse = {
    preVerificationGas: toHex(DEFAULT_GAS_LIMITS.preVerificationGas),
    verificationGasLimit: toHex(DEFAULT_GAS_LIMITS.verificationGasLimit),
    callGasLimit: toHex(DEFAULT_GAS_LIMITS.callGasLimit),
  }
  if (op.paymaster || (op.paymasterAndData && op.paymasterAndData !== '0x')) {
    response.paymasterVerificationGasLimit = toHex(DEFAULT_GAS_LIMITS.paymasterVerificationGasLimit)
    response.paymasterPostOpGasLimit = toHex(DEFAULT_GAS_LIMITS.paymasterPostOpGasLimit)
  }
  return response
}

/** Outer tx gas: every limit the op declares plus EntryPoint overhead, clamped under anvil's 30M block limit. */
function handleOpsGas(op: RpcUserOperationV07): bigint {
  const sum =
    hexToBig(op.verificationGasLimit, 'verificationGasLimit', 0n) +
    hexToBig(op.callGasLimit, 'callGasLimit', 0n) +
    hexToBig(op.preVerificationGas, 'preVerificationGas', 0n) +
    hexToBig(op.paymasterVerificationGasLimit, 'paymasterVerificationGasLimit', 0n) +
    hexToBig(op.paymasterPostOpGasLimit, 'paymasterPostOpGasLimit', 0n) +
    500_000n
  const min = 1_000_000n
  const max = 29_000_000n
  return sum < min ? min : sum > max ? max : sum
}

function errorCodeFor(reason: string): number {
  if (/^AA(24|34)\b/.test(reason)) return RPC_ERROR.INVALID_SIGNATURE
  if (/^AA3\d\b/.test(reason)) return RPC_ERROR.PAYMASTER_REJECTED
  return RPC_ERROR.ENTRYPOINT_REJECTED
}

const ERROR_STRING_ABI = [{ type: 'error', name: 'Error', inputs: [{ name: 'message', type: 'string' }] }] as const
const PANIC_ABI = [{ type: 'error', name: 'Panic', inputs: [{ name: 'code', type: 'uint256' }] }] as const

/** Best-effort decode of the inner revert carried by FailedOpWithRevert. */
function describeInnerRevert(inner: Hex): string {
  if (!inner || inner === '0x') return 'empty revert data'
  try {
    if (inner.startsWith('0x08c379a0')) {
      const { args } = decodeErrorResult({ abi: ERROR_STRING_ABI, data: inner })
      return `Error("${String(args[0])}")`
    }
    if (inner.startsWith('0x4e487b71')) {
      const { args } = decodeErrorResult({ abi: PANIC_ABI, data: inner })
      return `Panic(${toHex(args[0] as bigint)})`
    }
  } catch {
    /* fall through */
  }
  return `custom error ${inner.slice(0, 10)} (${(inner.length - 2) / 2} bytes)`
}

/** Turns a viem simulate/write failure into the JSON-RPC error a bundler would return. */
export function toEntryPointError(error: unknown): JsonRpcError {
  if (error instanceof JsonRpcError) return error
  const revert =
    error instanceof BaseError ? (error.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null) : null
  if (revert?.data) {
    const { errorName, args = [] } = revert.data
    if (errorName === 'FailedOp') {
      const [opIndex, reason] = args as [bigint, string]
      return new JsonRpcError(errorCodeFor(reason), `FailedOp(${opIndex}, "${reason}")`, {
        errorName,
        opIndex: Number(opIndex),
        reason,
      })
    }
    if (errorName === 'FailedOpWithRevert') {
      const [opIndex, reason, inner] = args as [bigint, string, Hex]
      const innerReason = describeInnerRevert(inner)
      return new JsonRpcError(errorCodeFor(reason), `FailedOpWithRevert(${opIndex}, "${reason}", ${innerReason})`, {
        errorName,
        opIndex: Number(opIndex),
        reason,
        inner,
        innerReason,
      })
    }
    return new JsonRpcError(RPC_ERROR.ENTRYPOINT_REJECTED, `${errorName}(${args.map(String).join(', ')})`, {
      errorName,
      args: args.map(String),
    })
  }
  if (revert) {
    return new JsonRpcError(RPC_ERROR.ENTRYPOINT_REJECTED, `handleOps reverted: ${revert.shortMessage}`, {
      raw: revert.raw,
      signature: revert.signature,
    })
  }
  const message = error instanceof BaseError ? error.shortMessage : error instanceof Error ? error.message : String(error)
  return new JsonRpcError(RPC_ERROR.ENTRYPOINT_REJECTED, `handleOps failed: ${message}`)
}

/**
 * eth_sendUserOperation — packs, hashes with `EntryPoint.getUserOpHash`, dry-runs `handleOps([op], bundler)` so a
 * validation failure comes back as the decoded FailedOp / FailedOpWithRevert, then submits from the bundler key and
 * waits for inclusion (anvil auto-mines, so the receipt is available as soon as the hash is returned).
 */
export async function ethSendUserOperation(ctx: RpcContext, params: unknown[]): Promise<Hex> {
  const op = parseRpcUserOperation(params[0])
  assertSubmittable(op)
  const entryPoint = assertEntryPoint(ctx, params[1])
  const packed = packUserOperation(op)
  const userOpHash = await ctx.publicClient.readContract({
    address: entryPoint,
    abi: entryPointAbi,
    functionName: 'getUserOpHash',
    args: [packed],
  })
  const previous = ctx.state.userOps.get(userOpHash)
  if (previous && previous.status !== 'failed') {
    throw new JsonRpcError(RPC_ERROR.ENTRYPOINT_REJECTED, `userOperation ${userOpHash} was already submitted (${previous.status})`)
  }
  const gas = handleOpsGas(op)
  const call = {
    account: ctx.bundler.account,
    address: entryPoint,
    abi: entryPointAbi,
    functionName: 'handleOps',
    args: [[packed], ctx.bundler.account.address],
    gas,
  } as const

  return enqueue(ctx, async () => {
    try {
      await ctx.publicClient.simulateContract(call)
    } catch (error) {
      const rpcError = toEntryPointError(error)
      ctx.state.userOps.set(userOpHash, { hash: userOpHash, userOperation: op, entryPoint, status: 'failed', error: rpcError.message })
      ctx.log(`eth_sendUserOperation ${userOpHash} rejected: ${rpcError.message}`)
      throw rpcError
    }
    const transactionHash = await ctx.bundler.walletClient.writeContract(call)
    const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash: transactionHash })
    const stored: StoredUserOp = {
      hash: userOpHash,
      userOperation: op,
      entryPoint,
      status: receipt.status === 'success' ? 'included' : 'failed',
      transactionHash,
      blockHash: receipt.blockHash,
      blockNumber: receipt.blockNumber,
    }
    ctx.state.userOps.set(userOpHash, stored)
    if (receipt.status !== 'success') {
      stored.error = `handleOps transaction ${transactionHash} reverted`
      throw new JsonRpcError(RPC_ERROR.ENTRYPOINT_REJECTED, stored.error)
    }
    ctx.log(`eth_sendUserOperation ${userOpHash} → tx ${transactionHash} (block ${receipt.blockNumber}, sender ${op.sender})`)
    return userOpHash
  })
}

function requireHash(raw: unknown): Hex {
  if (typeof raw !== 'string' || !isHex(raw) || raw.length !== 66) throw invalidParams('userOpHash must be a 32-byte hex string')
  return raw.toLowerCase() as Hex
}

function findStored(ctx: RpcContext, hash: Hex): StoredUserOp | undefined {
  for (const [key, value] of ctx.state.userOps) {
    if (key.toLowerCase() === hash) return value
  }
  return undefined
}

export function ethGetUserOperationByHash(ctx: RpcContext, params: unknown[]): UserOperationByHashResponse | null {
  const stored = findStored(ctx, requireHash(params[0]))
  if (!stored || stored.status !== 'included' || !stored.transactionHash || !stored.blockHash || stored.blockNumber === undefined) {
    return null
  }
  return {
    userOperation: stored.userOperation,
    entryPoint: stored.entryPoint,
    transactionHash: stored.transactionHash,
    blockHash: stored.blockHash,
    blockNumber: toHex(stored.blockNumber),
  }
}

const USER_OPERATION_EVENT = toEventSelector(getAbiItem({ abi: entryPointAbi, name: 'UserOperationEvent' }))
const USER_OPERATION_REVERT_REASON = toEventSelector(getAbiItem({ abi: entryPointAbi, name: 'UserOperationRevertReason' }))
const BEFORE_EXECUTION = toEventSelector(getAbiItem({ abi: entryPointAbi, name: 'BeforeExecution' }))

const topicToAddress = (topic: Hex | undefined): Address => (topic ? getAddress(`0x${topic.slice(-40)}`) : zeroAddress)

/** eth_getUserOperationReceipt — parsed from the bundle transaction's `UserOperationEvent`. */
export async function ethGetUserOperationReceipt(ctx: RpcContext, params: unknown[]): Promise<UserOperationReceiptResponse | null> {
  const hash = requireHash(params[0])
  const stored = findStored(ctx, hash)
  if (!stored || stored.status !== 'included' || !stored.transactionHash) return null
  const receipt = await rawJsonRpc<RpcTransactionReceipt | null>(ctx.rpcUrl, 'eth_getTransactionReceipt', [stored.transactionHash])
  if (!receipt) return null

  const logs = receipt.logs
  const eventIndex = logs.findIndex(
    (log) => log.topics[0]?.toLowerCase() === USER_OPERATION_EVENT && log.topics[1]?.toLowerCase() === hash,
  )
  if (eventIndex === -1) return null
  const event = logs[eventIndex]!
  const [nonce, success, actualGasCost, actualGasUsed] = decodeAbiParameters(
    [{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }],
    event.data,
  )

  // This op's own logs: everything after the previous boundary (BeforeExecution / prior op's event) up to its event.
  let start = 0
  for (let i = eventIndex - 1; i >= 0; i--) {
    const topic = logs[i]!.topics[0]?.toLowerCase()
    if (topic === BEFORE_EXECUTION || topic === USER_OPERATION_EVENT) {
      start = i + 1
      break
    }
  }
  const opLogs: RpcLog[] = logs.slice(start, eventIndex)

  let reason: string | undefined
  const revertLog = opLogs.find((log) => log.topics[0]?.toLowerCase() === USER_OPERATION_REVERT_REASON)
  if (revertLog) {
    const [, revertReason] = decodeAbiParameters([{ type: 'uint256' }, { type: 'bytes' }], revertLog.data)
    reason = describeInnerRevert(revertReason)
  }

  const paymaster = topicToAddress(event.topics[3])
  return {
    userOpHash: hash,
    entryPoint: stored.entryPoint,
    sender: topicToAddress(event.topics[2]),
    nonce: toHex(nonce),
    ...(paymaster !== zeroAddress ? { paymaster } : {}),
    actualGasCost: toHex(actualGasCost),
    actualGasUsed: toHex(actualGasUsed),
    success,
    ...(reason !== undefined ? { reason } : {}),
    logs: opLogs,
    receipt,
  }
}
