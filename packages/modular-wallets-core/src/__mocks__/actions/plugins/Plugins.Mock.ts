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

import type { BufiGrant, StackDeployment } from '../../../types'
import type { Address, Hex } from 'viem'

/**
 * Mock modular smart contract account address.
 */
export const MockAccountAddress: Address =
  '0x1111111111111111111111111111111111111111'

/**
 * Mock plugin address.
 */
export const MockPluginAddress: Address =
  '0x2222222222222222222222222222222222222222'

/**
 * Mock manifest hash.
 */
export const MockManifestHash: Hex = `0x${'ab'.repeat(32)}`

/**
 * Mock session key address (anvil account #1).
 */
export const MockSessionKeyAddress: Address =
  '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'

/**
 * Mock session key private key (anvil account #1).
 */
export const MockSessionKeyPrivateKey: Hex =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'

/**
 * Mock ERC-20 token address (USDC on Avalanche Fuji).
 */
export const MockTokenAddress: Address =
  '0x5425890298aed601595a70AB815c96711a31Bc65'

/**
 * Mock ERC-4626 vault address.
 */
export const MockVaultAddress: Address =
  '0x000000000000000000000000000000000000dEaD'

/**
 * Mock transfer recipients, including one duplicate that differs only by case.
 */
export const MockRecipients: Address[] = [
  '0xCA5609B003B2776699bEa123317C82D56913C9AA',
  '0xc00ac2B0440BFF6699BeA128709982D5691BC7DE',
  '0xca5609b003b2776699bea123317c82d56913c9aa',
]

/**
 * Mock user operation hash returned by the bundler for plugin actions.
 */
export const PluginUserOperationHashResponseMock: Hex =
  '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'

/**
 * Mock sandbox deployment file, in the shape written by the contracts deploy script.
 */
export const MockSandboxDeploymentJson = {
  chainId: 31337,
  rpcUrl: 'http://127.0.0.1:8545',
  entryPoint: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  create2Deployer: '0x4e59b44847b379578588920cA78FbF26c0B4956C',
  pluginManager: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
  upgradableMscaFactory: '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0',
  upgradableMscaImpl: '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9',
  plugins: {
    weightedWebauthnMultisig: {
      address: '0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9',
      manifestHash: `0x${'11'.repeat(32)}`,
    },
    coldStorageAddressBook: {
      address: '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707',
      manifestHash: `0x${'22'.repeat(32)}`,
    },
    bufiSessionKey: {
      address: '0x0165878A594ca255338adfa4d48449f69242Eb8F',
      manifestHash: `0x${'33'.repeat(32)}`,
    },
    bufiEarnModule: null,
  },
  paymaster: {
    address: '0xa513E6E4b8f2a923D98304ec87F64353C4D5C853',
    signer: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  },
  tokens: {
    usdc: '0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6',
  },
  accounts: {
    deployer: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    bundler: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
    factoryOwner: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
  },
}

/**
 * The stack deployment `toStackDeployment` produces from {@link MockSandboxDeploymentJson}.
 */
export const MockSandboxDeployment: StackDeployment = {
  chainId: 31337,
  entryPoint: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  upgradableMscaFactory: '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0',
  upgradableMsca: '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9',
  pluginManager: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
  weightedWebauthnMultisig: {
    address: '0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9',
    manifestHash: `0x${'11'.repeat(32)}`,
  },
  coldStorageAddressBook: {
    address: '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707',
    manifestHash: `0x${'22'.repeat(32)}`,
  },
  bufiSessionKey: {
    address: '0x0165878A594ca255338adfa4d48449f69242Eb8F',
    manifestHash: `0x${'33'.repeat(32)}`,
  },
  paymaster: '0xa513E6E4b8f2a923D98304ec87F64353C4D5C853',
  tokens: {
    usdc: '0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6',
  },
}

/**
 * Mock BUFI grant: an agent that may call `transfer` on USDC and anything on the vault, within budget, for a day.
 */
export const MockBufiGrant: BufiGrant = {
  scope: {
    allow: [
      { target: MockTokenAddress, selectors: ['0xa9059cbb'] },
      { target: MockVaultAddress },
    ],
  },
  budget: {
    erc20: [
      {
        token: MockTokenAddress,
        limit: 250_000_000n,
        refreshIntervalSeconds: 86_400,
      },
    ],
    native: { limit: 10n ** 16n, refreshIntervalSeconds: 0 },
    gas: { limit: 10n ** 17n, refreshIntervalSeconds: 86_400 },
  },
  expiry: { validAfter: 1_800_000_000, validUntil: 1_800_086_400 },
  requiredPaymaster: '0xa513E6E4b8f2a923D98304ec87F64353C4D5C853',
}
