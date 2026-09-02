/**
 * Copyright 2024 Circle Internet Group, Inc.  All rights reserved.
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
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import { UserOperation } from "permissionless";

// Union type for supported network keys
export type NetworkKey = 
  | "POLYGON"
  | "POLYGON-AMOY"
  | "ETH"
  | "ETH-SEPOLIA"
  | "ARB"
  | "ARB-SEPOLIA"
  // BUFI: local mock-circle sandbox (anvil) and the two testnets carrying the BUFI plugins.
  | "LOCAL-SANDBOX"
  | "AVAX-FUJI"
  | "ARC-TESTNET";

// Type for addresses formatted as 0x{string}
export type Address = `0x${string}`;

// Unified type for mapping chain names to addresses
export type ChainAddressMap = {
  [key in NetworkKey]: Address;
};

export type ViemChainMap = {
  [key in NetworkKey]: any;
};

export type Signer = {
  address: Address;
  privateKey?: string;
};  

export interface SignMessageParams {
  chain: NetworkKey;
  signer: Signer;
  message: string;
  walletConnectProjectId: string;
};

export interface BundlerParams {
  chain: NetworkKey;
  bundlerRPCUrl: string;
};

export interface UserOpParams extends BundlerParams {
  userOp: UserOperation<"v0.7">;
};

export interface UserOpEstimateParams extends UserOpParams {
  numSigners: number;
  gasFeesMultiplier: number;
  // BUFI: replaces the weighted-multisig dummy signature during estimation (a session key signs one 65-byte ECDSA chunk).
  dummySignature?: `0x${string}`;
};

export interface MultiSigParams {
  chain: NetworkKey;
  bundlerRPCUrl: string;
  walletConnectProjectId: string;
  walletAddress: Address;
  signerAddresses: Signer[];
  gasFeesMultiplier: number;
  callData: `0x${string}`;
};

export interface MultiSigUserOpParams {
  userOp: UserOperation<"v0.7">;
  signatures: Array<{ signer: `0x${string}`; signature: string; userOpSigType?: string }>;
};

export interface GetPartialUserOpParams extends BundlerParams {
  senderAddress: Address;
  callData: `0x${string}`;
};

export interface ERC20TransferParams {
  toAddress: Address;
  amount: bigint;
};

// ─── BUFI: session-key scenarios ─────────────────────────────────────────────

// One element of the `Call[]` batch `executeWithSessionKey` runs through the account.
export interface SessionKeyCall {
  target: Address;
  value: bigint;
  data: `0x${string}`;
};

export interface SessionKeyUserOpParams extends BundlerParams {
  walletAddress: Address;
  sessionKeyPrivateKey: `0x${string}`;
  calls: SessionKeyCall[];
  gasFeesMultiplier: number;
};

export interface SignedSessionKeyUserOp {
  sessionKey: Address;
  userOperation: UserOperation<"v0.7">;
  userOpHash: `0x${string}`;
};

export interface SessionKeyTransferParams extends BundlerParams {
  walletAddress: Address;
  sessionKeyPrivateKey: `0x${string}`;
  tokenAddress: Address;
  recipientAddress: Address;
  amount: bigint;
  gasFeesMultiplier: number;
  // Bundler receipt polling budget; defaults to 3 minutes like the upstream token-transfer loop.
  receiptTimeoutMs?: number;
};

export interface SessionKeyTransferResult extends SignedSessionKeyUserOp {
  transactionHash: `0x${string}`;
  success: boolean;
  reason?: string;
};

export interface SpendLimitInfo {
  hasLimit: boolean;
  limit: bigint;
  limitUsed: bigint;
  refreshInterval: number;
  lastUsedTime: number;
};

export interface SessionKeyInfo {
  sessionKey: Address;
  validAfter: number;
  validUntil: number;
  // 0 = ALLOWLIST, 1 = DENYLIST, 2 = ALLOW_ALL_ACCESS (IBufiSessionKeyPlugin.ContractAccessControlType)
  accessControlType: number;
  nativeTokenLimit: SpendLimitInfo;
  gasLimit: SpendLimitInfo;
  gasLimitShouldReset: boolean;
  requiredPaymaster: Address;
  // Present when a token address was supplied to the read.
  erc20Limit?: SpendLimitInfo & { token: Address };
};

export interface SessionKeysReadParams extends BundlerParams {
  walletAddress: Address;
  pluginAddress: Address;
  tokenAddress?: Address;
};
