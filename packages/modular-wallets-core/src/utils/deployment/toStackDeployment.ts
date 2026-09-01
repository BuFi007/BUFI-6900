/*
 * Copyright (c) 2026, BUFI. All rights reserved.
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

import { isAddress, isHash } from 'viem'

import type { PluginDeployment, StackDeployment } from '../../types'
import type { Hex } from 'viem'

type JsonRecord = Record<string, unknown>

/**
 * Checks whether a value is a JSON object.
 * @param value - The value to check.
 * @returns True if the value is a non-null, non-array object.
 */
function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Reads a required 20-byte address field.
 * @param record - The object to read from.
 * @param path - The dotted path of the field, used in error messages.
 * @param key - The key to read.
 * @returns The address.
 * @throws Error if the field is missing or not an address.
 */
function readAddress(record: JsonRecord, path: string, key: string): Hex {
  const value = record[key]
  if (typeof value !== 'string' || !isAddress(value, { strict: false })) {
    throw new Error(
      `Invalid stack deployment: "${path}${key}" must be a 20-byte hex address.`,
    )
  }
  return value
}

/**
 * Reads a required 32-byte hash field.
 * @param record - The object to read from.
 * @param path - The dotted path of the field, used in error messages.
 * @param key - The key to read.
 * @returns The hash.
 * @throws Error if the field is missing or not a 32-byte hex string.
 */
function readHash(record: JsonRecord, path: string, key: string): Hex {
  const value = record[key]
  if (typeof value !== 'string' || !isHash(value)) {
    throw new Error(
      `Invalid stack deployment: "${path}${key}" must be a 32-byte hex string.`,
    )
  }
  return value
}

/**
 * Reads a plugin entry (`{ address, manifestHash }`).
 * @param value - The entry to read.
 * @param path - The dotted path of the entry, used in error messages.
 * @returns The plugin deployment.
 * @throws Error if the entry is malformed.
 */
function readPlugin(value: unknown, path: string): PluginDeployment {
  if (!isRecord(value)) {
    throw new Error(
      `Invalid stack deployment: "${path}" must be an object with "address" and "manifestHash".`,
    )
  }
  return {
    address: readAddress(value, `${path}.`, 'address'),
    manifestHash: readHash(value, `${path}.`, 'manifestHash'),
  }
}

/**
 * Reads an optional plugin entry, which may be absent or `null`.
 * @param value - The entry to read.
 * @param path - The dotted path of the entry, used in error messages.
 * @returns The plugin deployment, or undefined when absent.
 */
function readOptionalPlugin(
  value: unknown,
  path: string,
): PluginDeployment | undefined {
  if (value === undefined || value === null) return undefined
  return readPlugin(value, path)
}

/**
 * Validates and loads a sandbox stack deployment file into a {@link StackDeployment}.
 *
 * The expected shape is the JSON written by the `contracts/` deploy script and served by the mock Circle API:.
 *
 * ```json
 * {
 *   "chainId": 31337,
 *   "rpcUrl": "http://127.0.0.1:8545",
 *   "entryPoint": "0x…",
 *   "create2Deployer": "0x…",
 *   "pluginManager": "0x…",
 *   "upgradableMscaFactory": "0x…",
 *   "upgradableMscaImpl": "0x…",
 *   "plugins": {
 *     "weightedWebauthnMultisig": { "address": "0x…", "manifestHash": "0x…" },
 *     "coldStorageAddressBook": { "address": "0x…", "manifestHash": "0x…" },
 *     "bufiSessionKey": { "address": "0x…", "manifestHash": "0x…" } | null,
 *     "bufiEarnModule": { "address": "0x…", "manifestHash": "0x…" } | null
 *   },
 *   "paymaster": { "address": "0x…", "signer": "0x…" } | null,
 *   "tokens": { "usdc": "0x…" },
 *   "accounts": { "deployer": "0x…", "bundler": "0x…", "factoryOwner": "0x…" }
 * }
 * ```
 *
 * Fields the SDK does not need (`rpcUrl`, `create2Deployer`, `accounts`, the paymaster signer) are ignored.
 * @param json - The parsed deployment file.
 * @returns The stack deployment.
 * @throws Error if the file does not match the expected shape.
 */
export function toStackDeployment(json: unknown): StackDeployment {
  if (!isRecord(json)) {
    throw new Error('Invalid stack deployment: expected a JSON object.')
  }

  const chainId = json.chainId
  if (
    chainId !== undefined &&
    (typeof chainId !== 'number' || !Number.isInteger(chainId) || chainId <= 0)
  ) {
    throw new Error(
      'Invalid stack deployment: "chainId" must be a positive integer.',
    )
  }

  const plugins = json.plugins
  if (!isRecord(plugins)) {
    throw new Error('Invalid stack deployment: "plugins" must be an object.')
  }

  const paymaster = json.paymaster
  if (paymaster !== undefined && paymaster !== null && !isRecord(paymaster)) {
    throw new Error(
      'Invalid stack deployment: "paymaster" must be an object or null.',
    )
  }

  const tokens = json.tokens
  if (tokens !== undefined && !isRecord(tokens)) {
    throw new Error('Invalid stack deployment: "tokens" must be an object.')
  }

  const deployment: StackDeployment = {
    entryPoint: readAddress(json, '', 'entryPoint'),
    upgradableMscaFactory: readAddress(json, '', 'upgradableMscaFactory'),
    upgradableMsca: readAddress(json, '', 'upgradableMscaImpl'),
    pluginManager: readAddress(json, '', 'pluginManager'),
    weightedWebauthnMultisig: readPlugin(
      plugins.weightedWebauthnMultisig,
      'plugins.weightedWebauthnMultisig',
    ),
    coldStorageAddressBook: readPlugin(
      plugins.coldStorageAddressBook,
      'plugins.coldStorageAddressBook',
    ),
  }

  if (chainId !== undefined) deployment.chainId = chainId

  const bufiSessionKey = readOptionalPlugin(
    plugins.bufiSessionKey,
    'plugins.bufiSessionKey',
  )
  if (bufiSessionKey) deployment.bufiSessionKey = bufiSessionKey

  const bufiEarnModule = readOptionalPlugin(
    plugins.bufiEarnModule,
    'plugins.bufiEarnModule',
  )
  if (bufiEarnModule) deployment.bufiEarnModule = bufiEarnModule

  if (isRecord(paymaster)) {
    deployment.paymaster = readAddress(paymaster, 'paymaster.', 'address')
  }

  if (isRecord(tokens)) {
    deployment.tokens = Object.fromEntries(
      Object.keys(tokens).map((symbol) => [
        symbol,
        readAddress(tokens, 'tokens.', symbol),
      ]),
    )
  }

  return deployment
}
