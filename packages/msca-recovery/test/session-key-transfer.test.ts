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

// Proof for the `session-key-transfer` / `session-keys` scenarios against the local sandbox
// (@bufi/mock-circle: anvil + Circle's ERC-6900 v0.7 stack at its canonical addresses + the BUFI plugins + an
// ERC-4337 bundler behind the Modular Wallets API mock).
//
// Reuses a sandbox already listening on :8545 / :8788; otherwise boots `packages/mock-circle` itself and stops it
// at the end. The MSCA setup below (create a 1-of-1 weighted account, install BufiSessionKeyPlugin, grant a key)
// talks viem straight to anvil and the mock — no BUFI SDK — and the assertions then run this package's own
// scenario functions.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  getAddress,
  http,
  pad,
  parseAbi,
  parseEther,
  parseSignature,
  toFunctionSelector,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import { createBundlerClient, getUserOperationHash, type UserOperation } from "viem/account-abstraction";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { foundry } from "viem/chains";

import {
  BufiSessionKeyPluginABI,
  SessionKeyPermissionsUpdatesABI,
  UpgradableMSCAABI,
  UpgradableMSCAFactoryABI,
} from "../src/abi/index.js";
import { executeSessionKeyTransfer } from "../src/sessionKeyTransfer.js";
import { listSessionKeys } from "../src/sessionKeys.js";
import { getSessionKeyNonceKey, getSessionKeySequence } from "../src/utils/sessionKey.js";

const ROOT = resolve(import.meta.dir, "../../..");
const ANVIL_RPC_URL = process.env.ANVIL_RPC_URL ?? "http://127.0.0.1:8545";
const MOCK_URL = process.env.MOCK_CIRCLE_URL ?? "http://127.0.0.1:8788/v1/rpc/w3s/buidl";
const DEPLOYMENTS_PATH = process.env.DEPLOYMENTS_PATH ?? resolve(ROOT, "contracts/deployments/local.json");
const CLIENT_KEY = "sandbox";
// The scenarios read BUNDLER_BEARER_TOKEN lazily; the mock rejects anything without a Bearer token.
process.env.BUNDLER_BEARER_TOKEN = CLIENT_KEY;

// anvil account #0 — deployed the sandbox stack, holds the minted SandboxUSDC.
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const CHAIN = "LOCAL-SANDBOX" as const;
const USDC = (n: number) => BigInt(n) * 10n ** 6n;
const TRANSFER_SELECTOR = toFunctionSelector("function transfer(address,uint256)");
const DAY = 86_400;

// Weighted-multisig EOA dummy for owner-op estimation (the mock never simulates; any 65-byte chunk will do).
const OWNER_DUMMY_SIGNATURE: Hex =
  "0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3c";

// The upstream ABIs in src/abi are plain arrays (ethers-first, no `as const`), so viem cannot type their return
// values; the few typed READS below use these fragments. Encoding and writes go through the package ABIs.
const readAbi = parseAbi([
  "function mint(address to, uint256 amount)",
  "function balanceOf(address) view returns (uint256)",
  "function getNonce(address sender, uint192 key) view returns (uint256)",
  "function getAddress(bytes32 _sender, bytes32 _salt, bytes _initializingData) view returns (address addr, bytes32 mixedSalt)",
  "function getInstalledPlugins() view returns (address[])",
]);

// `abi.encode(address[] initialOwners, uint256[] ownerWeights, PublicKey[] initialPublicKeyOwners,
//  uint256[] publicKeyOwnerWeights, uint256 thresholdWeight)` — WeightedWebauthnMultisigPlugin.onInstall
const weightedInstallDataParams = [
  { name: "initialOwners", type: "address[]" },
  { name: "ownerWeights", type: "uint256[]" },
  {
    name: "initialPublicKeyOwners",
    type: "tuple[]",
    components: [
      { name: "x", type: "uint256" },
      { name: "y", type: "uint256" },
    ],
  },
  { name: "publicKeyOwnerWeights", type: "uint256[]" },
  { name: "thresholdWeight", type: "uint256" },
] as const;
// `abi.encode(address[] plugins, bytes32[] manifestHashes, bytes[] pluginInstallData)` — UpgradableMSCAFactory.createAccount
const initializingDataParams = [
  { name: "plugins", type: "address[]" },
  { name: "manifestHashes", type: "bytes32[]" },
  { name: "pluginInstallData", type: "bytes[]" },
] as const;
// `abi.encode(address[] sessionKeys, bytes32[] tags, bytes[][] permissionUpdates)` — BufiSessionKeyPlugin.onInstall
const sessionKeyInstallDataParams = [
  { name: "sessionKeys", type: "address[]" },
  { name: "tags", type: "bytes32[]" },
  { name: "permissionUpdates", type: "bytes[][]" },
] as const;

interface LocalDeployment {
  chainId: number;
  entryPoint: Address;
  upgradableMscaFactory: Address;
  plugins: {
    weightedWebauthnMultisig: { address: Address; manifestHash: Hex };
    bufiSessionKey: { address: Address; manifestHash: Hex } | null;
  };
  tokens: { usdc: Address };
}

async function rpcListening(url: string, headers: Record<string, string> = {}): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return false;
    const json = (await response.json()) as { result?: unknown };
    return typeof json.result === "string";
  } catch {
    return false;
  }
}

const sandboxUp = async () =>
  (await rpcListening(MOCK_URL, { authorization: `Bearer ${CLIENT_KEY}` })) &&
  (await rpcListening(ANVIL_RPC_URL)) &&
  existsSync(DEPLOYMENTS_PATH);

/** Reuse a running sandbox, else boot mock-circle's dev entry (anvil → deploy → serve) and hand back the process. */
async function ensureSandbox(): Promise<Bun.Subprocess | undefined> {
  if (await sandboxUp()) return undefined;
  const proc = Bun.spawn(["bun", "run", "src/cli/dev.ts", "--rpc-url", ANVIL_RPC_URL, "--port", new URL(MOCK_URL).port || "80"], {
    cwd: resolve(ROOT, "packages/mock-circle"),
    env: { ...process.env, DEPLOYMENTS_PATH },
    stdout: "ignore",
    stderr: "inherit",
  });
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`mock-circle exited with code ${proc.exitCode} while booting`);
    if (await sandboxUp()) return proc;
    await Bun.sleep(1_000);
  }
  proc.kill();
  throw new Error("sandbox did not come up within 180s");
}

/** SIGTERM lets mock-circle's dev entry stop the mock and the anvil it spawned. */
async function stopSandbox(proc: Bun.Subprocess): Promise<void> {
  if (proc.exitCode === null) proc.kill("SIGTERM");
  await Promise.race([proc.exited, Bun.sleep(15_000)]);
  if (proc.exitCode === null) proc.kill("SIGKILL");
  await proc.exited;
}

describe("session-key-transfer against the local sandbox", () => {
  let sandbox: Bun.Subprocess | undefined;
  let deployment: LocalDeployment;
  let sessionKeyPlugin: { address: Address; manifestHash: Hex };
  let usdc: Address;
  const publicClient = createPublicClient({ chain: foundry, transport: http(ANVIL_RPC_URL) });
  const deployer = createWalletClient({ account: privateKeyToAccount(DEPLOYER_KEY), chain: foundry, transport: http(ANVIL_RPC_URL) });
  const bundler = createBundlerClient({
    chain: foundry,
    transport: http(MOCK_URL, { fetchOptions: { headers: { Authorization: `Bearer ${CLIENT_KEY}` } } }),
  });

  let owner: PrivateKeyAccount;
  let sessionKeyPrivateKey: Hex;
  let sessionKey: PrivateKeyAccount;
  let walletAddress: Address;
  let recipient: Address;
  let validUntil: number;

  const usdcBalance = (address: Address) =>
    publicClient.readContract({ address: usdc, abi: readAbi, functionName: "balanceOf", args: [address] });

  const entryPointNonce = (key: bigint) =>
    publicClient.readContract({ address: deployment.entryPoint, abi: readAbi, functionName: "getNonce", args: [walletAddress, key] });

  /**
   * Owner-signed user operation with RAW calldata (plugin management never goes through execute(): a self-call
   * would hit runtime validation, which the weighted plugin deliberately does not implement). 1-of-1 weighted EOA
   * signature = one `[r ‖ s ‖ v + 32]` chunk over `toEthSignedMessageHash(userOpHash)`.
   */
  async function sendOwnerUserOp(callData: Hex) {
    const nonce = await entryPointNonce(0n);
    const fees = await publicClient.estimateFeesPerGas();
    const gas = await bundler.estimateUserOperationGas({
      entryPointAddress: deployment.entryPoint,
      sender: walletAddress,
      nonce,
      callData,
      ...fees,
      signature: OWNER_DUMMY_SIGNATURE,
    });
    const unsigned: Omit<UserOperation<"0.7">, "signature"> = {
      sender: walletAddress,
      nonce,
      callData,
      callGasLimit: gas.callGasLimit,
      verificationGasLimit: gas.verificationGasLimit,
      preVerificationGas: gas.preVerificationGas,
      ...fees,
    };
    const userOpHash = getUserOperationHash({
      chainId: foundry.id,
      entryPointAddress: deployment.entryPoint,
      entryPointVersion: "0.7",
      userOperation: { ...unsigned, signature: "0x" },
    });
    const { r, s, v } = parseSignature(await owner.signMessage({ message: { raw: userOpHash } }));
    const signature = encodePacked(["bytes32", "bytes32", "uint8"], [r, s, Number(v) + 32]);
    const hash = await bundler.sendUserOperation({ entryPointAddress: deployment.entryPoint, ...unsigned, signature });
    const receipt = await bundler.waitForUserOperationReceipt({ hash, timeout: 60_000 });
    expect(receipt.success).toBe(true);
    return receipt;
  }

  beforeAll(async () => {
    sandbox = await ensureSandbox();
    deployment = JSON.parse(readFileSync(DEPLOYMENTS_PATH, "utf8")) as LocalDeployment;
    expect(deployment.chainId).toBe(foundry.id);
    if (!deployment.plugins.bufiSessionKey) {
      throw new Error("local.json carries no bufiSessionKey — run `bun run contracts:build` and reboot the sandbox");
    }
    sessionKeyPlugin = deployment.plugins.bufiSessionKey;
    usdc = deployment.tokens.usdc;

    owner = privateKeyToAccount(generatePrivateKey());
    sessionKeyPrivateKey = generatePrivateKey();
    sessionKey = privateKeyToAccount(sessionKeyPrivateKey);
    recipient = privateKeyToAccount(generatePrivateKey()).address;
  });

  afterAll(async () => {
    if (sandbox) await stopSandbox(sandbox);
  });

  test("creates a 1-of-1 weighted MSCA straight through the factory and funds it", async () => {
    const weighted = deployment.plugins.weightedWebauthnMultisig;
    const installData = encodeAbiParameters(weightedInstallDataParams, [[owner.address], [1n], [], [], 1n]);
    const initializingData = encodeAbiParameters(initializingDataParams, [[weighted.address], [weighted.manifestHash], [installData]]);
    const sender = pad(owner.address, { size: 32 });

    const [counterfactual] = await publicClient.readContract({
      address: deployment.upgradableMscaFactory,
      abi: readAbi,
      functionName: "getAddress",
      args: [sender, zeroHash, initializingData],
    });
    walletAddress = getAddress(counterfactual);
    expect(await publicClient.getCode({ address: walletAddress })).toBeUndefined();

    const createTx = await deployer.writeContract({
      address: deployment.upgradableMscaFactory,
      abi: UpgradableMSCAFactoryABI,
      functionName: "createAccount",
      args: [sender, zeroHash, initializingData],
    });
    expect((await publicClient.waitForTransactionReceipt({ hash: createTx })).status).toBe("success");
    expect(await publicClient.getCode({ address: walletAddress })).toBeDefined();
    const installed = await publicClient.readContract({ address: walletAddress, abi: readAbi, functionName: "getInstalledPlugins" });
    expect(installed.map((plugin) => getAddress(plugin))).toContain(getAddress(weighted.address));

    // 2 ETH for prefunds (the MSCA pays its own gas, never the session key), 1,000 USDC to move
    const fundTx = await deployer.sendTransaction({ to: walletAddress, value: parseEther("2") });
    await publicClient.waitForTransactionReceipt({ hash: fundTx });
    const mintTx = await deployer.writeContract({ address: usdc, abi: readAbi, functionName: "mint", args: [walletAddress, USDC(1_000)] });
    await publicClient.waitForTransactionReceipt({ hash: mintTx });
    expect(await usdcBalance(walletAddress)).toBe(USDC(1_000));
  });

  test("owner installs BufiSessionKeyPlugin (weighted-owner dependency slots) with no keys", async () => {
    const weighted = deployment.plugins.weightedWebauthnMultisig;
    const callData = encodeFunctionData({
      abi: UpgradableMSCAABI,
      functionName: "installPlugin",
      args: [
        sessionKeyPlugin.address,
        sessionKeyPlugin.manifestHash,
        encodeAbiParameters(sessionKeyInstallDataParams, [[], [], []]),
        // manifest slot 0 = owner RUNTIME validation → weighted function id 1 (unimplemented, fail-closed);
        // manifest slot 1 = owner USER-OP validation → weighted function id 0.
        [
          { plugin: weighted.address, functionId: 1 },
          { plugin: weighted.address, functionId: 0 },
        ],
      ],
    });
    await sendOwnerUserOp(callData);

    const installed = await publicClient.readContract({ address: walletAddress, abi: readAbi, functionName: "getInstalledPlugins" });
    expect(installed.map((plugin) => getAddress(plugin))).toContain(getAddress(sessionKeyPlugin.address));
    expect(await listSessionKeys({ chain: CHAIN, bundlerRPCUrl: MOCK_URL, walletAddress, pluginAddress: sessionKeyPlugin.address })).toEqual([]);
  });

  test("owner grants the session key: USDC.transfer only, 500 USDC / day, 1 ETH gas / day, 7 days", async () => {
    validUntil = Number((await publicClient.getBlock()).timestamp) + 7 * DAY;
    const permissionUpdates: Hex[] = [
      encodeFunctionData({ abi: SessionKeyPermissionsUpdatesABI, functionName: "setAccessListType", args: [0] }), // ALLOWLIST
      encodeFunctionData({ abi: SessionKeyPermissionsUpdatesABI, functionName: "updateAccessListAddressEntry", args: [usdc, true, true] }),
      encodeFunctionData({ abi: SessionKeyPermissionsUpdatesABI, functionName: "updateAccessListFunctionEntry", args: [usdc, TRANSFER_SELECTOR, true] }),
      encodeFunctionData({ abi: SessionKeyPermissionsUpdatesABI, functionName: "setERC20SpendLimit", args: [usdc, USDC(500), DAY] }),
      encodeFunctionData({ abi: SessionKeyPermissionsUpdatesABI, functionName: "setGasSpendLimit", args: [parseEther("1"), DAY] }),
      encodeFunctionData({ abi: SessionKeyPermissionsUpdatesABI, functionName: "updateTimeRange", args: [0, validUntil] }),
    ];
    const callData = encodeFunctionData({
      abi: BufiSessionKeyPluginABI,
      functionName: "addSessionKey",
      args: [sessionKey.address, zeroHash, permissionUpdates],
    });
    await sendOwnerUserOp(callData);

    const keys = await listSessionKeys({ chain: CHAIN, bundlerRPCUrl: MOCK_URL, walletAddress, pluginAddress: sessionKeyPlugin.address, tokenAddress: usdc });
    expect(keys.map((key) => getAddress(key.sessionKey))).toEqual([getAddress(sessionKey.address)]);
    const [info] = keys;
    expect(info!.validAfter).toBe(0);
    expect(info!.validUntil).toBe(validUntil);
    expect(info!.accessControlType).toBe(0);
    expect(info!.erc20Limit).toMatchObject({ token: usdc, hasLimit: true, limit: USDC(500), limitUsed: 0n, refreshInterval: DAY });
    expect(info!.gasLimit).toMatchObject({ hasLimit: true, limit: parseEther("1"), refreshInterval: DAY });
    expect(info!.gasLimitShouldReset).toBe(false);
    // A fresh key cannot spend native value at all: the plugin enforces a zero native limit until the owner raises it.
    expect(info!.nativeTokenLimit).toMatchObject({ hasLimit: true, limit: 0n });
    expect(info!.requiredPaymaster).toBe("0x0000000000000000000000000000000000000000");
  });

  test("session-key-transfer moves 25 USDC on the session key's nonce lane", async () => {
    const nonceKey = getSessionKeyNonceKey(sessionKey.address);
    expect(await entryPointNonce(nonceKey)).toBe(nonceKey << 64n);

    const result = await executeSessionKeyTransfer({
      chain: CHAIN,
      bundlerRPCUrl: MOCK_URL,
      walletAddress,
      sessionKeyPrivateKey,
      tokenAddress: usdc,
      recipientAddress: recipient,
      amount: USDC(25),
      gasFeesMultiplier: 1,
    });

    expect(result.success).toBe(true);
    expect(getAddress(result.sessionKey)).toBe(getAddress(sessionKey.address));
    expect(result.userOpHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.transactionHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect((await publicClient.getTransactionReceipt({ hash: result.transactionHash })).status).toBe("success");

    // the op ran on `(uint192(sessionKey) << 64) | seq`, and the lane advanced
    expect(result.userOperation.nonce >> 64n).toBe(nonceKey);
    expect(getSessionKeySequence(result.userOperation.nonce)).toBe(0n);
    expect(await entryPointNonce(nonceKey)).toBe((nonceKey << 64n) | 1n);
    expect(await entryPointNonce(0n)).toBe(2n); // the owner lane is untouched (install + grant)

    // the signature is a single 65-byte ECDSA chunk from the session key, not a weighted-multisig packing
    expect((result.userOperation.signature.length - 2) / 2).toBe(65);

    // USDC moved, and the plugin charged it against the key's budget
    expect(await usdcBalance(recipient)).toBe(USDC(25));
    expect(await usdcBalance(walletAddress)).toBe(USDC(975));
    const [info] = await listSessionKeys({ chain: CHAIN, bundlerRPCUrl: MOCK_URL, walletAddress, pluginAddress: sessionKeyPlugin.address, tokenAddress: usdc });
    expect(info!.erc20Limit!.limitUsed).toBe(USDC(25));
  });

  test("an over-budget transfer is included but reverts on-chain (execution-phase ERC-20 limit)", async () => {
    const result = await executeSessionKeyTransfer({
      chain: CHAIN,
      bundlerRPCUrl: MOCK_URL,
      walletAddress,
      sessionKeyPrivateKey,
      tokenAddress: usdc,
      recipientAddress: recipient,
      amount: USDC(600), // 25 + 600 > 500 / day
      gasFeesMultiplier: 1,
    });
    expect(result.success).toBe(false);
    expect(await usdcBalance(recipient)).toBe(USDC(25));
    expect(await usdcBalance(walletAddress)).toBe(USDC(975));
  });

  test("a key the owner never granted is rejected by the bundler at validation", async () => {
    await expect(
      executeSessionKeyTransfer({
        chain: CHAIN,
        bundlerRPCUrl: MOCK_URL,
        walletAddress,
        sessionKeyPrivateKey: generatePrivateKey(),
        tokenAddress: usdc,
        recipientAddress: recipient,
        amount: USDC(1),
        gasFeesMultiplier: 1,
      }),
    ).rejects.toThrow();
    expect(await usdcBalance(recipient)).toBe(USDC(25));
  });
});
