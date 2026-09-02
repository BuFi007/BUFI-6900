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

import { ethers, FetchRequest } from "ethers";
import _ from "lodash";
import { http } from "viem";
import logger, { logAndExit } from "./logger.js";

export const getEnvValue = (envVarName: string) => {
  const val = process.env[envVarName]?.trim();
  
  if (!val) {
    logAndExit(`No ${envVarName} env var provided.`);
  }

  logger.info(`${envVarName} provided: ${val}`);
  return val!;
}

// Helper function to get option value or environment variable
export const getOptionValue = (options: any, optionName: string, envVarName: string) => {
  const val = options[optionName] || process.env[envVarName] || null;

  if (!val) {
    logAndExit(`No ${optionName} command line arg or ${envVarName} env var provided.`);
  }

  logger.info(`${optionName} provided: ${val}`);
  return val;
};

// BUFI: like getOptionValue, but never echoes the value (private keys).
export const getSecretOptionValue = (options: any, optionName: string, envVarName: string) => {
  const val = options[optionName] || process.env[envVarName]?.trim() || null;

  if (!val) {
    logAndExit(`No ${optionName} command line arg or ${envVarName} env var provided.`);
  }

  logger.info(`${optionName} provided: <redacted>`);
  return val;
};

export const equalsIgnoreCase = (str1: string, str2: string) => {
  return _.isEqual(str1.toLowerCase(), str2.toLowerCase());
};

export const maxBigInt = (a: bigint, b: bigint) : bigint => {
  return (a > b) ? a : b;
};

export const isAlchemyBundler = (bundlerUrl: string | undefined): boolean => !!bundlerUrl && bundlerUrl.includes('alchemy');

// BUFI: optional `Authorization: Bearer <BUNDLER_BEARER_TOKEN>` on every bundler/RPC request. The @bufi/mock-circle
// sandbox requires it (any non-empty key); hosted bundlers that key by URL leave it unset.
export const getBundlerAuthHeaders = (): Record<string, string> => {
  const token = process.env.BUNDLER_BEARER_TOKEN?.trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
};

// viem transport for the bundler URL, carrying the auth header when configured.
export const bundlerHttp = (bundlerRPCUrl: string) =>
  http(bundlerRPCUrl, { fetchOptions: { headers: getBundlerAuthHeaders() } });

// ethers provider for the bundler URL, carrying the auth header when configured.
export const bundlerJsonRpcProvider = (bundlerRPCUrl: string): ethers.JsonRpcProvider => {
  const request = new FetchRequest(bundlerRPCUrl);
  for (const [name, value] of Object.entries(getBundlerAuthHeaders())) {
    request.setHeader(name, value);
  }
  return new ethers.JsonRpcProvider(request);
};
