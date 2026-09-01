/*
 * @bufi/mock-circle — JSON-RPC 2.0 + ERC-4337 error codes.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const RPC_ERROR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  UNAUTHORIZED: -32001,
  /** ERC-4337: rejected by the EntryPoint's validation (AA1x/AA2x …). */
  ENTRYPOINT_REJECTED: -32500,
  /** ERC-4337: rejected because of the paymaster (AA3x). */
  PAYMASTER_REJECTED: -32501,
  /** ERC-4337: invalid account or paymaster signature (AA24 / AA34). */
  INVALID_SIGNATURE: -32507,
  /** ERC-4337: execution reverted (eth_call style). */
  EXECUTION_REVERTED: -32521,
} as const

export class JsonRpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message)
    this.name = 'JsonRpcError'
  }

  toJSON() {
    return { code: this.code, message: this.message, ...(this.data !== undefined ? { data: this.data } : {}) }
  }
}

export function invalidParams(message: string, data?: unknown): JsonRpcError {
  return new JsonRpcError(RPC_ERROR.INVALID_PARAMS, message, data)
}

export function methodNotFound(method: string): JsonRpcError {
  return new JsonRpcError(RPC_ERROR.METHOD_NOT_FOUND, `Method not found: ${method}`)
}

export function internalError(message: string, data?: unknown): JsonRpcError {
  return new JsonRpcError(RPC_ERROR.INTERNAL, message, data)
}
