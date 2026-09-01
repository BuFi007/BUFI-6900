/*
 * Copyright (c) 2026, Circle Internet Group, Inc. All rights reserved.
 * Modifications Copyright (c) 2026 BUFI. Licensed under the Apache License, Version 2.0.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Accounts
export * from './accounts'

// Actions
export * from './actions'

// Clients
export * from './clients'

// Constants
export {
  ContractAddress,
  CIRCLE_CANONICAL_DEPLOYMENT,
  CIRCLE_COLD_STORAGE_ADDRESS_BOOK_PLUGIN,
  CIRCLE_PLUGIN_MANAGER,
  CIRCLE_WEIGHTED_WEB_AUTHN_MULTISIG_PLUGIN,
  FACTORY,
  UPGRADABLE_MSCA,
  SESSION_KEY_STUB_SIGNATURE,
  WEIGHTED_MULTISIG_OWNER_USER_OP_VALIDATION_FUNCTION_ID,
  WEIGHTED_MULTISIG_UNIMPLEMENTED_RUNTIME_VALIDATION_FUNCTION_ID,
} from './constants'

// Cascade (BUFI)
export * from './cascade'

// Providers
export * from './providers'

// Utils
export {
  computeAddress,
  encodeTransfer,
  toReplaySafeHash,
  toStackDeployment,
  walletClientToLocalAccount,
} from './utils'

// Types
export {
  OwnerIdentifierType,
  WebAuthnMode,
  AccountType,
  ContractAccessControlType,
  type BufiGrant,
  type BufiGrantBudget,
  type BufiGrantErc20Budget,
  type BufiGrantExpiry,
  type BufiGrantScope,
  type BufiGrantScopeEntry,
  type BufiGrantSpendBudget,
  type BufiSessionKeyAccountImplementation,
  type Call,
  type EarnConfigInput,
  type EncodedCall,
  type FunctionReference,
  type PluginDeployment,
  type SessionKeyRegistration,
  type SpendLimitInfo,
  type StackDeployment,
  type ToBufiSessionKeyAccountParameters,
  type ToBufiSessionKeyAccountReturnType,
  type AuthenticatorAssertionResponse,
  type AuthenticatorAttestationResponse,
  type CircleSmartAccountImplementation,
  type CreateAddressMappingReturnType,
  type CreateAddressMappingRpcSchema,
  type CreateCredentialParameters,
  type CustomPublicKeyCredentialCreationOptions,
  type CustomPublicKeyCredentialDescriptor,
  type CustomPublicKeyCredentialRequestOptions,
  type CustomPublicKeyCredentialUserEntity,
  type GetAddressReturnType,
  type GetAddressRpcSchema,
  type GetAddressMappingReturnType,
  type GetAddressMappingRpcSchema,
  type GetLoginOptionsReturnType,
  type GetLoginOptionsRpcSchema,
  type GetLoginVerificationReturnType,
  type GetLoginVerificationRpcSchema,
  type GetRegistrationOptionsReturnType,
  type GetRegistrationOptionsRpcSchema,
  type GetRegistrationVerificationReturnType,
  type GetRegistrationVerificationRpcSchema,
  type ModularWalletRpcSchema,
  type RpRpcSchema,
  type ToCircleSmartAccountParameters,
  type ToCircleSmartAccountReturnType,
  type ToWebAuthnAccountParameters,
  type WebAuthnCredential,
} from './types'
