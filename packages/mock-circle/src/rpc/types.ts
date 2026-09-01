/*
 * @bufi/mock-circle — response shapes, mirroring `types/modularWallets.ts` / `types/rp.ts` of the Circle SDK.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import type { Address, Hex } from 'viem'

import type { RpcUserOperationV07 } from '../userop.ts'

export interface EOAIdentifier {
  address: Address
}

export interface WebAuthnIdentifier {
  /** Decimal string of the P-256 x coordinate (the SDK sends `bigint.toString()`). */
  publicKeyX: string
  publicKeyY: string
}

export interface EoaOwner extends EOAIdentifier {
  weight: number
}

export interface WebauthnOwner extends WebAuthnIdentifier {
  weight: number
}

export interface WeightedMultisig {
  owners?: EoaOwner[]
  webauthnOwners?: WebauthnOwner[]
  thresholdWeight: number
}

export interface InitialOwnershipConfiguration {
  ownershipContractAddress: Address
  weightedMultisig: WeightedMultisig
}

export interface ScaConfiguration {
  initialOwnershipConfiguration: InitialOwnershipConfiguration
  /** factory ‖ createAccount(sender, salt, initializingData) calldata. */
  initCode: Hex
}

export interface ModularWallet {
  id: string
  address: Address
  blockchain: string
  state: string
  scaCore: string
  scaConfiguration: ScaConfiguration
  createDate: string
  updateDate: string
}

export interface GetAddressParams {
  scaConfiguration: {
    initialOwnershipConfiguration: { weightedMultisig: WeightedMultisig }
    scaCore: string
  }
  metadata?: { name?: string }
}

export const OwnerIdentifierType = {
  EOA: 'EOAOWNER',
  WebAuthn: 'WEBAUTHOWNER',
} as const

export type AddressMappingOwner =
  | { type: typeof OwnerIdentifierType.EOA; identifier: EOAIdentifier }
  | { type: typeof OwnerIdentifierType.WebAuthn; identifier: WebAuthnIdentifier }

export interface AddressMappingResponse {
  id: string
  blockchain: string
  owner: AddressMappingOwner
  walletAddress: Address
  createDate: string
  updateDate: string
}

export interface GasPriceLevel {
  maxPriorityFeePerGas: Hex
  maxFeePerGas: Hex
}

export interface GetUserOperationGasPriceResponse {
  low: GasPriceLevel
  medium: GasPriceLevel
  high: GasPriceLevel
  /** verificationGasLimit the SDK uses for an already-deployed account. */
  deployed: Hex
  /** … and for a counterfactual account (initCode present). */
  notDeployed: Hex
}

export interface EstimateUserOperationGasResponse {
  preVerificationGas: Hex
  verificationGasLimit: Hex
  callGasLimit: Hex
  paymasterVerificationGasLimit?: Hex
  paymasterPostOpGasLimit?: Hex
}

export interface RpcLog {
  address: Address
  topics: Hex[]
  data: Hex
  blockNumber: Hex
  blockHash: Hex
  transactionHash: Hex
  transactionIndex: Hex
  logIndex: Hex
  removed: boolean
}

export interface RpcTransactionReceipt {
  transactionHash: Hex
  blockHash: Hex
  blockNumber: Hex
  status: Hex
  logs: RpcLog[]
  [key: string]: unknown
}

export interface UserOperationReceiptResponse {
  userOpHash: Hex
  entryPoint: Address
  sender: Address
  nonce: Hex
  paymaster?: Address
  actualGasCost: Hex
  actualGasUsed: Hex
  success: boolean
  reason?: string
  logs: RpcLog[]
  receipt: RpcTransactionReceipt
}

export interface UserOperationByHashResponse {
  userOperation: RpcUserOperationV07
  entryPoint: Address
  transactionHash: Hex
  blockHash: Hex
  blockNumber: Hex
}

export interface PaymasterDataResponse {
  paymaster: Address
  paymasterData: Hex
  paymasterVerificationGasLimit: Hex
  paymasterPostOpGasLimit: Hex
  sponsor: { name: string }
  isFinal: boolean
}

export interface StoredUserOp {
  hash: Hex
  userOperation: RpcUserOperationV07
  entryPoint: Address
  status: 'pending' | 'included' | 'failed'
  transactionHash?: Hex
  blockHash?: Hex
  blockNumber?: bigint
  error?: string
}

export interface StoredCredential {
  id: string
  username?: string
  /** base64url SPKI DER, when the browser serialised `response.publicKey` at registration. */
  publicKey?: string
  registeredAt: string
}

/* ─── rp_* (WebAuthn relying party) ─────────────────────────────────────────────────────────────── */

export interface CustomPublicKeyCredentialDescriptor {
  id: string
  type: 'public-key'
  transports?: string[]
}

export interface CustomPublicKeyCredentialRequestOptions {
  challenge: string
  rpId: string
  timeout: number
  userVerification: 'required' | 'preferred' | 'discouraged'
  allowCredentials?: CustomPublicKeyCredentialDescriptor[]
}

export interface CustomPublicKeyCredentialCreationOptions {
  rp: { name: string; id: string }
  user: { id: string; name: string; displayName: string }
  challenge: string
  pubKeyCredParams: Array<{ type: 'public-key'; alg: number }>
  timeout: number
  attestation: 'none'
  authenticatorSelection: {
    requireResidentKey: boolean
    residentKey: 'required' | 'preferred' | 'discouraged'
    userVerification: 'required' | 'preferred' | 'discouraged'
  }
}
