# @bufi/modular-wallets-core

A fork of Circle's [Modular Wallets Web SDK](https://github.com/circlefin/modularwallets-web-sdk) with first-class support for BUFI's ERC-6900 plugins and for cascade wallets. It is a drop-in superset of `@circle-fin/modular-wallets-core`: every upstream export, signature and test is preserved, and every BUFI addition defaults to the canonical Circle deployment.

## Provenance

| | |
| --- | --- |
| Upstream repository | `circlefin/modularwallets-web-sdk` |
| Upstream commit | `2a628e8` |
| Upstream package | `@circle-fin/modular-wallets-core` 1.0.15 (`packages/w3s-web-core-sdk`) |
| License | Apache-2.0 (unchanged; see `LICENSE`) |
| This package | `@bufi/modular-wallets-core` 1.0.15-bufi.0 |

Files carried over unchanged keep Circle's copyright header. Modified upstream files carry an additional `Modifications Copyright (c) 2026 BUFI` line; new files carry a BUFI Apache-2.0 header in the same format. `git diff` against the upstream package stays reviewable: the upstream changes are surgical parameter additions, listed under "Deployment and transport options" below.

The upstream tooling templates (`templates/{eslint-config,jest,tsconfig}`) live under `tooling/` in this repository and keep their `@templates/*` package names. The repository uses bun workspaces instead of pnpm, so `catalog:` versions were replaced with the pinned versions from the upstream catalogs.

## What was added

### Stack deployments

`CIRCLE_CANONICAL_DEPLOYMENT` describes the Circle stack (EntryPoint v0.7, UpgradableMSCA factory and implementation, PluginManager, WeightedWebauthnMultisig, ColdStorageAddressBook). `toStackDeployment(json)` validates and loads the deployment file produced by the sandbox deploy script (`contracts/`) and served by the mock Circle API, which additionally carries the BUFI session key plugin, the earn module, a paymaster and token addresses.

### Plugin primitives (`src/actions/plugins/`)

Encode helpers are pure; client actions take Circle's `(client, parameters)` shape.

- **Plugin manager**: `encodeInstallPlugin` / `encodeUninstallPlugin` (return an `execute`-ready `{ to: account, value, data }` call), `installPlugin` / `uninstallPlugin` (send the user operation), `getInstalledPlugins` (the `IAccountLoupe` read that is the only source of truth for installed state), `getPluginManifestHash` / `hashPluginManifest` (`keccak256(abi.encode(pluginManifest()))`).
- **Address book** (Circle `ColdStorageAddressBookPlugin`): `encodeAddAllowedRecipients`, `encodeRemoveAllowedRecipients`, `encodeAddressBookInstallData`, `addressBookDependencies`, `encodeInstallAddressBook`, `getAllowedRecipients`.
- **Session keys** (BUFI agentic wallet policy; the on-chain ABI is Alchemy MAv1's `ISessionKeyPlugin` + `ISessionKeyPermissionsUpdates`, kept verbatim): `encodeAddSessionKey`, `encodeRemoveSessionKey`, `encodeRotateSessionKey`, `encodeUpdateKeyPermissions`, `encodeExecuteWithSessionKey`, the eight permission-update encoders (`encodeSetAccessListType`, `encodeUpdateAccessListAddressEntry`, `encodeUpdateAccessListFunctionEntry`, `encodeUpdateTimeRange`, `encodeSetNativeTokenSpendLimit`, `encodeSetERC20SpendLimit`, `encodeSetGasSpendLimit`, `encodeSetRequiredPaymaster`), the loupe reads (`getSessionKeys`, `isSessionKeyOf`, `findPredecessor`, `getKeyTimeRange`, `getERC20SpendLimitInfo`, `getGasSpendLimit`, `getNativeTokenSpendLimitInfo`, `getAccessControlType`, `getAccessControlEntry`, `isSelectorOnAccessControlList`, `getRequiredPaymaster`), `sessionKeyDependencies`, `encodeSessionKeyInstallData`, `encodeInstallSessionKeyPlugin`, and the grant DSL `buildBufiGrant({ scope, budget, expiry })` that compiles BUFI's policy vocabulary into ordered permission updates.
- **Earn** (`BufiEarnModule`): `computeEarnConfigHash` (byte-matches the on-chain `setConfig` hash), `encodeAutoEarn`, `encodeChangeConfigHash` (an owner-gated execution function on the account), `encodeEarnModuleInstallData`, `earnModuleDependencies` (the same two weighted-multisig dependency slots as the address book), `encodeInstallEarnModule`, `getEarnConfigs`.
- **Weighted multisig**: `encodeUpdateMultisigWeights`.

### Submitting management calls: raw calldata, one per user operation

Every call that targets the account itself (`installPlugin`/`uninstallPlugin`, `updateMultisigWeights`, `addAllowedRecipients`, `addSessionKey`, `changeConfigHash`, …) must be submitted as the raw user operation calldata: `sendUserOperation({ callData: call.data })`, which is what `installPlugin` and `uninstallPlugin` do. Never pass such a call through `calls`: viem wraps it in `execute(account, 0, data)`, and on the Circle MSCA a self-call is not the EntryPoint, so the account re-enters runtime validation, which the WeightedWebauthnMultisigPlugin always rejects (its runtime validation for management functions is an always-revert function, and the dependency slot 0 of the address book, session key and earn plugins is the deliberately unimplemented id 1). Only the EntryPoint path, validated by the owners' user operation validation, reaches these functions, and it carries exactly one such call per user operation. Session key user operations are unaffected: `toBufiSessionKeyAccount` emits `executeWithSessionKey(...)` as the calldata itself.

### The agent client

`toBufiSessionKeyAccount({ client, account, sessionKey, plugin, deployment? })` returns a viem `SmartAccount` for an already-deployed account that wraps calls in `executeWithSessionKey(calls, sessionKey)` and signs the user operation hash with the session key (65-byte ECDSA over `toEthSignedMessageHash(userOpHash)`, which is what the plugin recovers). It has no factory args and refuses to sign messages or typed data, because the session key validation path only covers user operations.

### Cascade wallets

`bufiCascadeActions(client)` / `toBufiCascadeClient({ client })` decorate a client with plugin management and the address book, session key and earn reads. `src/cascade/` holds the encode-only helpers that compose the primitives into the sequence BUFI uses:

- `buildTreasuryBootstrapCalls` returns the re-weighting of the bootstrap signer and the address book install as **two separate user operations**. They must never be batched: a plugin whose manifest depends on the ownership plugin's validation is wired to it at install time, and installing in the same user operation that re-weights would be validated by the old weights.
- `buildAgentFaceCalls` returns either the session key plugin install (seeded with the agents' keys and grants) or one `addSessionKey` per agent, depending on what `getInstalledPlugins` reports.

## Deployment and transport options

Every parametrized upstream function keeps its original behaviour when the new option is omitted:

| Function | Added option |
| --- | --- |
| `toCircleSmartAccount({ …, deployment? })` | EntryPoint, factory, implementation and ownership plugin of the stack the account lives on |
| `computeAddress(owner, deployment?)` | CREATE2 factory, implementation and ownership plugin |
| `getInitializeUpgradableMSCAData(owner, deployment?)` / `getInitializeUpgradableMSCAParams(owner, deployment?)` | ownership plugin address and manifest hash |
| `toReplaySafeHash({ …, deployment? })` | the weighted multisig plugin is the EIP-712 `verifyingContract` |
| `toModularTransport(clientUrl, clientKey, { trustedHosts? })` | extra `host[:port]` values (for example `127.0.0.1:8788`) that mark the transport as a Modular Wallets transport, which is what makes `toCircleSmartAccount` resolve the address through `circle_getAddress` |
| `isCircleUrl(url, trustedHosts?)` | same allowlist extension |
| `fetchFromApi` | guards `window` so the SDK runs under node and bun |

`FACTORY`, `UPGRADABLE_MSCA` and `CIRCLE_WEIGHTED_WEB_AUTHN_MULTISIG_PLUGIN` remain exported for compatibility.

## Circle-style guidelines

The fork follows the upstream layout so that upstream syncs and BUFI additions do not fight each other. To add an action:

1. Put the on-chain ABI fragment in `src/abis/<plugin>.ts` (`as const`) and export it from `src/abis/index.ts`.
2. Put shared shapes in `src/types/bufi.ts` (or `src/types/<domain>.ts`), exported through `src/types/index.ts`, and re-export the public ones from `src/index.ts` under `// Types`.
3. Create one file per action under `src/actions/plugins/<plugin>/`. Pure encoders are named `encode<Function>` and return calldata, or an `EncodedCall` when the target is fixed. Client actions are `async function <name>(client, params)` with an exported `<Name>Parameters` interface; reads go through `readContract` from `viem/actions`, writes through `sendUserOperation` from `viem/account-abstraction` and resolve the account as `client.account ?? params.account`.
4. Export the file from the plugin's `index.ts`; the plugin barrel is re-exported by `src/actions/plugins/index.ts` and `src/actions/index.ts`.
5. Surface reads and writes on `bufiCascadeActions` in `src/clients/decorators/bufiCascade.ts` (typed member with TSDoc, delegating to the action).
6. Add TSDoc to every export (`@param` / `@returns` / `@throws`; the lint rules require complete sentences and no indentation inside blocks).
7. Mirror the source path under `src/__tests__/` and put fixtures in `src/__mocks__/` (`*.Mock.ts`). Assert calldata against an ABI declared inline in the test, so the encoder and the assertion do not share a definition, and spy on `viem/actions` / `viem/account-abstraction` rather than mocking transports.
8. Run `bun run check:type`, `bun run test:coverage` (80% global threshold), `bun run lint` and `bun run build` from the package directory.

## Sandbox quickstart

The sandbox deploys the whole Circle stack plus the BUFI plugins on a local anvil chain and serves the Modular Wallets API from a mock server.

```bash
bun install
bun run anvil            # local chain on 127.0.0.1:8545
bun run stack:deploy     # deploys the stack and writes the deployment file
bun run mock:circle      # mock Circle API at http://127.0.0.1:8788/v1/rpc/w3s/buidl
```

```ts
import { createBundlerClient } from 'viem/account-abstraction'
import {
  toCircleSmartAccount,
  toModularTransport,
  toStackDeployment,
} from '@bufi/modular-wallets-core'

const deployment = toStackDeployment(await readDeploymentJson())
const transport = toModularTransport(
  'http://127.0.0.1:8788/v1/rpc/w3s/buidl',
  '<client-key>',
  { trustedHosts: ['127.0.0.1:8788'] },
)
const client = createBundlerClient({ transport, chain })
const account = await toCircleSmartAccount({ client, owner, deployment })
```

See `packages/mock-circle` for the mock server and `apps/playground` for an end-to-end walk through the treasury, operations and agent faces.
