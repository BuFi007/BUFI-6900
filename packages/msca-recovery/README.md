# @bufi/msca-recovery

Fork of [`circlefin/msca-wallet-recovery`](https://github.com/circlefin/msca-wallet-recovery)
(commit `76c4168`, release `2025-03-18T162928`, Apache-2.0 — original license in `LICENSE.upstream`,
original README in `README.upstream.md`).

Purpose in BUFI-6900: the **independent recovery lane**. It drives a Circle ERC-6900 MSCA through any
ERC-4337 bundler with plain viem + permissionless 0.1.x — no Circle Modular Wallets API, no BUFI SDK — which is
exactly what an operator needs when Circle's API is unavailable, and what an auditor needs to exercise the wallet
without `@bufi/modular-wallets-core`. The upstream ABIs (`src/abi/`) are the production Circle contracts; BUFI adds
its plugin ABIs and two scenarios that use them.

This package is `private` and not published.

## Scenarios

| scenario                        | signs with                                              | what it does                                                                                                                                     |
| ------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `token-transfer` (upstream)     | the owner set — private keys in `SIGNER_ADDRESSES` or WalletConnect | USDC transfer through `execute(token, 0, transfer(...))`, weighted-multisig signature packing, owner nonce lane (key 0)                    |
| `sign-hash` (upstream)          | one owner                                               | EIP-191 signature of a hash (usually a userOpHash) for offline multisig assembly                                                                 |
| `session-key-transfer` (BUFI)   | a **BufiSessionKeyPlugin session key** (`SESSION_KEY_PRIVATE_KEY`) | ERC-20 transfer through `executeWithSessionKey([{ target: token, value: 0, data: transfer(recipient, amount) }], sessionKey)` on the key's own nonce lane |
| `session-keys` (BUFI)           | nothing — read-only                                     | lists the keys registered on the MSCA with time range, access-list mode, ERC-20 / native / gas limits and required paymaster, via the plugin's loupe getters |

Every scenario is `bun run <scenario> [flags]` (`tsc` build + `node dist/index.js <scenario>`); flags fall back to the
env vars below, exactly like upstream. `session-key-transfer` without `-b` is a dry run: it builds, estimates, signs
and checks balances but sends nothing.

```bash
bun run env-config                      # .env from .env.sample, then fill it in
bun run session-keys                    # who may spend from MSCA_WALLET_ADDRESS, and how much
bun run session-key-transfer            # dry run
bun run session-key-transfer -b -a 12.5 -r 0xRecipient   # broadcast (prompts for "C")
```

## Sandbox quickstart

`@bufi/mock-circle` is Circle's Modular Wallets API mock **and** an ERC-4337 bundler in front of an anvil chain that
carries Circle's ERC-6900 v0.7 stack at its canonical addresses plus the BUFI plugins.

```bash
bun run mock:circle                                   # repo root: anvil :8545 → deploy → mock API :8788
bun run --cwd packages/msca-recovery test             # the proof (see below) — reuses that sandbox, or boots its own
```

`.env` for the sandbox:

```bash
BLOCKCHAIN='LOCAL-SANDBOX'
BUNDLER_RPC_URL='http://127.0.0.1:8788/v1/rpc/w3s/buidl'
BUNDLER_BEARER_TOKEN='sandbox'          # the mock rejects requests without a Bearer token (any value)
MSCA_WALLET_ADDRESS='0x…'               # an account created on the sandbox with BufiSessionKeyPlugin installed
SESSION_KEY_PRIVATE_KEY='0x…'           # a key the owner granted through addSessionKey / onInstall
SESSION_KEY_PLUGIN_ADDRESS='0x…'        # contracts/deployments/local.json → plugins.bufiSessionKey.address
TOKEN_ADDRESS='0x…'                     # contracts/deployments/local.json → tokens.usdc (SandboxUSDC)
RECIPIENT_ADDRESS='0x…'
TOKEN='usdc'
TRANSFER_AMOUNT=12.5
GAS_FEES_MULTIPLIER=1
BROADCAST_OPERATION=false
```

`contracts/deployments/local.json` is written by the sandbox on boot; its `plugins.bufiSessionKey` and `tokens.usdc`
are CREATE2 addresses that move with the contracts' bytecode, so read them from the file rather than trusting the
defaults in `src/utils/configs.ts`.

## Environment variables

Upstream variables are unchanged (`README.upstream.md`). BUFI adds:

| variable                     | used by                            | meaning                                                                                                                                                                    |
| ---------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BLOCKCHAIN`                 | all                                | upstream values plus `LOCAL-SANDBOX` (31337), `AVAX-FUJI` (43113), `ARC-TESTNET` (5042002)                                                                                 |
| `BUNDLER_BEARER_TOKEN`       | all                                | optional; sent as `Authorization: Bearer <token>` on every bundler/RPC request (viem and ethers clients). Required by the sandbox, unset for URL-keyed providers            |
| `SESSION_KEY_PRIVATE_KEY`    | `session-key-transfer`             | the session key's private key (`-k`). Never logged. Only private-key signing is supported for session keys — an agent key is not a WalletConnect wallet                    |
| `SESSION_KEY_PLUGIN_ADDRESS` | `session-keys`                     | BufiSessionKeyPlugin address (`-p`); defaults per chain from `BufiSessionKeyPluginAddress` in `configs.ts`. Not needed to transfer: `executeWithSessionKey` is called on the account |
| `TOKEN_ADDRESS`              | `session-key-transfer`, `session-keys` | ERC-20 override (`--tokenAddress` / `-t`); defaults to the chain's USDC. Amounts are parsed with 6 decimals                                                            |

## Chains

| `BLOCKCHAIN`    | chainId | USDC                                         | BufiSessionKeyPlugin                                                | source                                    |
| --------------- | ------- | -------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------- |
| `LOCAL-SANDBOX` | 31337   | SandboxUSDC, `0x38B45856…b0AD` at last deploy | `0x7DBca5Fe…7EEA` at last deploy                                    | `contracts/deployments/local.json`        |
| `AVAX-FUJI`     | 43113   | `0x5425890298aed601595a70AB815c96711a31Bc65` | `0x28504B34871Aa5a00269a960A9390187cbB5c070`                        | `contracts/deployments/avax-fuji.json`    |
| `ARC-TESTNET`   | 5042002 | `0x3600000000000000000000000000000000000000` | `0x28504B34871Aa5a00269a960A9390187cbB5c070`                        | `contracts/deployments/arc-testnet.json`  |

Circle's ColdStorageAddressBookPlugin sits at its canonical `0x0000000d81…F3d0` on all three (the sandbox recreates
Circle's stack at Circle's addresses), so the upstream safelist tables carry the same rows. The upstream chain rows
are untouched.

## How a session-key user operation is built (`src/utils/sessionKey.ts`)

1. **Calldata** is raw `executeWithSessionKey(Call[] calls, address sessionKey)` on the account — never wrapped in
   `execute()`. The plugin validates the signature against the `sessionKey` argument and enforces that key's
   permissions over the same `calls` it then runs through `executeFromPluginExternal`.
2. **Nonce lane.** ERC-4337 v0.7 nonces are `(uint192 key << 64) | uint64 seq`. `BufiSessionKeyPlugin`
   (`SessionKeyPermissions._checkUserOpPermissions`) fails validation for a gas-limited key unless
   `uint192(nonce >> 64) == uint192(uint160(sessionKey))`, so the key's own address is the nonce key for every
   session-key op: `nonce = EntryPoint.getNonce(account, uint192(sessionKey))`. The owner lane (key 0) is never touched.
3. **Estimation** reuses upstream `estimateUserOp` (fee multiplier, Alchemy `rundler_maxPriorityFeePerGas`) with a
   single recoverable 65-byte ECDSA dummy instead of the weighted-multisig packing: the plugin reverts on a malformed
   signature and only returns `SIG_VALIDATION_FAILED` on a mismatch, which is what bundlers tolerate while estimating.
4. **Hash** comes from the deployed EntryPoint (`getUserOpHash`, upstream helper) once the gas fields are final.
5. **Signature** is EIP-191 `personal_sign` over the raw 32-byte hash — the plugin recovers
   `ECDSA.recover(toEthSignedMessageHash(userOpHash))`. One 65-byte chunk, no `+32` v marker, no weight sorting.
6. **Send** through permissionless `sendUserOperation` and `waitForUserOperationReceipt`.

Two enforcement phases matter to an operator: time range, access list, gas and native limits are checked in
**validation** (the bundler rejects the op outright, `session-key-transfer` throws); the **ERC-20 budget** is charged
in **execution** (an over-budget transfer is included, reverts on-chain, costs gas, moves nothing — the scenario
reports `success: false` with the transaction hash).

## permissionless 0.1.x vs EntryPoint v0.7 — where it needed care

- `getAccountNonce(client, { sender, entryPoint, key })` — `key` is the 192-bit nonce key. Upstream never passes it
  (owner lane 0); the session key lane needs it.
- `estimateUserOperationGas` returns `paymasterVerificationGasLimit` / `paymasterPostOpGasLimit` for v0.7; upstream's
  `estimateUserOp` drops them (no paymaster). The signature field must be a plausible one for the account's validation
  path or the estimate is wrong / rejected — hence the per-caller `dummySignature`.
- permissionless 0.1.x hashes/serialises by `entryPoint` address: keep `ENTRYPOINT_ADDRESS_V07`
  (`0x0000000071727De22E5E9d8BAf0edAc6f37da032`), which the sandbox, Fuji and Arc all use. The hash is read from the
  contract (`getUserOpHash`) rather than computed locally, so any EntryPoint deployment at that address works.
- `UserOperation<"v0.7">` carries `factory`/`factoryData` and `paymaster*` as separate optional fields; the on-chain
  `getUserOpHash` call packs them (`initCode`, `accountGasLimits`, `gasFees`, `paymasterAndData`) itself.
- Bearer auth: permissionless builds its own `http` transports; every client here goes through `bundlerHttp()` /
  `bundlerJsonRpcProvider()` so `BUNDLER_BEARER_TOKEN` reaches viem **and** ethers (`getAndCheckBalance`).

## Test

`bun run --cwd packages/msca-recovery test` → `test/session-key-transfer.test.ts`:

- reuses a sandbox on `:8545` / `:8788` (with `contracts/deployments/local.json`), otherwise boots
  `packages/mock-circle/src/cli/dev.ts` and SIGTERMs it at the end (`ANVIL_RPC_URL`, `MOCK_CIRCLE_URL`,
  `DEPLOYMENTS_PATH` move it to other ports);
- creates a 1-of-1 weighted MSCA straight through `UpgradableMSCAFactory.createAccount` from anvil account #0,
  funds it (2 ETH, 1,000 SandboxUSDC);
- owner-signed raw-calldata user operations (viem `createBundlerClient`, `[r ‖ s ‖ v + 32]` weighted EOA signature)
  install `BufiSessionKeyPlugin` with the weighted dependency slots `[functionId 1 (runtime, unimplemented), functionId 0 (userOp)]`,
  then `addSessionKey` with a grant: USDC `transfer` only, 500 USDC / day, 1 ETH gas / day, 7 days;
- `listSessionKeys` reads the grant back; `executeSessionKeyTransfer` moves 25 USDC and the assertions cover the
  receipt, the nonce lane (`nonce >> 64 == uint192(sessionKey)`, sequence 0 → 1, owner lane untouched), the 65-byte
  signature, balances and `limitUsed`;
- an over-budget transfer is included and reverts (`success: false`, balances unchanged); an ungranted key is
  rejected at validation.

`bun run --cwd packages/msca-recovery check:type` type-checks `src/` (upstream `tsconfig.json`) and the test
(`tsconfig.test.json`, `@types/bun`).

## What changed against upstream

Upstream files are verbatim except for these additive edits:

- `src/utils/types.ts` — three `NetworkKey` members, optional `dummySignature` on `UserOpEstimateParams`, session-key types.
- `src/utils/configs.ts` — rows for the three chains in every table (`ViemChain`, `USDCTokenAddress`, safelist address/manifest) plus `BufiSessionKeyPluginAddress`.
- `src/utils/helpers.ts` — `getBundlerAuthHeaders` / `bundlerHttp` / `bundlerJsonRpcProvider`, `getSecretOptionValue` (never echoes the value).
- `src/utils/blockchain.ts` — `http(bundlerRPCUrl)` → `bundlerHttp(bundlerRPCUrl)` (4×); `estimateUserOp` honours `dummySignature`.
- `src/tokenTransfer.ts`, `src/utils/wallet.ts` — same transport swap (2× viem, 1× ethers).
- `src/abi/index.ts` — exports `BufiSessionKeyPluginABI`, `BufiEarnModuleABI`, `SessionKeyPermissionsUpdatesABI`.
- `src/index.ts` — the two new scenario cases.

New: `src/abi/{BufiSessionKeyPlugin,BufiEarnModule,SessionKeyPermissionsUpdates}.ts` (generated from the forge
artifacts under `contracts/out/`, byte-identical to their `.abi`, upstream `as const` style), `src/utils/sessionKey.ts`,
`src/sessionKeyTransfer.ts`, `src/sessionKeys.ts`, `test/`, `tsconfig.test.json`.
