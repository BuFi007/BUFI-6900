/*
 * @bufi/mock-circle — configuration and the constants Circle's production stack is pinned to.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import path from 'node:path'
import { keccak256, stringToBytes, type Address, type Hex } from 'viem'

import { repoRoot } from './artifacts.ts'

/** anvil's default mnemonic accounts (`test test … junk`). #0 deploys, #1 bundles, #2 signs paymaster data. */
export const ANVIL_ACCOUNTS = {
  deployer: {
    address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address,
    key: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex,
  },
  bundler: {
    address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address,
    key: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex,
  },
  paymasterSigner: {
    address: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as Address,
    key: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as Hex,
  },
} as const

/**
 * Circle's production ERC-6900 v0.7 stack. Addresses, CREATE2 salts and constructor arguments are taken
 * verbatim from `contracts/lib/buidl-wallet-contracts/script/bytecode-deploy/{100_Constants.sol,10x_*.s.sol}`;
 * with Circle's shipped creation bytecode and the Arachnid deployer the sandbox lands on the SAME addresses.
 */
export const CIRCLE_CANONICAL = {
  entryPoint: '0x0000000071727De22E5E9d8BAf0edAc6f37da032' as Address,
  create2Deployer: '0x4e59b44847b379578588920cA78FbF26c0B4956C' as Address,
  /** Runtime bytecode of the Arachnid deterministic deployment proxy, for chains that do not pre-install it. */
  create2DeployerRuntime:
    '0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3' as Hex,
  pluginManager: '0x00000005e69188224e4dEeF607801916DC0936d5' as Address,
  upgradableMscaFactory: '0x0000000DF7E6c9Dc387cAFc5eCBfa6c3a6179AdD' as Address,
  /** Deployed by the factory constructor (`new UpgradableMSCA(entryPoint, pluginManager)`). */
  upgradableMscaImpl: '0xA70F1296869DA9D7CB69578123F21888E6dB2B62' as Address,
  coldStorageAddressBookPlugin: '0x0000000d81083B16EA76dfab46B0315B0eDBF3d0' as Address,
  weightedWebauthnMultisigPlugin: '0x0000000C984AFf541D6cE86Bb697e68ec57873C8' as Address,
  /** `MSCA_FACTORY_OWNER_ADDRESS` — part of the factory's CREATE2 pre-image, impersonated to allowlist plugins. */
  factoryOwner: '0x0166EA90E565476f13c6a0D25ED2C35599E58785' as Address,
  salts: {
    pluginManager: '0x20828f442f63e502375f253988ec6578620f09b1c00bbcc237edb6838323dba1' as Hex,
    upgradableMscaFactory: '0xda9f7ba8ec86b458ea272ecf44962d37f768e4d6f254dd2a82d5724b934b72d5' as Hex,
    coldStorageAddressBookPlugin: '0x36fdaa1ba01cead4cf7fd9405035fc259bb463d9411d619a7deb31d13a2bd89f' as Hex,
    weightedWebauthnMultisigPlugin: '0x2cc3c603d96a0edab755ab092bf8e79f8d8934cc586d021ddd53be945606e535' as Hex,
  },
  manifestHashes: {
    weightedWebauthnMultisig: '0xa043327d77a74c1c55cfa799284b831fe09535a88b9f5fa4173d334e5ba0fd91' as Hex,
    coldStorageAddressBook: '0x9d177c1c9573b10436b693b7a49f0face36b677c1606a2c579bba1415be349d8' as Hex,
  },
} as const

/** CREATE2 salt for everything the sandbox adds on top of Circle's stack (stable addresses across restarts). */
export const SANDBOX_SALT: Hex = keccak256(stringToBytes('bufi-6900-sandbox'))

/** `scaCore` the SDK sends in `circle_getAddress`. */
export const SCA_CORE = 'circle_6900_v1'
/** `blockchain` reported on every ModularWallet / address mapping the mock returns. */
export const BLOCKCHAIN_NAME = 'ANVIL'
/** Mirrors `https://modular-sdk.circle.com/v1/rpc/w3s/buidl`. */
export const RPC_PATH = '/v1/rpc/w3s/buidl'
export const SPONSOR_NAME = 'BUFI sandbox'

/** Static, generous limits: the mock never simulates for gas, it lets the EntryPoint refund what is unused. */
export const DEFAULT_GAS_LIMITS = {
  preVerificationGas: 100_000n,
  verificationGasLimit: 3_000_000n,
  callGasLimit: 3_000_000n,
  paymasterVerificationGasLimit: 150_000n,
  paymasterPostOpGasLimit: 50_000n,
  /** `circle_getUserOperationGasPrice.deployed` / `.notDeployed` — the SDK's default verificationGasLimit. */
  deployedVerificationGasLimit: 600_000n,
  notDeployedVerificationGasLimit: 1_500_000n,
} as const

export interface EnvConfig {
  anvilRpcUrl: string
  port: number
  hostname: string
  deploymentsPath: string
  rpId: string
  paymasterValiditySecs: number
}

export function envConfig(): EnvConfig {
  return {
    anvilRpcUrl: process.env.ANVIL_RPC_URL ?? 'http://127.0.0.1:8545',
    port: Number(process.env.MOCK_CIRCLE_PORT ?? 8788),
    hostname: process.env.MOCK_CIRCLE_HOST ?? '127.0.0.1',
    deploymentsPath: process.env.DEPLOYMENTS_PATH
      ? path.resolve(process.env.DEPLOYMENTS_PATH)
      : path.join(repoRoot(), 'contracts', 'deployments', 'local.json'),
    rpId: process.env.MOCK_CIRCLE_RP_ID ?? 'localhost',
    paymasterValiditySecs: Number(process.env.MOCK_PAYMASTER_VALID_SECS ?? 3600),
  }
}

export type Logger = (message: string) => void
export const consoleLogger: Logger = (message) => console.log(`[mock-circle] ${message}`)
export const silentLogger: Logger = () => {}
