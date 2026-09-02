/**
 * Copyright 2026 BUFI. All rights reserved.
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

// BUFI: drive an MSCA through BufiSessionKeyPlugin with a session key instead of the owner set.
//
// The plugin installs `executeWithSessionKey(Call[] calls, address sessionKey)` on the account. The session key
// signs the userOpHash as an EIP-191 personal message (65-byte ECDSA); the plugin recovers
// `ECDSA.recover(toEthSignedMessageHash(userOpHash))` and compares it with the `sessionKey` argument carried in the
// calldata. Everything else is the same permissionless 0.1.x / viem plumbing token-transfer uses.

import { createBundlerClient, ENTRYPOINT_ADDRESS_V07, getAccountNonce, sendUserOperation, UserOperation } from "permissionless";
import { createPublicClient, encodeFunctionData, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readContract } from "viem/actions";

import { BufiSessionKeyPluginABI } from "../abi/index.js";
import { estimateUserOp, getUserOpHash } from "./blockchain.js";
import { ViemChain } from "./configs.js";
import { bundlerHttp } from "./helpers.js";
import logger, { formatUserOperation } from "./logger.js";
import {
  Address,
  BundlerParams,
  SessionKeyCall,
  SessionKeyInfo,
  SessionKeysReadParams,
  SessionKeyUserOpParams,
  SignedSessionKeyUserOp,
  SpendLimitInfo,
} from "./types.js";

// A single recoverable 65-byte ECDSA chunk (aa-sdk's dummy) for gas estimation. It must recover to SOME address:
// the plugin reverts on a malformed signature and only returns SIG_VALIDATION_FAILED on a mismatch, which is what
// bundlers tolerate during estimation.
export const SESSION_KEY_DUMMY_SIGNATURE =
  "0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c" as const;

const SEQUENCE_MASK = (1n << 64n) - 1n;

// ERC-4337 v0.7 nonce = (uint192 key << 64) | uint64 sequence. BufiSessionKeyPlugin
// (SessionKeyPermissions._checkUserOpPermissions) fails validation for a GAS-LIMITED key unless
// `uint192(nonce >> 64) == uint192(uint160(sessionKey))`, so gas accounting cannot be dodged by nonce-key hopping.
// Every session-key user operation here uses that key: one nonce lane per session key, whether or not it is gas-limited.
export const getSessionKeyNonceKey = (sessionKey: Address): bigint => BigInt(getAddress(sessionKey));

export const getSessionKeySequence = (nonce: bigint): bigint => nonce & SEQUENCE_MASK;

export const createSessionKeyBundlerClient = ({ chain, bundlerRPCUrl }: BundlerParams) =>
  createBundlerClient({
    chain: ViemChain[chain],
    transport: bundlerHttp(bundlerRPCUrl),
    entryPoint: ENTRYPOINT_ADDRESS_V07,
  });

// `EntryPoint.getNonce(account, uint192(sessionKey))` — the next nonce on the session key's lane.
export const getSessionKeyNonce = async (
  { chain, bundlerRPCUrl }: BundlerParams,
  walletAddress: Address,
  sessionKey: Address,
): Promise<bigint> => {
  const client = createSessionKeyBundlerClient({ chain, bundlerRPCUrl });
  return getAccountNonce(client, {
    sender: walletAddress,
    entryPoint: ENTRYPOINT_ADDRESS_V07,
    key: getSessionKeyNonceKey(sessionKey),
  });
};

// Raw user operation calldata: `executeWithSessionKey(calls, sessionKey)` on the account (never wrapped in execute()).
export const getExecuteWithSessionKeyCallData = (calls: SessionKeyCall[], sessionKey: Address): `0x${string}` =>
  encodeFunctionData({
    abi: BufiSessionKeyPluginABI,
    functionName: "executeWithSessionKey",
    args: [calls, sessionKey],
  });

export const buildAndSignSessionKeyUserOp = async ({
  chain,
  bundlerRPCUrl,
  walletAddress,
  sessionKeyPrivateKey,
  calls,
  gasFeesMultiplier,
}: SessionKeyUserOpParams): Promise<SignedSessionKeyUserOp> => {
  const sessionKey = privateKeyToAccount(sessionKeyPrivateKey);
  const callData = getExecuteWithSessionKeyCallData(calls, sessionKey.address);

  const nonce = await getSessionKeyNonce({ chain, bundlerRPCUrl }, walletAddress, sessionKey.address);
  logger.debug(`Session key ${sessionKey.address}: nonce key ${getSessionKeyNonceKey(sessionKey.address)}, sequence ${getSessionKeySequence(nonce)}`);

  const partialUserOp: UserOperation<"v0.7"> = {
    sender: walletAddress,
    nonce,
    callData,
    maxPriorityFeePerGas: 0n,
    maxFeePerGas: 0n,
    callGasLimit: 0n,
    verificationGasLimit: 0n,
    preVerificationGas: 0n,
    signature: "0x",
  };
  logger.debug(`partialSessionKeyUserOp: ${formatUserOperation(partialUserOp)}`);

  const userOpWithGas = await estimateUserOp({
    chain,
    bundlerRPCUrl,
    userOp: partialUserOp,
    numSigners: 1,
    gasFeesMultiplier,
    dummySignature: SESSION_KEY_DUMMY_SIGNATURE,
  });

  // Hash from the deployed EntryPoint (the gas fields are in it, so the signature covers the final limits).
  const userOpHash = await getUserOpHash({ chain, bundlerRPCUrl, userOp: userOpWithGas }, ENTRYPOINT_ADDRESS_V07);

  // EIP-191 personal_sign over the raw 32-byte hash — what `toEthSignedMessageHash(userOpHash)` recovers.
  const signature = await sessionKey.signMessage({ message: { raw: userOpHash } });

  const userOperation: UserOperation<"v0.7"> = { ...userOpWithGas, signature };
  logger.debug(`sessionKeyUserOp: ${formatUserOperation(userOperation)}`);

  return { sessionKey: sessionKey.address, userOperation, userOpHash };
};

export const sendSessionKeyUserOp = async (
  { chain, bundlerRPCUrl }: BundlerParams,
  userOperation: UserOperation<"v0.7">,
  receiptTimeoutMs = 180_000,
) => {
  const client = createSessionKeyBundlerClient({ chain, bundlerRPCUrl });

  const userOpHash = await sendUserOperation(client, {
    entryPoint: ENTRYPOINT_ADDRESS_V07,
    userOperation,
  });
  logger.info(`User Operation sent with user op hash: ${userOpHash}. Awaiting for transaction hash receipt...`);

  const receipt = await client.waitForUserOperationReceipt({ hash: userOpHash, timeout: receiptTimeoutMs });
  logger.info(`User Operation included in transaction ${receipt.receipt.transactionHash} (success: ${receipt.success})`);

  return {
    userOpHash,
    transactionHash: receipt.receipt.transactionHash,
    success: receipt.success,
    reason: receipt.reason,
  };
};

const toSpendLimitInfo = (info: {
  hasLimit: boolean;
  limit: bigint;
  limitUsed: bigint;
  refreshInterval: number;
  lastUsedTime: number;
}): SpendLimitInfo => ({
  hasLimit: info.hasLimit,
  limit: info.limit,
  limitUsed: info.limitUsed,
  refreshInterval: Number(info.refreshInterval),
  lastUsedTime: Number(info.lastUsedTime),
});

// Loupe reads on the plugin itself (`sessionKeysOf`, `getKeyTimeRange`, `getERC20SpendLimitInfo`, …) — these are
// NOT installed on the account, so they are called on the plugin with the account as first argument.
export const readSessionKeys = async ({
  chain,
  bundlerRPCUrl,
  walletAddress,
  pluginAddress,
  tokenAddress,
}: SessionKeysReadParams): Promise<SessionKeyInfo[]> => {
  const client = createPublicClient({
    chain: ViemChain[chain],
    transport: bundlerHttp(bundlerRPCUrl),
  });
  const plugin = { address: pluginAddress, abi: BufiSessionKeyPluginABI } as const;

  const sessionKeys = await readContract(client, {
    ...plugin,
    functionName: "sessionKeysOf",
    args: [walletAddress],
  });

  return Promise.all(
    sessionKeys.map(async (sessionKey): Promise<SessionKeyInfo> => {
      const [timeRange, accessControlType, nativeTokenLimit, gasSpendLimit, requiredPaymaster] = await Promise.all([
        readContract(client, { ...plugin, functionName: "getKeyTimeRange", args: [walletAddress, sessionKey] }),
        readContract(client, { ...plugin, functionName: "getAccessControlType", args: [walletAddress, sessionKey] }),
        readContract(client, { ...plugin, functionName: "getNativeTokenSpendLimitInfo", args: [walletAddress, sessionKey] }),
        readContract(client, { ...plugin, functionName: "getGasSpendLimit", args: [walletAddress, sessionKey] }),
        readContract(client, { ...plugin, functionName: "getRequiredPaymaster", args: [walletAddress, sessionKey] }),
      ]);

      const erc20Limit = tokenAddress
        ? {
            token: tokenAddress,
            ...toSpendLimitInfo(
              await readContract(client, {
                ...plugin,
                functionName: "getERC20SpendLimitInfo",
                args: [walletAddress, sessionKey, tokenAddress],
              }),
            ),
          }
        : undefined;

      return {
        sessionKey,
        validAfter: Number(timeRange[0]),
        validUntil: Number(timeRange[1]),
        accessControlType,
        nativeTokenLimit: toSpendLimitInfo(nativeTokenLimit),
        gasLimit: toSpendLimitInfo(gasSpendLimit[0]),
        gasLimitShouldReset: gasSpendLimit[1],
        requiredPaymaster,
        erc20Limit,
      };
    }),
  );
};
