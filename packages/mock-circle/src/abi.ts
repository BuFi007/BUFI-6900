/*
 * @bufi/mock-circle — the ABI fragments the deployer and the mock API call.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import { entryPoint07Abi, type UserOperation } from 'viem/account-abstraction'
import { toFunctionSelector, type Hex } from 'viem'

/** Full ERC-4337 v0.7 EntryPoint ABI (handleOps, getUserOpHash, FailedOp/FailedOpWithRevert, UserOperationEvent …). */
export const entryPointAbi = entryPoint07Abi

/** `struct PackedUserOperation` as it appears in every v0.7 calldata tuple. */
export const packedUserOperationComponents = [
  { name: 'sender', type: 'address' },
  { name: 'nonce', type: 'uint256' },
  { name: 'initCode', type: 'bytes' },
  { name: 'callData', type: 'bytes' },
  { name: 'accountGasLimits', type: 'bytes32' },
  { name: 'preVerificationGas', type: 'uint256' },
  { name: 'gasFees', type: 'bytes32' },
  { name: 'paymasterAndData', type: 'bytes' },
  { name: 'signature', type: 'bytes' },
] as const

/** UpgradableMSCAFactory — the subset the sandbox uses. */
export const factoryAbi = [
  {
    type: 'function',
    name: 'ACCOUNT_IMPLEMENTATION',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'ENTRY_POINT',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'owner',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'isPluginAllowed',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'setPlugins',
    stateMutability: 'nonpayable',
    inputs: [
      { name: '_plugins', type: 'address[]' },
      { name: '_permissions', type: 'bool[]' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'getAddress',
    stateMutability: 'view',
    inputs: [
      { name: '_sender', type: 'bytes32' },
      { name: '_salt', type: 'bytes32' },
      { name: '_initializingData', type: 'bytes' },
    ],
    outputs: [
      { name: 'addr', type: 'address' },
      { name: 'mixedSalt', type: 'bytes32' },
    ],
  },
  {
    type: 'function',
    name: 'createAccount',
    stateMutability: 'nonpayable',
    inputs: [
      { name: '_sender', type: 'bytes32' },
      { name: '_salt', type: 'bytes32' },
      { name: '_initializingData', type: 'bytes' },
    ],
    outputs: [{ name: 'account', type: 'address' }],
  },
  {
    type: 'event',
    name: 'AccountCreated',
    anonymous: false,
    inputs: [
      { name: 'proxy', type: 'address', indexed: true },
      { name: 'sender', type: 'bytes32', indexed: false },
      { name: 'salt', type: 'bytes32', indexed: false },
    ],
  },
  { type: 'error', name: 'PluginIsNotAllowed', inputs: [{ name: 'plugin', type: 'address' }] },
  { type: 'error', name: 'InvalidInitializationInput', inputs: [] },
  { type: 'error', name: 'Create2FailedDeployment', inputs: [] },
] as const

/** UpgradableMSCA — the account surface the tests and the address derivation need. */
export const upgradableMscaAbi = [
  {
    type: 'function',
    name: 'execute',
    stateMutability: 'payable',
    inputs: [
      { name: 'target', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
    ],
    outputs: [{ name: 'returnData', type: 'bytes' }],
  },
  {
    type: 'function',
    name: 'executeBatch',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          { name: 'target', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'data', type: 'bytes' },
        ],
      },
    ],
    outputs: [{ name: 'returnData', type: 'bytes[]' }],
  },
  {
    type: 'function',
    name: 'initializeUpgradableMSCA',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'plugins', type: 'address[]' },
      { name: 'manifestHashes', type: 'bytes32[]' },
      { name: 'pluginInstallData', type: 'bytes[]' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'getInstalledPlugins',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: 'pluginAddresses', type: 'address[]' }],
  },
] as const

/**
 * WeightedWebauthnMultisigPlugin install data — `abi.encode(address[] initialOwners, uint256[] ownerWeights,
 * PublicKey[] initialPublicKeyOwners, uint256[] publicKeyOwnerWeights, uint256 thresholdWeight)` (SDK
 * `CIRCLE_PLUGIN_INSTALL_DATA_ABI`).
 */
export const weightedPluginInstallDataAbi = [
  { name: 'initialOwners', type: 'address[]' },
  { name: 'ownerWeights', type: 'uint256[]' },
  {
    name: 'initialPublicKeyOwners',
    type: 'tuple[]',
    components: [
      { name: 'x', type: 'uint256' },
      { name: 'y', type: 'uint256' },
    ],
  },
  { name: 'publicKeyOwnerWeights', type: 'uint256[]' },
  { name: 'thresholdWeight', type: 'uint256' },
] as const

/** `abi.encode(address[] plugins, bytes32[] manifestHashes, bytes[] pluginInstallData)` (SDK `INITIALIZING_DATA_ABI_PARAMS`). */
export const initializingDataAbi = [
  { name: 'plugins', type: 'address[]' },
  { name: 'manifestHashes', type: 'bytes32[]' },
  { name: 'pluginInstallData', type: 'bytes[]' },
] as const

/** WebAuthn owner `sender` pre-image: `keccak256(abi.encode(x, y))` (SDK `PUBLIC_KEY_COORDINATES_ABI`). */
export const publicKeyCoordinatesAbi = [
  { name: 'x', type: 'uint256' },
  { name: 'y', type: 'uint256' },
] as const

/** `pluginManifest()` — its raw return data is `abi.encode(PluginManifest)`, which is what the manifest hash covers. */
export const PLUGIN_MANIFEST_SELECTOR: Hex = toFunctionSelector('function pluginManifest()')

/** Circle SponsorPaymaster (UUPS, behind ERC1967Proxy). */
export const sponsorPaymasterAbi = [
  {
    type: 'function',
    name: 'initialize',
    stateMutability: 'nonpayable',
    inputs: [
      { name: '_newOwner', type: 'address' },
      { name: '_verifyingSigners', type: 'address[]' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'getHash',
    stateMutability: 'view',
    inputs: [
      { name: 'userOp', type: 'tuple', components: packedUserOperationComponents },
      { name: 'paymasterVerificationGasLimit', type: 'uint128' },
      { name: 'paymasterPostOpGasLimit', type: 'uint128' },
      { name: 'validUntil', type: 'uint48' },
      { name: 'validAfter', type: 'uint48' },
    ],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'parsePaymasterAndData',
    stateMutability: 'pure',
    inputs: [{ name: 'paymasterAndData', type: 'bytes' }],
    outputs: [
      { name: 'paymasterVerificationGasLimit', type: 'uint128' },
      { name: 'paymasterPostOpGasLimit', type: 'uint128' },
      { name: 'validUntil', type: 'uint48' },
      { name: 'validAfter', type: 'uint48' },
      { name: 'signature', type: 'bytes' },
    ],
  },
  {
    type: 'function',
    name: 'addVerifyingSigners',
    stateMutability: 'nonpayable',
    inputs: [{ name: '_newVerifyingSigners', type: 'address[]' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'getAllSigners',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address[]' }],
  },
  {
    type: 'function',
    name: 'addStake',
    stateMutability: 'payable',
    inputs: [{ name: 'unstakeDelaySec', type: 'uint32' }],
    outputs: [],
  },
  { type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] },
  {
    type: 'function',
    name: 'getDeposit',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getDepositInfo',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      {
        name: 'info',
        type: 'tuple',
        components: [
          { name: 'deposit', type: 'uint256' },
          { name: 'staked', type: 'bool' },
          { name: 'stake', type: 'uint112' },
          { name: 'unstakeDelaySec', type: 'uint32' },
          { name: 'withdrawTime', type: 'uint48' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'owner',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'ENTRY_POINT',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
] as const

/** SandboxUSDC — OpenZeppelin ERC20 + open `mint`. */
export const sandboxUsdcAbi = [
  {
    type: 'function',
    name: 'mint',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
] as const

/** Used to pin the type of userOps the bundler handles. */
export type UserOperationV07 = UserOperation<'0.7'>
