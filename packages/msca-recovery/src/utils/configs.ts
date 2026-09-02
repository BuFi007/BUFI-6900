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

import {
  arbitrum,
  arbitrumSepolia,
  arcTestnet,
  avalancheFuji,
  foundry,
  mainnet,
  polygon,
  polygonAmoy,
  sepolia,
} from "viem/chains";

import { ChainAddressMap, ViemChainMap } from "./types.js";

export const ViemChain: ViemChainMap = {
  POLYGON: polygon,
  "POLYGON-AMOY": polygonAmoy,
  ETH: mainnet,
  "ETH-SEPOLIA": sepolia,
  ARB: arbitrum,
  "ARB-SEPOLIA": arbitrumSepolia,
  // BUFI: chainId 31337 (anvil behind @bufi/mock-circle), 43113, 5042002. RPC always comes from BUNDLER_RPC_URL.
  "LOCAL-SANDBOX": foundry,
  "AVAX-FUJI": avalancheFuji,
  "ARC-TESTNET": arcTestnet,
};

export const USDCTokenAddress: ChainAddressMap = {
  POLYGON: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
  "POLYGON-AMOY": "0x41e94eb019c0762f9bfcf9fb1e58725bfb0e7582",
  ETH: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  "ETH-SEPOLIA": "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238",
  ARB: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  "ARB-SEPOLIA": "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
  // BUFI: SandboxUSDC (CREATE2, sandbox salt — stable while its bytecode is; the live value is
  // contracts/deployments/local.json `tokens.usdc`, TOKEN_ADDRESS overrides it), Circle USDC on Fuji, native USDC on Arc.
  "LOCAL-SANDBOX": "0x38B45856e28E86985560f9c4B87113E8Eb86b0AD",
  "AVAX-FUJI": "0x5425890298aed601595a70AB815c96711a31Bc65",
  "ARC-TESTNET": "0x3600000000000000000000000000000000000000",
};

export const SafeListPluginContractAddress: ChainAddressMap = {
  POLYGON: "0x3c95978Af08B6B2Fd82659B393be86AfB4bd3D6F",
  "POLYGON-AMOY": "0x3c95978Af08B6B2Fd82659B393be86AfB4bd3D6F",
  ETH: "0x3c95978Af08B6B2Fd82659B393be86AfB4bd3D6F",
  "ETH-SEPOLIA": "0x3c95978Af08B6B2Fd82659B393be86AfB4bd3D6F",
  ARB: "0x3c95978Af08B6B2Fd82659B393be86AfB4bd3D6F",
  "ARB-SEPOLIA": "0x3c95978Af08B6B2Fd82659B393be86AfB4bd3D6F",
  // BUFI: Circle's v0.7 ColdStorageAddressBookPlugin at its canonical address (mock-circle recreates it there).
  "LOCAL-SANDBOX": "0x0000000d81083B16EA76dfab46B0315B0eDBF3d0",
  "AVAX-FUJI": "0x0000000d81083B16EA76dfab46B0315B0eDBF3d0",
  "ARC-TESTNET": "0x0000000d81083B16EA76dfab46B0315B0eDBF3d0",
};

export const SafeListPluginManifestHash: ChainAddressMap = {
  POLYGON: "0x9d177c1c9573b10436b693b7a49f0face36b677c1606a2c579bba1415be349d8",
  "POLYGON-AMOY": "0x9d177c1c9573b10436b693b7a49f0face36b677c1606a2c579bba1415be349d8",
  ETH: "0x9d177c1c9573b10436b693b7a49f0face36b677c1606a2c579bba1415be349d8",
  "ETH-SEPOLIA": "0x9d177c1c9573b10436b693b7a49f0face36b677c1606a2c579bba1415be349d8",
  ARB: "0x9d177c1c9573b10436b693b7a49f0face36b677c1606a2c579bba1415be349d8",
  "ARB-SEPOLIA": "0x9d177c1c9573b10436b693b7a49f0face36b677c1606a2c579bba1415be349d8",
  "LOCAL-SANDBOX": "0x9d177c1c9573b10436b693b7a49f0face36b677c1606a2c579bba1415be349d8",
  "AVAX-FUJI": "0x9d177c1c9573b10436b693b7a49f0face36b677c1606a2c579bba1415be349d8",
  "ARC-TESTNET": "0x9d177c1c9573b10436b693b7a49f0face36b677c1606a2c579bba1415be349d8",
};

// BUFI: BufiSessionKeyPlugin per chain. Only chains that carry the plugin are listed; SESSION_KEY_PLUGIN_ADDRESS
// overrides. Fuji/Arc: contracts/deployments/{avax-fuji,arc-testnet}.json (CREATE2, same address on both).
// Sandbox: contracts/deployments/local.json `plugins.bufiSessionKey.address` (CREATE2 over the current bytecode).
export const BufiSessionKeyPluginAddress: Partial<ChainAddressMap> = {
  "LOCAL-SANDBOX": "0x7DBca5Fe40A037DCfb3fBd0b539D70CB71337EEA",
  "AVAX-FUJI": "0x28504B34871Aa5a00269a960A9390187cbB5c070",
  "ARC-TESTNET": "0x28504B34871Aa5a00269a960A9390187cbB5c070",
};
