# @bufi/playground

The end-to-end proof that the pieces compose: `bun run sandbox:e2e` (from the repo root) boots the sandbox if it
is not running (`@bufi/mock-circle dev` = anvil + Circle stack at canonical addresses + BUFI plugins + Modular
Wallets API mock on `:8788`), then drives it exclusively through `@bufi/modular-wallets-core`:

1. owner EOA → `toCircleSmartAccount` (address resolved through `circle_getAddress` on the mock) → first userOp
   deploys the weighted-multisig MSCA and transfers USDC;
2. owner installs `ColdStorageAddressBookPlugin` (production dependency slots) — a transfer to a stranger is
   now rejected at validation;
3. owner installs `BufiSessionKeyPlugin` seeded with an agent grant `{scope: USDC.transfer, budget: 500 USDC /
   24h + gas, expiry: 7 days}` via `buildAgentFaceCalls`;
4. the agent (`toBufiSessionKeyAccount`) spends within budget, is rejected over budget, is rejected on an
   unlisted target / selector — and the script prints the composition finding that the address book does NOT
   gate `executeWithSessionKey`;
5. owner revokes the key; the agent is rejected;
6. if the earn module is deployed: module owner registers a vault config, the multisig adopts it at install,
   the relayer sweeps USDC into the vault, shares land on the account.

Every step asserts on-chain state through the SDK's read actions (`getInstalledPlugins`, `getAllowedRecipients`,
`getSessionKeys`, …). Exit code 0 = all green. Env: `MOCK_CIRCLE_URL`, `ANVIL_RPC_URL`, `DEPLOYMENTS_PATH`.

## Browser UI (`bun run dev`)

A fork of Circle's [`examples/circle-smart-account`](https://github.com/circlefin/modularwallets-web-sdk/tree/master/examples/circle-smart-account)
(Vite + React 19, passkey owner) pointed at the sandbox, with BUFI panels that drive the plugins through
`@bufi/modular-wallets-core`. Circle's layout is kept recognisable: `index.html` + `index.tsx` are the upstream entry,
`src/app.tsx` is the upstream `Example` component (Register / Login → account → Send User Operation) plus the owner
modes, and everything BUFI lives in `src/panels/`.

```bash
bun run mock:circle                       # repo root: anvil + Circle stack + BUFI plugins + Modular Wallets API mock
bun run --cwd apps/playground dev         # http://localhost:5173  (open via `localhost`, not 127.0.0.1 — passkey rpId)
bun run --cwd apps/playground build       # vite build → dist/
bun run --cwd apps/playground check:type  # scripts/** (bun tsconfig) + the UI (tsconfig.app.json)
```

Every value in `.env.example` has a sandbox default, so an empty `.env` works. The deployment is imported statically
from `contracts/deployments/local.json` (the file `mock:circle` writes; tracked in git). Chain = `{ ...foundry, id:
deployment.chainId }`.

| file                         | what                                                                                                                                                  |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/sandbox.ts`             | the shared wiring: `toStackDeployment`, `toPasskeyTransport` / `toModularTransport(url, key, { trustedHosts })`, public + bundler clients, anvil dev signers, `sendUserOp` |
| `src/state.ts`               | `useAccountState`: deployed?, `getInstalledPlugins` (AccountLoupe — the only source of truth for installed state), `getSessionKeys`, balances          |
| `src/ui.tsx`                 | `useOp` / `OpStatus`: every panel shows its last user operation hash, `receipt.success`, and the RPC error text                                      |
| `src/panels/owner.tsx`       | Circle's Account + Send User Operation sections, balances, dev-only **Fund me** (anvil #0 mints USDC + sends ETH)                                       |
| `src/panels/installed-plugins.tsx` | always visible list of what AccountLoupe reports, labelled                                                                                        |
| `src/panels/address-book.tsx` | `encodeInstallAddressBook` with an initial allowlist, `getAllowedRecipients`, add / remove                                                            |
| `src/panels/agent.tsx`       | agent key (localStorage), grant form (scope selectors, ERC-20 budget + window, gas budget + window, expiry) → `buildAgentFaceCalls`; key table from the loupe reads; revoke via `findPredecessor` + `encodeRemoveSessionKey` |
| `src/panels/agent-spend.tsx` | `toBufiSessionKeyAccount` + its own `createBundlerClient`; transfer form; out-of-scope buttons                                                          |
| `src/panels/earn.tsx`        | rendered when `deployment.bufiEarnModule` exists: config hash → `encodeInstallEarnModule`, `changeConfigHash`, `getEarnConfigs`, dev-only vault deploy (anvil #0) and relayer `autoEarn` (anvil #4, plain tx) |

### Owner modes

- **Passkey (default)** — Circle's flow, unchanged: `toWebAuthnCredential` against the mock's `rp_*` stubs (real
  WebAuthn options with rpId `localhost`; verification is stubbed and labelled as such in the UI), `toWebAuthnAccount`
  → `toCircleSmartAccount`. The on-chain P-256 owner check in `WeightedWebauthnMultisigPlugin` is real.
- **EOA owner (dev)** — a random private key kept in localStorage is the 1-of-1 weighted owner, so the whole flow runs
  in a browser without an authenticator (headless smoke tests, CI). Same path as `scripts/e2e.ts`.

`Forget owner` clears the owner from localStorage (a forgotten EOA key is gone for good — sandbox only). The sponsor
checkbox in the banner switches every op between `paymaster: true` (the mock's `pm_*` ERC-7677 path) and paying from
the account's own ETH.

### Rules the UI follows (and shows)

- **Management calls are raw user operation calldata, one per user operation** — plugin installs, `addAllowedRecipients`,
  `addSessionKey` / `removeSessionKey`, `changeConfigHash` all go out as `sendUserOperation({ callData: call.data })`,
  never through `calls: [{ to: account, … }]` (see the SDK README, "Submitting management calls").
- **Two failure shapes for agent spends**: scope / time range / gas budget are validation-phase → the mock returns the
  decoded `FailedOpWithRevert` and the panel shows it as an RPC error; the ERC-20 budget is an execution-phase check →
  the op is included and reverts on-chain, `receipt.success: false`, gas paid, no funds moved.
- **The address book gates `execute` / `executeBatch` only**: the owner's Send to an unlisted address is rejected at
  validation, while the agent's `executeWithSessionKey` to the same address succeeds (the composition finding from
  `docs/PLUGIN-COMPOSITION.md`), and the earn deposit path (`executeFromPluginExternal`) is not gated either.
- **Passkey owners on anvil need an explicit `verificationGasLimit`** (`PASSKEY_VERIFICATION_GAS_LIMIT` in
  `src/sandbox.ts`, 3M). The SDK's `userOperation.estimateGas` hook takes the limit from
  `circle_getUserOperationGasPrice` (`notDeployed` 1.5M / `deployed` 600k on the mock), which is sized for chains with
  the RIP-7212 P-256 precompile; anvil has none, the plugin falls back to the Solidity FCL verifier, and the
  EntryPoint answers `AA26 over verificationGasLimit`. The hook and viem both honour a caller-supplied value, so the
  app passes one for WebAuthn owners only. Alternatives that would remove the workaround: run anvil with the
  precompile (`--odyssey`) or raise the mock's `deployed` / `notDeployed` tiers.

### Smoke (2026-09-02, headless Chromium via Playwright)

`docs/playground.png` is the page after the EOA-owner drive below (full page, 1280 px wide).

1. load → 0 console errors / warnings; EOA owner generated; **Fund me** → 10,000 USDC + 5 ETH;
2. Send 1 USDC (sponsored) → `receipt.success: true`, account deployed, loupe lists the weighted multisig;
3. Install address book `[friend]` → listed; owner Send to a stranger → `AA23 reverted` (address book custom error);
   add stranger → listed; remove → gone;
4. Generate agent key → **Install plugin + grant** (USDC.transfer · 500 USDC / 24h · 1 ETH gas / 24h · 7 days) → key
   table shows the time range and `0 / 500`;
5. Agent spend 200 → friend ✔ · 10 → stranger ✔ (address book not consulted) · 250 → friend ✔ (`460 / 500`) · 100 →
   **included, `receipt.success: false`** · `approve` and a self-call → rejected at validation;
6. Revoke → `sessionKeysOf` empty, Agent spend panel drops to "no grant";
7. Earn: dev button deploys a `MockVault`, `setConfig`, authorizes anvil #4 → install with the computed hash →
   `getAllConfigs` lists the vault → relayer `autoEarn(USDC, 1000)` → 1,000 vault shares on the account.
8. Passkey path with a Chromium virtual authenticator (CDP `WebAuthn.addVirtualAuthenticator`): Register `alice` →
   account for a `WEBAUTHOWNER` → first op deploys it (P-256 verified on-chain) → second transfer → address book
   install signed by the passkey. Without the `verificationGasLimit` override the first op fails with `AA26`.

The same scenario runs headlessly with `bun run e2e` (exit 0 = `ALL GREEN`); the UI mirrors `scripts/e2e.ts` step by step.
