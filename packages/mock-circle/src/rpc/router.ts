/*
 * @bufi/mock-circle — JSON-RPC 2.0 dispatch.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import { UpstreamRpcError } from '../chain.ts'
import {
  ethEstimateUserOperationGas,
  ethGetUserOperationByHash,
  ethGetUserOperationReceipt,
  ethSendUserOperation,
  ethSupportedEntryPoints,
  PROXIED_METHODS,
  proxyToAnvil,
} from './bundler.ts'
import type { RpcContext } from './context.ts'
import { JsonRpcError, methodNotFound, RPC_ERROR } from './errors.ts'
import {
  circleCreateAddressMapping,
  circleGetAddress,
  circleGetAddressMapping,
  circleGetUserOperationGasPrice,
} from './modular.ts'
import { pmGetPaymasterData, pmGetPaymasterStubData } from './paymaster.ts'
import { rpGetLoginOptions, rpGetLoginVerification, rpGetRegistrationOptions, rpGetRegistrationVerification } from './rp.ts'

export type JsonRpcId = string | number | null

export interface JsonRpcRequest {
  jsonrpc?: string
  id?: JsonRpcId
  method: string
  params?: unknown[]
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: JsonRpcId
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

type Handler = (ctx: RpcContext, params: unknown[]) => unknown

export const HANDLERS: Record<string, Handler> = {
  circle_getAddress: circleGetAddress,
  circle_getAddressMapping: circleGetAddressMapping,
  circle_createAddressMapping: circleCreateAddressMapping,
  circle_getUserOperationGasPrice: circleGetUserOperationGasPrice,
  eth_supportedEntryPoints: ethSupportedEntryPoints,
  eth_estimateUserOperationGas: ethEstimateUserOperationGas,
  eth_sendUserOperation: ethSendUserOperation,
  eth_getUserOperationByHash: ethGetUserOperationByHash,
  eth_getUserOperationReceipt: ethGetUserOperationReceipt,
  pm_getPaymasterStubData: pmGetPaymasterStubData,
  pm_getPaymasterData: pmGetPaymasterData,
  rp_getRegistrationOptions: rpGetRegistrationOptions,
  rp_getRegistrationVerification: rpGetRegistrationVerification,
  rp_getLoginOptions: rpGetLoginOptions,
  rp_getLoginVerification: rpGetLoginVerification,
}

/** Every method the endpoint answers, for the README / health endpoint. */
export const SUPPORTED_METHODS: string[] = [...Object.keys(HANDLERS), ...PROXIED_METHODS]

export async function handleRpcRequest(ctx: RpcContext, raw: unknown): Promise<JsonRpcResponse> {
  const request = raw as Partial<JsonRpcRequest> | null
  const id: JsonRpcId = request && typeof request === 'object' && request.id !== undefined ? request.id : null
  if (!request || typeof request !== 'object' || typeof request.method !== 'string') {
    return { jsonrpc: '2.0', id, error: { code: RPC_ERROR.INVALID_REQUEST, message: 'Invalid Request: method must be a string' } }
  }
  const params = request.params === undefined ? [] : request.params
  if (!Array.isArray(params)) {
    return { jsonrpc: '2.0', id, error: { code: RPC_ERROR.INVALID_PARAMS, message: 'params must be an array' } }
  }
  try {
    const handler = HANDLERS[request.method]
    const result = handler
      ? await handler(ctx, params)
      : PROXIED_METHODS.has(request.method)
        ? await proxyToAnvil(ctx, request.method, params)
        : (() => {
            throw methodNotFound(request.method)
          })()
    return { jsonrpc: '2.0', id, result: result === undefined ? null : result }
  } catch (error) {
    const rpcError =
      error instanceof JsonRpcError
        ? error
        : error instanceof UpstreamRpcError
          ? new JsonRpcError(error.code, error.message, error.data)
          : new JsonRpcError(RPC_ERROR.INTERNAL, error instanceof Error ? error.message : String(error))
    if (!(error instanceof JsonRpcError) && !(error instanceof UpstreamRpcError)) {
      ctx.log(`${request.method} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
    }
    return { jsonrpc: '2.0', id, error: rpcError.toJSON() }
  }
}
