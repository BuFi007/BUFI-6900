/*
 * @bufi/mock-circle — ERC-7677 `pm_getPaymasterStubData` / `pm_getPaymasterData` for Circle's SponsorPaymaster.
 *
 * paymasterAndData layout (SponsorPaymaster.parsePaymasterAndData):
 *   [0:20]    paymaster address                       ┐ packed by the SDK / viem from
 *   [20:36]   uint128 paymasterVerificationGasLimit   │ `paymaster` + the two gas limits
 *   [36:52]   uint128 paymasterPostOpGasLimit         ┘
 *   [52:116]  abi.encode(uint48 validUntil, uint48 validAfter)  ┐ = `paymasterData`
 *   [116:]    65-byte ECDSA signature                            ┘   returned here
 * The signature is over `toEthSignedMessageHash(getHash(userOp, verGas, postOpGas, validUntil, validAfter))`,
 * where getHash = keccak256(abi.encode(packUpToPaymasterAndData(userOp), verGas, postOpGas, chainId, paymaster,
 * validUntil, validAfter)) — read straight from the deployed contract via eth_call so the layout can never drift.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import { concatHex, encodeAbiParameters, getAddress, isAddress, toHex, type Address, type Hex } from 'viem'

import { sponsorPaymasterAbi } from '../abi.ts'
import { DEFAULT_GAS_LIMITS, SPONSOR_NAME } from '../config.ts'
import { packUserOperation, parseRpcUserOperation, type RpcUserOperationV07 } from '../userop.ts'
import type { RpcContext } from './context.ts'
import { invalidParams, JsonRpcError, RPC_ERROR } from './errors.ts'
import type { PaymasterDataResponse } from './types.ts'

const STUB_SIGNATURE: Hex = `0x${'ff'.repeat(64)}1c`

function requirePaymaster(ctx: RpcContext): { address: Address; signer: Address } {
  if (!ctx.deployment.paymaster) {
    throw new JsonRpcError(RPC_ERROR.PAYMASTER_REJECTED, 'no SponsorPaymaster in this deployment')
  }
  return ctx.deployment.paymaster
}

/** `[userOp, entryPoint, chainId, context]` per ERC-7677. */
function parsePaymasterParams(ctx: RpcContext, params: unknown[]): RpcUserOperationV07 {
  const op = parseRpcUserOperation(params[0])
  const entryPoint = params[1]
  if (entryPoint !== undefined && entryPoint !== null) {
    if (typeof entryPoint !== 'string' || !isAddress(entryPoint)) throw invalidParams('entryPoint must be an address')
    if (getAddress(entryPoint) !== getAddress(ctx.deployment.entryPoint)) {
      throw invalidParams(`unsupported EntryPoint ${entryPoint} (sandbox serves ${ctx.deployment.entryPoint})`)
    }
  }
  const chainId = params[2]
  if (chainId !== undefined && chainId !== null) {
    const parsed = typeof chainId === 'string' || typeof chainId === 'number' ? Number(chainId) : Number.NaN
    if (!Number.isFinite(parsed)) throw invalidParams('chainId must be a hex or decimal number')
    if (parsed !== ctx.chain.id) throw invalidParams(`chainId ${parsed} does not match the sandbox chain ${ctx.chain.id}`)
  }
  return op
}

async function validityWindow(ctx: RpcContext): Promise<{ validUntil: number; validAfter: number }> {
  if (ctx.paymasterValiditySecs <= 0) return { validUntil: 0, validAfter: 0 }
  const block = await ctx.publicClient.getBlock({ blockTag: 'latest' })
  return { validUntil: Number(block.timestamp) + ctx.paymasterValiditySecs, validAfter: 0 }
}

function encodeValidity(validUntil: number, validAfter: number): Hex {
  return encodeAbiParameters([{ type: 'uint48' }, { type: 'uint48' }], [validUntil, validAfter])
}

export async function pmGetPaymasterStubData(ctx: RpcContext, params: unknown[]): Promise<PaymasterDataResponse> {
  parsePaymasterParams(ctx, params)
  const paymaster = requirePaymaster(ctx)
  const { validUntil, validAfter } = await validityWindow(ctx)
  return {
    paymaster: paymaster.address,
    paymasterData: concatHex([encodeValidity(validUntil, validAfter), STUB_SIGNATURE]),
    paymasterVerificationGasLimit: toHex(DEFAULT_GAS_LIMITS.paymasterVerificationGasLimit),
    paymasterPostOpGasLimit: toHex(DEFAULT_GAS_LIMITS.paymasterPostOpGasLimit),
    sponsor: { name: SPONSOR_NAME },
    isFinal: false,
  }
}

/** Sponsors every op it is asked about (a sandbox has no policy), signing with the paymaster's verifying key. */
export async function pmGetPaymasterData(ctx: RpcContext, params: unknown[]): Promise<PaymasterDataResponse> {
  const op = parsePaymasterParams(ctx, params)
  const paymaster = requirePaymaster(ctx)
  for (const field of ['verificationGasLimit', 'callGasLimit', 'preVerificationGas', 'maxFeePerGas', 'maxPriorityFeePerGas'] as const) {
    if (op[field] === undefined) throw invalidParams(`userOperation.${field} is required for pm_getPaymasterData`)
  }
  const { validUntil, validAfter } = await validityWindow(ctx)
  const verificationGasLimit = DEFAULT_GAS_LIMITS.paymasterVerificationGasLimit
  const postOpGasLimit = DEFAULT_GAS_LIMITS.paymasterPostOpGasLimit
  // getHash covers everything up to paymasterAndData; the paymaster fields themselves come from our own arguments.
  const packed = packUserOperation({
    ...op,
    paymaster: undefined,
    paymasterData: undefined,
    paymasterVerificationGasLimit: undefined,
    paymasterPostOpGasLimit: undefined,
    paymasterAndData: undefined,
    signature: '0x',
  })
  const hash = await ctx.publicClient.readContract({
    address: paymaster.address,
    abi: sponsorPaymasterAbi,
    functionName: 'getHash',
    args: [packed, verificationGasLimit, postOpGasLimit, validUntil, validAfter],
  })
  const signature = await ctx.paymasterSigner.signMessage({ message: { raw: hash } })
  ctx.log(`pm_getPaymasterData sponsoring ${op.sender} nonce ${op.nonce} (validUntil ${validUntil || '∞'})`)
  return {
    paymaster: paymaster.address,
    paymasterData: concatHex([encodeValidity(validUntil, validAfter), signature]),
    paymasterVerificationGasLimit: toHex(verificationGasLimit),
    paymasterPostOpGasLimit: toHex(postOpGasLimit),
    sponsor: { name: SPONSOR_NAME },
    isFinal: true,
  }
}
