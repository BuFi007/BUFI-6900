/*
 * @bufi/mock-circle — ERC-6900 v0.7 plugin manifest hashes.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import { keccak256, type Address, type Hex, type PublicClient } from 'viem'

import { PLUGIN_MANIFEST_SELECTOR } from './abi.ts'

/**
 * `keccak256(abi.encode(plugin.pluginManifest()))` — exactly what UpgradableMSCA / PluginManager compare
 * against at install time.
 *
 * The raw return data of `pluginManifest() returns (PluginManifest memory)` IS `abi.encode(manifest)`:
 * the ABI encodes a single struct return value as a one-element tuple (head offset 0x20 + struct body), which is
 * byte-for-byte what `abi.encode(structValue)` produces. So hashing the return data needs no re-encoding of
 * the (deeply nested, dynamic) PluginManifest struct — and `deploy.test.ts` pins the result to the two hashes
 * Circle publishes for its production plugins.
 */
export async function getManifestHash(publicClient: PublicClient, plugin: Address): Promise<Hex> {
  const { data } = await publicClient.call({ to: plugin, data: PLUGIN_MANIFEST_SELECTOR })
  if (!data || data === '0x') throw new Error(`${plugin}: pluginManifest() returned no data`)
  return keccak256(data)
}
