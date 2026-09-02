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

// Scenario `session-keys`: read-only listing of the session keys registered on an MSCA through
// BufiSessionKeyPlugin — time range, access-list mode, native/gas limits and the ERC-20 limit for one token —
// via the plugin's loupe getters. Nothing is signed or sent.

import commandLineArgs from "command-line-args";
import "dotenv/config";
import { getAddress } from "viem";

import { BufiSessionKeyPluginAddress, USDCTokenAddress } from "./utils/configs.js";
import { getOptionValue } from "./utils/helpers.js";
import logger, { logAndExit, printSectionHeader } from "./utils/logger.js";
import { readSessionKeys } from "./utils/sessionKey.js";
import { NetworkKey, SessionKeyInfo, SessionKeysReadParams, SpendLimitInfo } from "./utils/types.js";

export const listSessionKeys = (params: SessionKeysReadParams): Promise<SessionKeyInfo[]> => readSessionKeys(params);

const ACCESS_CONTROL_TYPES = ["ALLOWLIST", "DENYLIST", "ALLOW_ALL_ACCESS"];

const formatTimestamp = (timestamp: number, unset: string): string =>
  timestamp === 0 ? unset : `${new Date(timestamp * 1000).toISOString()} (${timestamp})`;

const formatSpendLimit = (info: SpendLimitInfo): string =>
  info.hasLimit
    ? `${info.limitUsed} / ${info.limit} used` +
      (info.refreshInterval > 0
        ? `, refreshes every ${info.refreshInterval}s (last used ${formatTimestamp(info.lastUsedTime, "never")})`
        : ", never refreshes")
    : "no limit";

const optionDefinitions = [
  { name: "chain", alias: "c", type: String },
  { name: "bundlerRPCUrl", alias: "u", type: String },
  { name: "walletAddress", alias: "w", type: String },
  { name: "pluginAddress", alias: "p", type: String },
  { name: "tokenAddress", alias: "t", type: String },
];

export const sessionKeys = async (argv: string[]): Promise<void> => {
  const options = commandLineArgs(optionDefinitions, { argv });

  printSectionHeader('Inputs');

  const chain = getOptionValue(options, "chain", "BLOCKCHAIN") as NetworkKey;
  const bundlerRPCUrl = getOptionValue(options, "bundlerRPCUrl", "BUNDLER_RPC_URL");
  const walletAddress = getAddress(getOptionValue(options, "walletAddress", "MSCA_WALLET_ADDRESS"));

  const pluginOverride = options.pluginAddress || process.env.SESSION_KEY_PLUGIN_ADDRESS?.trim() || BufiSessionKeyPluginAddress[chain];
  if (!pluginOverride) {
    logAndExit(`No SESSION_KEY_PLUGIN_ADDRESS env var provided and no default BufiSessionKeyPlugin is known for ${chain}.`);
  }
  const pluginAddress = getAddress(pluginOverride!);
  logger.info(`pluginAddress: ${pluginAddress}`);

  const tokenAddress = getAddress(options.tokenAddress || process.env.TOKEN_ADDRESS?.trim() || USDCTokenAddress[chain]);
  logger.info(`tokenAddress: ${tokenAddress}`);

  printSectionHeader('Session Keys');

  const keys = await listSessionKeys({ chain, bundlerRPCUrl, walletAddress, pluginAddress, tokenAddress });
  if (keys.length === 0) {
    logger.info(`No session keys registered on ${walletAddress} through ${pluginAddress}.`);
    return;
  }

  keys.forEach((key, index) => {
    logger.info(`[${index + 1}/${keys.length}] ${key.sessionKey}`);
    logger.info(`  valid after:        ${formatTimestamp(key.validAfter, "no lower bound")}`);
    logger.info(`  valid until:        ${formatTimestamp(key.validUntil, "no expiry")}`);
    logger.info(`  access list:        ${ACCESS_CONTROL_TYPES[key.accessControlType] ?? key.accessControlType}`);
    if (key.erc20Limit) {
      logger.info(`  ERC-20 ${key.erc20Limit.token}: ${formatSpendLimit(key.erc20Limit)}`);
    }
    logger.info(`  native token limit: ${formatSpendLimit(key.nativeTokenLimit)}`);
    logger.info(`  gas limit:          ${formatSpendLimit(key.gasLimit)}${key.gasLimitShouldReset ? " — STUCK: call resetSessionKeyGasLimitTimestamp before use" : ""}`);
    logger.info(`  required paymaster: ${key.requiredPaymaster === "0x0000000000000000000000000000000000000000" ? "none" : key.requiredPaymaster}`);
  });
};
