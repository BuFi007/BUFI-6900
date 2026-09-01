# @bufi/mock-circle

A local stand-in for Circle's **Modular Wallets API** — the JSON-RPC endpoint `@circle-fin/modular-wallets-core`
(and the `@bufi/modular-wallets-core` fork) talks to through `toModularTransport(clientUrl, clientKey)` — plus the
**deployer** that recreates Circle's production ERC-6900 v0.7 stack at Circle's canonical addresses on a local
[anvil](https://book.getfoundry.sh/anvil/) chain.

Together they let the SDK fork and the playground run end-to-end against BUFI's plugins with zero Circle credentials.

```
bun run --cwd packages/mock-circle dev        # anvil (unless one is listening) → deploy → serve
bun run --cwd packages/mock-circle deploy     # only deploy, write contracts/deployments/local.json
bun run --cwd packages/mock-circle serve      # only serve, from an existing local.json
bun run --cwd packages/mock-circle test       # bun test (spawns its own anvil per file)
```

Point the SDK at it:

```ts
import { toModularTransport } from '@bufi/modular-wallets-core'
const transport = toModularTransport('http://127.0.0.1:8788/v1/rpc/w3s/buidl', 'sandbox') // any non-empty key
```

## What the deployer does (`src/deploy.ts`)

Target: anvil at `http://127.0.0.1:8545` (chainId 31337). Deployer = anvil account #0, bundler = #1, paymaster
verifying signer = #2. Every step is idempotent — anything that already has code is skipped, so re-running against a
live chain sends no transactions.

| step | what                                                                                                                                                                                                  | address                                                                                        |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 0    | Arachnid CREATE2 deployer (anvil pre-installs it; `anvil_setCode` otherwise)                                                                                                                          | `0x4e59b44847b379578588920cA78FbF26c0B4956C`                                                   |
| 1    | EntryPoint v0.7 from `contracts/out/EntryPoint.sol` — deployed normally (its constructor creates the immutable `SenderCreator`), runtime copied to the canonical address with `anvil_setCode`          | `0x0000000071727De22E5E9d8BAf0edAc6f37da032`                                                   |
| 2    | Circle's four contracts via CREATE2 with **Circle's shipped creation bytecode, salts and constructor args** (`contracts/lib/buidl-wallet-contracts/script/bytecode-deploy/`) — the production addresses | PluginManager `0x00000005e69188224e4dEeF607801916DC0936d5`                                     |
|      |                                                                                                                                                                                                       | UpgradableMSCAFactory `0x0000000DF7E6c9Dc387cAFc5eCBfa6c3a6179AdD` (owner `0x0166EA90…58785`)  |
|      |                                                                                                                                                                                                       | UpgradableMSCA impl `0xA70F1296869DA9D7CB69578123F21888E6dB2B62` (deployed by the factory ctor) |
|      |                                                                                                                                                                                                       | ColdStorageAddressBookPlugin `0x0000000d81083B16EA76dfab46B0315B0eDBF3d0`                      |
|      |                                                                                                                                                                                                       | WeightedWebauthnMultisigPlugin `0x0000000C984AFf541D6cE86Bb697e68ec57873C8`                    |
| 3    | Manifest hashes recomputed from chain and asserted against Circle's: weighted `0xa04332…0fd91`, address book `0x9d177c…349d8`                                                                          |                                                                                                |
| 4    | `SandboxUSDC` (6 decimals, open `mint`), 1,000,000 USDC minted to the deployer                                                                                                                        | CREATE2, salt `keccak256("bufi-6900-sandbox")`                                                 |
| 5    | Circle's `SponsorPaymaster` — impl + `ERC1967Proxy` (`initialize(owner = deployer, [signer])`), `addStake(1 day)` 1 ETH, `deposit()` 10 ETH into the EntryPoint                                        | CREATE2, sandbox salt                                                                          |
| 6    | BUFI plugins from `contracts/out/{BufiSessionKeyPlugin,BufiEarnModule}.sol` when built (`null` in local.json otherwise); constructor args resolved by name (`entryPoint`, `owner`/`relayer` → deployer) | CREATE2, sandbox salt                                                                          |
| 7    | Factory allowlist: `anvil_impersonateAccount(0x0166EA…)` → `setPlugins([addressBook, weighted, …bufi], true…)`                                                                                         |                                                                                                |
| 8    | `contracts/deployments/local.json` (shape below — what the SDK fork's `toStackDeployment` parses)                                                                                                     |                                                                                                |

Manifest hashes are `keccak256(pluginManifest() raw return data)`, which equals `keccak256(abi.encode(manifest))`
(a single struct return value is ABI-encoded as a one-element tuple, byte-for-byte `abi.encode(struct)`);
`test/deploy.test.ts` pins both to Circle's published hashes.

```json
{
  "chainId": 31337,
  "rpcUrl": "http://127.0.0.1:8545",
  "entryPoint": "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
  "create2Deployer": "0x4e59b44847b379578588920cA78FbF26c0B4956C",
  "pluginManager": "0x00000005e69188224e4dEeF607801916DC0936d5",
  "upgradableMscaFactory": "0x0000000DF7E6c9Dc387cAFc5eCBfa6c3a6179AdD",
  "upgradableMscaImpl": "0xA70F1296869DA9D7CB69578123F21888E6dB2B62",
  "plugins": {
    "weightedWebauthnMultisig": { "address": "0x0000000C98…", "manifestHash": "0xa04332…" },
    "coldStorageAddressBook": { "address": "0x0000000d81…", "manifestHash": "0x9d177c…" },
    "bufiSessionKey": { "address": "0x…", "manifestHash": "0x…" },
    "bufiEarnModule": { "address": "0x…", "manifestHash": "0x…" }
  },
  "paymaster": { "address": "0x…", "signer": "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" },
  "tokens": { "usdc": "0x…" },
  "accounts": {
    "deployer": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    "bundler": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    "factoryOwner": "0x0166EA90E565476f13c6a0D25ED2C35599E58785"
  }
}
```

`bufiSessionKey` / `bufiEarnModule` / `paymaster` are `null` when absent.

## The server (`src/server.ts`)

`POST http://127.0.0.1:8788/v1/rpc/w3s/buidl` (mirrors `https://modular-sdk.circle.com/v1/rpc/w3s/buidl`),
JSON-RPC 2.0, single or batch, `Authorization: Bearer <anything non-empty>` required (401 otherwise), request `id`
echoed, CORS open so the Vite playground can call it from a browser. `GET /health` lists the methods.

| method                            | behaviour                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `circle_getAddress`               | `[{ scaConfiguration: { initialOwnershipConfiguration: { weightedMultisig: { owners?, webauthnOwners?, thresholdWeight } }, scaCore: 'circle_6900_v1' }, metadata: { name } }]` → `ModularWallet`. Address derived exactly like the SDK: `factory.getAddress(sender, 0x00…, abi.encode([weighted], [manifestHash], [installData]))` via `eth_call`; `initCode` = factory ‖ `createAccount` calldata; `blockchain: "ANVIL"`, `state: "LIVE"`. In-memory, stable id per owner set. |
| `circle_getAddressMapping`        | `[{ owner: { type: 'EOAOWNER' \| 'WEBAUTHOWNER', identifier } }]` → explicit mappings first, then wallets minted through `circle_getAddress` for that owner.                                                                                                                                                                                                                                                                      |
| `circle_createAddressMapping`     | `[{ walletAddress, owners: [...] }]` → one `AddressMappingResponse` per owner (in-memory).                                                                                                                                                                                                                                                                                                                                       |
| `circle_getUserOperationGasPrice` | `{ low, medium, high: { maxPriorityFeePerGas, maxFeePerGas }, deployed, notDeployed }` — hex quantities from anvil's base fee (2× base-fee headroom, 100 / 120 / 150 % tip), `deployed` 600 000, `notDeployed` 1 500 000 (the SDK's default verificationGasLimit).                                                                                                                                                              |
| `eth_supportedEntryPoints`        | `[EntryPoint v0.7]`                                                                                                                                                                                                                                                                                                                                                                                                             |
| `eth_estimateUserOperationGas`    | Static: `preVerificationGas` 100k, `verificationGasLimit` 3M, `callGasLimit` 3M, plus `paymasterVerificationGasLimit` 150k / `paymasterPostOpGasLimit` 50k when a paymaster is present. No simulation — the EntryPoint refunds the unused part.                                                                                                                                                                                 |
| `eth_sendUserOperation`           | v0.7 wire format (`factory`/`factoryData`, `paymaster`/`paymasterData`/…). Packs into `PackedUserOperation`, hashes with `EntryPoint.getUserOpHash`, dry-runs `handleOps([op], bundler)`; a validation failure returns the decoded `FailedOp` / `FailedOpWithRevert` (`-32507` for AA24/AA34, `-32501` for AA3x, `-32500` otherwise, `data: { opIndex, reason, inner?, innerReason? }`). Otherwise submits from the bundler key, waits for the receipt, returns the hash. |
| `eth_getUserOperationByHash`      | `{ userOperation, entryPoint, transactionHash, blockHash, blockNumber }` or `null`.                                                                                                                                                                                                                                                                                                                                             |
| `eth_getUserOperationReceipt`     | Parsed from the bundle tx's `UserOperationEvent`: `{ userOpHash, entryPoint, sender, nonce, paymaster?, actualGasCost, actualGasUsed, success, reason?, logs, receipt }` — `logs` are the op's own logs, `receipt` the raw tx receipt.                                                                                                                                                                                              |
| `eth_chainId` `eth_getBalance` `eth_blockNumber` `eth_call` `eth_getBlockByNumber` `eth_maxPriorityFeePerGas` `eth_gasPrice` `eth_getCode` (+ `eth_feeHistory`, `eth_getTransactionReceipt`, `eth_getLogs`, …) | Proxied to anvil verbatim, errors included.                                                                                                                                                                                                                                                                                                                                             |
| `pm_getPaymasterStubData`         | ERC-7677 `[userOp, entryPoint, chainId, context]` → `{ paymaster, paymasterData: abi.encode(validUntil, validAfter) ‖ 65 dummy bytes, paymasterVerificationGasLimit, paymasterPostOpGasLimit, sponsor: { name: 'BUFI sandbox' }, isFinal: false }`.                                                                                                                                                                              |
| `pm_getPaymasterData`             | Sponsors every op: `hash = SponsorPaymaster.getHash(op, verGas, postOpGas, validUntil, validAfter)` via `eth_call`, signed EIP-191 (`toEthSignedMessageHash`) with the verifying signer → `paymasterData = abi.encode(uint48 validUntil, uint48 validAfter) ‖ signature`, `isFinal: true`. `validUntil` = latest block timestamp + `MOCK_PAYMASTER_VALID_SECS` (3600; `0` = no expiry), `validAfter` = 0.                          |
| `rp_getRegistrationOptions`       | `[username]` → `CustomPublicKeyCredentialCreationOptions` (random challenge/user id, `rp.id` = `MOCK_CIRCLE_RP_ID`, Circle's COSE algorithm list, resident key required).                                                                                                                                                                                                                                                       |
| `rp_getRegistrationVerification`  | `[credential]` → `{ verified: true }`; records the credential id and `response.publicKey` when the browser's `toJSON()` includes it.                                                                                                                                                                                                                                                                                              |
| `rp_getLoginOptions`              | `[credentialId]` → `CustomPublicKeyCredentialRequestOptions` (`allowCredentials` = that id, or discoverable when empty).                                                                                                                                                                                                                                                                                                         |
| `rp_getLoginVerification`         | `[credential]` → `{ publicKey }` recorded at registration; `-32602` for an unknown credential or one registered without a public key.                                                                                                                                                                                                                                                                                             |
| anything else                     | `-32601`                                                                                                                                                                                                                                                                                                                                                                                                                        |

**The `rp_*` methods are deterministic stubs, not a relying party.** No attestation is parsed, no assertion
signature is verified, no challenge is tracked. They exist so `toWebAuthnCredential()` can run against the mock in a
browser; the WebAuthn *owner* validation still happens on-chain in `WeightedWebauthnMultisigPlugin`.

### SponsorPaymaster `paymasterAndData` layout

```
[0:20]    paymaster                              ┐ packed by the SDK / viem from `paymaster`
[20:36]   uint128 paymasterVerificationGasLimit  │ and the two gas limits
[36:52]   uint128 paymasterPostOpGasLimit        ┘
[52:116]  abi.encode(uint48 validUntil, uint48 validAfter)   ┐ = `paymasterData`
[116:]    65-byte ECDSA signature                             ┘
signature = sign(toEthSignedMessageHash(keccak256(abi.encode(packUpToPaymasterAndData(op), verGas, postOpGas, chainId, paymaster, validUntil, validAfter))))
```

### Weighted-multisig EOA signature (what the tests use)

For a 1-of-1 EOA owner the userOp signature is a single 65-byte `[r ‖ s ‖ v]` chunk with **v = 27/28 + 32**
(59/60): the "+32" marks the chunk as signed over the actual digest `toEthSignedMessageHash(userOpHash)` (SDK
`wrapEoaSignature({ hasUserOpGas: true })`). k-of-n adds more chunks, ascending by owner id, exactly one of them the
+32 one; the rest sign the minimal digest (gas fields zeroed).

## Configuration

| env                        | default                             | meaning                                     |
| -------------------------- | ----------------------------------- | ------------------------------------------- |
| `ANVIL_RPC_URL`            | `http://127.0.0.1:8545`             | the chain                                   |
| `MOCK_CIRCLE_PORT`         | `8788`                              | mock API port                               |
| `MOCK_CIRCLE_HOST`         | `127.0.0.1`                         | mock API bind address                       |
| `DEPLOYMENTS_PATH`         | `contracts/deployments/local.json`  | deployment file                             |
| `MOCK_CIRCLE_RP_ID`        | `localhost`                         | `rp.id` / `rpId` in the `rp_*` stubs        |
| `MOCK_PAYMASTER_VALID_SECS`| `3600`                              | paymaster `validUntil` window; `0` = never  |
| `BUFI_6900_ROOT`           | auto (nearest `contracts/foundry.toml`) | repo root for artifact lookup           |

`dev` flags: `--no-anvil` (never spawn, fail if nothing listens), `--port <n>`, `--rpc-url <url>`.

Artifacts: Circle bytecode from `contracts/lib/buidl-wallet-contracts/script/bytecode-deploy/build-output/`, ours
from `contracts/out/` (`forge build` runs once under `/tmp/bufi6900-forge.lock` when a required artifact is missing).

## curl

```bash
MOCK=http://127.0.0.1:8788/v1/rpc/w3s/buidl
H=(-H 'Authorization: Bearer sandbox' -H 'content-type: application/json')

# entry points / chain
curl -s $MOCK "${H[@]}" -d '{"jsonrpc":"2.0","id":1,"method":"eth_supportedEntryPoints","params":[]}'
curl -s $MOCK "${H[@]}" -d '{"jsonrpc":"2.0","id":2,"method":"eth_chainId","params":[]}'

# counterfactual 1-of-1 MSCA for an EOA owner (anvil #0)
curl -s $MOCK "${H[@]}" -d '{"jsonrpc":"2.0","id":3,"method":"circle_getAddress","params":[{"scaConfiguration":{"initialOwnershipConfiguration":{"weightedMultisig":{"owners":[{"address":"0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266","weight":1}],"thresholdWeight":1}},"scaCore":"circle_6900_v1"},"metadata":{"name":"demo"}}]}'

# gas price tiers
curl -s $MOCK "${H[@]}" -d '{"jsonrpc":"2.0","id":4,"method":"circle_getUserOperationGasPrice","params":[]}'

# paymaster stub (ERC-7677)
curl -s $MOCK "${H[@]}" -d '{"jsonrpc":"2.0","id":5,"method":"pm_getPaymasterStubData","params":[{"sender":"0x0000000000000000000000000000000000000001","nonce":"0x0","callData":"0x"},"0x0000000071727De22E5E9d8BAf0edAc6f37da032","0x7a69",{}]}'

# receipt of a submitted op
curl -s $MOCK "${H[@]}" -d '{"jsonrpc":"2.0","id":6,"method":"eth_getUserOperationReceipt","params":["0x<userOpHash>"]}'
```

## Tests

`bun test` (timeout 240 s). Each file boots its own anvil on a free port, deploys, and starts the mock on port 0:

- `deploy.test.ts` — canonical addresses, `ACCOUNT_IMPLEMENTATION`, both manifest hashes, factory owner + allowlist,
  paymaster init/stake/deposit, USDC mint, `local.json` shape, idempotent re-run (no new blocks).
- `bundler.test.ts` — auth + `-32601`, id echo + proxied reads, `circle_getAddress` ≡ SDK offline `computeAddress`
  (SDK's own ERC1967Proxy creation code), address mappings, gas-price tiers, then a real 1-of-1 MSCA deployed with
  `initCode` transferring SandboxUSDC via viem's `createBundlerClient` (estimate → send → receipt → getUserOperation),
  and an AA24 rejection with the decoded `FailedOp`.
- `paymaster.test.ts` — ERC-7677 stub → estimate → real data via viem's `createPaymasterClient`, `paymasterAndData`
  re-parsed on-chain and recovered to the verifying signer, sponsored deploy+transfer for an account with 0 ETH
  (paymaster deposit drops by `actualGasCost`), and an AA34 rejection for a tampered signature.
