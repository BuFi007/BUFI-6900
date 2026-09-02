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

// Scenario `session-key-transfer`: an ERC-20 transfer from the MSCA signed by a BufiSessionKeyPlugin session key
// (`executeWithSessionKey([{ target: token, value: 0, data: transfer(recipient, amount) }], sessionKey)`), sent
// through any ERC-4337 bundler. Mirrors token-transfer; the owner set is never involved.

import commandLineArgs from "command-line-args";
import "dotenv/config";
import readlineSync from "readline-sync";
import { getAddress, parseUnits } from "viem";

import { getERC20TransferCallData } from "./utils/blockchain.js";
import { USDCTokenAddress } from "./utils/configs.js";
import { equalsIgnoreCase, getOptionValue, getSecretOptionValue } from "./utils/helpers.js";
import logger, { logAndExit, printSectionHeader } from "./utils/logger.js";
import { buildAndSignSessionKeyUserOp, sendSessionKeyUserOp } from "./utils/sessionKey.js";
import { Address, NetworkKey, SessionKeyTransferParams, SessionKeyTransferResult } from "./utils/types.js";
import { getAndCheckBalance } from "./utils/wallet.js";

// Core of the scenario, usable programmatically (no prompts, nothing exits the process on the happy path):
// build the `executeWithSessionKey` user operation on the session key's nonce lane, estimate, sign with the session
// key, send it through the bundler and wait for the receipt.
export const executeSessionKeyTransfer = async ({
  chain,
  bundlerRPCUrl,
  walletAddress,
  sessionKeyPrivateKey,
  tokenAddress,
  recipientAddress,
  amount,
  gasFeesMultiplier,
  receiptTimeoutMs,
}: SessionKeyTransferParams): Promise<SessionKeyTransferResult> => {
  const signed = await buildAndSignSessionKeyUserOp({
    chain,
    bundlerRPCUrl,
    walletAddress,
    sessionKeyPrivateKey,
    gasFeesMultiplier,
    calls: [
      {
        target: getAddress(tokenAddress),
        value: 0n,
        data: getERC20TransferCallData({ toAddress: getAddress(recipientAddress), amount }),
      },
    ],
  });

  const sent = await sendSessionKeyUserOp({ chain, bundlerRPCUrl }, signed.userOperation, receiptTimeoutMs);

  return { ...signed, ...sent };
};

interface Options {
  broadcast?: boolean;
  token?: string;
  tokenAddress?: string;
  amount?: number;
  gasFeesMultiplier?: number;
  recipientAddress?: string;
  sessionKeyPrivateKey?: string;
  chain?: string;
  bundlerRPCUrl?: string;
  walletAddress?: string;
}

const optionDefinitions = [
  { name: "broadcast", alias: "b", type: Boolean },
  { name: "token", alias: "t", type: String },
  { name: "tokenAddress", type: String },
  { name: "amount", alias: "a", type: Number },
  { name: "gasFeesMultiplier", alias: "g", type: Number },
  { name: "recipientAddress", alias: "r", type: String },
  { name: "sessionKeyPrivateKey", alias: "k", type: String },
  { name: "chain", alias: "c", type: String },
  { name: "bundlerRPCUrl", alias: "u", type: String },
  { name: "walletAddress", alias: "w", type: String },
];

export const sessionKeyTransfer = async (argv: string[]): Promise<void> => {
  const options = commandLineArgs(optionDefinitions, { argv }) as Options;

  // Get required input vars from CLI or environment
  printSectionHeader('Inputs');

  const broadcast = String(getOptionValue(options, "broadcast", "BROADCAST_OPERATION")).toLowerCase() === "true";
  const token: string = getOptionValue(options, "token", "TOKEN");
  const transferAmount = Number(getOptionValue(options, "amount", "TRANSFER_AMOUNT"));
  const gasFeesMultiplier = Number(getOptionValue(options, "gasFeesMultiplier", "GAS_FEES_MULTIPLIER"));
  const walletAddress = getAddress(
    getOptionValue(options, "walletAddress", "MSCA_WALLET_ADDRESS")
  );
  const recipientAddress = getAddress(
    getOptionValue(options, "recipientAddress", "RECIPIENT_ADDRESS")
  );
  const sessionKeyPrivateKey = getSecretOptionValue(options, "sessionKeyPrivateKey", "SESSION_KEY_PRIVATE_KEY") as `0x${string}`;
  const chain = getOptionValue(options, "chain", "BLOCKCHAIN") as NetworkKey;
  const bundlerRPCUrl = getOptionValue(
    options,
    "bundlerRPCUrl",
    "BUNDLER_RPC_URL"
  );

  if (equalsIgnoreCase(token, "native")) {
    logAndExit("Native token transfer currently not supported.");
  }

  // TOKEN_ADDRESS / --tokenAddress overrides the chain's USDC (the sandbox token is a CREATE2 address that moves
  // with its bytecode; any other 6-decimal ERC-20 the key is allowed to spend works too).
  const tokenOverride = options.tokenAddress || process.env.TOKEN_ADDRESS?.trim();
  const tokenAddress: Address | undefined = tokenOverride
    ? getAddress(tokenOverride)
    : equalsIgnoreCase(token, "usdc")
      ? getAddress(USDCTokenAddress[chain])
      : undefined;
  if (!tokenAddress) {
    logAndExit(`Unsupported token ${token}: pass --tokenAddress / TOKEN_ADDRESS for anything other than usdc.`);
  }
  logger.info(`tokenAddress: ${tokenAddress}`);

  // Build and sign with the session key (its own nonce lane, EIP-191 over the userOpHash)
  printSectionHeader('Build User Operation');

  const signed = await buildAndSignSessionKeyUserOp({
    chain,
    bundlerRPCUrl,
    walletAddress,
    sessionKeyPrivateKey,
    gasFeesMultiplier,
    calls: [
      {
        target: tokenAddress!,
        value: 0n,
        data: getERC20TransferCallData({
          toAddress: recipientAddress,
          amount: parseUnits(String(transferAmount), 6), // USDC decimals on the contract
        }),
      },
    ],
  });
  logger.info(`Session key: ${signed.sessionKey}`);
  logger.info(`User op hash: ${signed.userOpHash}`);

  // Check the wallet balance (gas is paid by the MSCA, never by the session key)
  printSectionHeader('Check Balance');

  await getAndCheckBalance({
    bundlerRPCUrl,
    walletAddress,
    transferAmount,
    tokenAddress,
    gasFeesMultiplier,
    userOperation: signed.userOperation,
  });

  // Session key transfer
  printSectionHeader('Session Key Transfer');
  logger.info(`Sending the following userop`, signed.userOperation);

  if (broadcast) {
    // Blocks on user input to confirm to send to blockchain
    let inp = readlineSync.question(
      `Broadcast flag set. Will send user op to ${chain} blockchain. \n\n Enter "C" to continue:\n`
    );
    while (inp.toLowerCase() != "c") {
      inp = readlineSync.question(
        'Invalid input. Enter "C" to continue:\n'
      );
    }

    const result = await sendSessionKeyUserOp({ chain, bundlerRPCUrl }, signed.userOperation);
    if (result.success) {
      logger.info(`Transfer executed. Transaction hash: ${result.transactionHash}`);
    } else {
      // Included but reverted: the plugin enforces ERC-20 budgets in the execution phase, so an over-budget
      // transfer lands on-chain, reverts, and costs gas without moving funds.
      logger.error(`User operation was included in ${result.transactionHash} but the execution reverted${result.reason ? `: ${result.reason}` : ""}.`);
    }
  } else {
    logger.info(`Broadcast flag not set, so not sending user op to blockchain.`);
  }
};
