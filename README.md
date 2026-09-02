# BUFI-6900

**ERC-6900 plugin sandbox for Circle Modular Smart Contract Accounts.**

One monorepo that (1) redeploys Circle's production MSCA stack — bit-for-bit, at Circle's own addresses — on a
local chain, (2) installs BUFI's plugins on it and proves they compose and enforce policy for multisig
operations and agentic wallets, (3) forks Circle's web SDK so those plugins are first-class in Circle's own
coding style, and (4) ships a mock Circle Modular Wallets API + playground so the whole thing runs with zero
Circle credentials. It is the artifact we hand to auditors and to Circle for plugin listing.

```
BUFI-6900/
├─ contracts/                     one Foundry project (solc 0.8.24 · paris · via_ir · 200 runs = Circle's profile)
│  ├─ lib/                        pinned upstream (git submodules, see "Provenance")
│  ├─ src/CircleStack.sol         compiles the vendored Circle v0.7 stack unchanged
│  ├─ src/bufi/v0.7/session/      BufiSessionKeyPlugin — agentic policy {scope, budget, expiry} (port of Alchemy MAv1)
│  ├─ src/bufi/v0.7/earn/         BufiEarnModule — auto-deposit idle USDC/EURC into ERC-4626 vaults
│  ├─ src/bufi/v0.8/gateway/      GatewayExecutionModule (ERC-6900 v0.8) for Circle Gateway
│  ├─ test/harness/               CircleStackHarness: Circle bytecode at Circle addresses + k-of-n signing
│  ├─ test/stack/                 canonical redeploy proofs
│  ├─ test/bufi/                  plugin unit + integration + composition + agentic-policy suites
│  └─ test/fork/                  Sepolia-fork suites (FOUNDRY_PROFILE=fork)
├─ packages/modular-wallets-core  @bufi/modular-wallets-core — fork of @circle-fin/modular-wallets-core + plugin actions
├─ packages/mock-circle           @bufi/mock-circle — Modular Wallets API + bundler + paymaster mock on anvil
├─ packages/msca-recovery         @bufi/msca-recovery — fork of circlefin/msca-wallet-recovery (independent lane)
├─ apps/playground                headless e2e + Vite UI against the mock
└─ docs/                          AUDIT-SCOPE · THREAT-MODEL · PLUGIN-COMPOSITION · CIRCLE-SUBMISSION
```

## Quickstart

```bash
mise install                     # node 24.18.0, bun 1.3.10 (foundry 1.5.x installed separately: foundryup)
git submodule update --init --recursive
bun install
bun run contracts:test           # forge: canonical redeploy + every plugin suite
bun run mock:circle              # anvil + Circle stack at canonical addresses + BUFI plugins + mock API on :8788
bun run sandbox:e2e              # SDK fork drives the full agentic-wallet flow against the mock
```

## What "redeploy Circle's stack" means here

Circle deploys its contracts with the Arachnid CREATE2 deployer and publishes the exact creation bytecode
and salts (`lib/buidl-wallet-contracts/script/bytecode-deploy/`). The harness and the deployer replay them
on a local chain, so the sandbox has **the production bytecode at the production addresses**:

| Contract | Address | Provenance |
| --- | --- | --- |
| EntryPoint v0.7 | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` | eth-infinitism `releases/v0.7` |
| PluginManager | `0x00000005e69188224e4dEeF607801916DC0936d5` | Circle salt `0x20828f…` |
| UpgradableMSCAFactory | `0x0000000DF7E6c9Dc387cAFc5eCBfa6c3a6179AdD` | Circle salt `0xda9f7b…` |
| UpgradableMSCA (impl) | `0xA70F1296869DA9D7CB69578123F21888E6dB2B62` | deployed by the factory constructor |
| WeightedWebauthnMultisigPlugin | `0x0000000C984AFf541D6cE86Bb697e68ec57873C8` | Circle salt `0x2cc3c6…`, manifest `0xa04332…` |
| ColdStorageAddressBookPlugin | `0x0000000d81083B16EA76dfab46B0315B0eDBF3d0` | Circle salt `0x36fdaa…`, manifest `0x9d177c…` |

Consequences: every SDK constant, manifest hash and EIP-712 replay-safe domain is valid unchanged; the factory
owner (`0x0166EA…`, part of the CREATE2 pre-image) is impersonated locally to allowlist plugins, exactly as
Circle's step 105 does in production.

## The plugins under audit

| Plugin | 6900 | What it enforces | Status |
| --- | --- | --- | --- |
| `BufiSessionKeyPlugin` | v0.7 / EP 0.7 | agent session keys: access lists (targets, selectors), ERC20 / native / gas spend limits with refresh intervals, `validAfter`/`validUntil` | port of Alchemy Modular Account v1.0.1 `SessionKeyPlugin` (Spearbit 2024-01-31, Quantstamp 2024-02-19) — see `contracts/src/bufi/v0.7/session/PORT-NOTES.md` |
| `BufiEarnModule` | v0.7 / EP 0.7 | relayer-triggered deposits into multisig-adopted ERC-4626 vaults (Morpho Vault V2 proven); deposit-only | port of FluidKey earn module (Ackee-audited) — see `EARN-NOTES.md`, `docs/EARN-MORPHO.md` |
| `BufiSessionRecipientHookPlugin` | v0.7 / EP 0.7 | AddressBook recipient set enforced on `executeWithSessionKey` (ERC-20 `transfer`/`approve`/`transferFrom` recipients, native targets) | new BUFI code, unaudited — `docs/PLUGIN-COMPOSITION.md` |
| `GatewayExecutionModule` | v0.8 | Circle Gateway delegate lifecycle for treasury MSCAs | from desk-v1 `multi-sig-gateway`; fork suites under `test/fork` |

Composition target: **WeightedWebauthnMultisigPlugin (owners) + ColdStorageAddressBookPlugin (recipients) +
BufiSessionKeyPlugin (agent authority) + BufiEarnModule (yield)** on one account. Findings live in
`docs/PLUGIN-COMPOSITION.md`.

## Testnet deployments (2026-09-01)

Deployed with `script/DeployBufiPlugins.s.sol` through the Arachnid CREATE2 deployer (salt
`keccak256("bufi-6900-plugins-v0.1.0")`), so the addresses are identical on every chain. Circle's canonical stack
is Circle's own production deployment on these chains. Records: `contracts/deployments/{avax-fuji,arc-testnet}.json`,
receipts under `contracts/broadcast/DeployBufiPlugins.s.sol/{43113,5042002}/`. SDK constants:
`AVAX_FUJI_DEPLOYMENT`, `ARC_TESTNET_DEPLOYMENT`.

| Plugin | Avalanche Fuji (43113) + Arc testnet (5042002) | Manifest hash |
| --- | --- | --- |
| `BufiSessionKeyPlugin` | `0xBd607dBAC82CF1351C352FB65fC29dE9D0095339` | `0xa32b3449…cb11ff5d` |
| `BufiEarnModule` (owner + relayer = testnet deployer placeholder `0x09Ce8E2B…`, rotate before shared use) | `0xeb94A8b7412418B506b24dBeD4Aed0E9ba5453c2` | `0x5adab689…a96652e53` |

Redeployed 2026-09-02 (salt `…-v0.2.0`) with the fixes for adversarial findings F-01 / F-06 / F-08. The
2026-09-01 builds `0x28504B34…` (session key) and `0x57D446a9…` (earn) carry pre-fix bytecode and must not be
installed; manifest hashes are unchanged, only the implementations moved.

The 2026-08-02 earn build at `0xA9a9251f…` (both chains) is superseded and must never be installed (finding 2).
Explorer verification is not done (no API keys in the sandbox); `forge verify-contract` with the pinned profile
reproduces the bytecode.

## Live canary on Avalanche Fuji (Circle's real API + bundler, 2026-09-02)

`bun run scripts/live/install-on-fuji.ts` (needs `CIRCLE_CLIENT_KEY`/`CIRCLE_CLIENT_URL`, `OWNER_PRIVATE_KEY`,
`MODULAR_WALLETS_APP_URI`). Record: `contracts/deployments/avax-fuji.canary.json`.

| Step | Result |
| --- | --- |
| `circle_getAddress` for an EOA owner → Circle Smart Account | `0x431bebb64552cefb2fbdb3968c75307aa709dc2b` |
| Owner userOp (raw calldata) deploys the account AND installs `BufiSessionKeyPlugin` with the fail-closed dependency slots | tx `0x7e246342…5cad08b`, `getInstalledPlugins` = [Weighted, `0x28504B34…`] |
| Owner grants an agent key (`addSessionKey`, raw calldata) | tx `0x3b41b9ec…59cffc` |
| Agent (`toBufiSessionKeyAccount`) transfers 1 USDC through Circle's bundler | userOp `0x87d3ea2c…`, tx `0xd451b2fe…` |
| `ColdStorageAddressBookPlugin` installed on the same account | tx `0xd50eaf5b…` |

Plan 184's two PENDING proofs (testnet install, AddressBook composition) are therefore answered on a real Circle
account. Three SDK-fork fixes came out of the run — none of which the local mock could catch because it does not
simulate validation: Circle validates the `X-AppInfo` `uri` against the client key's domain (headless callers must
pass `appUri` / `MODULAR_WALLETS_APP_URI`), bundlers simulate with the account's stub signature so the session-key
stub must be a real secp256k1 signature (an off-curve dummy made the plugin revert `InvalidSignature`), and the
session-key account needs Circle's verification-gas floor hook like `toCircleSmartAccount` does.

## Adversarial review

`reports/ADVERSARIAL_PRE_TENDERLY.md` — an adversarial pass over the three custom plugins run through Codex
(gpt-5.6-sol, xhigh) against the production-bytecode harnesses, with a PoC suite in `contracts/test/adversarial/`
(34 tests, kept as permanent regressions). **No Critical or High.** One Medium and two Informational were fixed
(F-01 nonce-lane liveness → port deviation D10; F-06 earn now verifies the deposit; F-08 canonical config
ordering); five Low findings were accepted with mitigations recorded in the report's §Disposition and pinned by
`test_KNOWN_F0N_…` tests. The recurring theme in the accepted set: the recipient hook enforces the **syntactic**
recipient in calldata, so an allowlisted spender or a selector-compatible contract can still route value onward —
the AddressBook is a trust list, not a firewall against code you allowlisted.

## Findings surfaced by the sandbox

1. **Stock Alchemy `SessionKeyPlugin` cannot be installed on a Circle MSCA.** It targets ERC-4337 v0.6
   (`UserOperation`); Circle's `IPlugin` uses v0.7 `PackedUserOperation`, so the ERC-165 interface ids differ and
   `PluginManager.install` reverts `PluginNotImplementInterface`. The port to v0.7 is the BUFI plugin; ABI and
   storage layout are byte-identical to the audited original, the one behavioural change is the v0.7 gas formula.
2. **The `BufiEarnModule` build deployed 2026-08-02 at `0xA9a9…` (Fuji + Arc testnet) has the same defect** —
   it was written against a vendored `IERC6900.sol` using the v0.6 struct. It compiled and deployed, but Circle's
   account would reject its install. Also, its `changeConfigHash` was unreachable on a real account (not an
   execution function; `execute(plugin, …)` reverts `TargetIsPlugin`). Both fixed here; redeploy required.
3. **AddressBook hooks are selector-scoped** (`execute` / `executeBatch`). Neither the earn deposit path
   (`executeFromPluginExternal`) nor `executeWithSessionKey` is gated by the recipient allowlist. Earn is bounded by
   the multisig-adopted config hash instead; session keys by their own access list — which gates target + selector,
   so ERC-20 recipients were not gateable per key (native transfers are). **Closed by `BufiSessionRecipientHookPlugin`**
   (`contracts/src/bufi/v0.7/recipient-hook/`, new unaudited code): a SELF pre-validation hook on
   `executeWithSessionKey` that resolves recipients with Circle's own `RecipientAddressLib` against the AddressBook
   set — +18.4k gas per agent transfer with a 5-entry allowlist, no list mirroring. See `docs/PLUGIN-COMPOSITION.md`.
4. **Weighted multisig owners cannot act at runtime**, only through userOps. Any plugin whose management
   functions take a runtime-validation dependency must point that slot at the deliberately unimplemented
   function id 1 (fail-closed) and the userOp slot at id 0 — Circle's own AddressBook precedent. Corollary for
   SDKs: management calls are raw userOp calldata, never wrapped in `execute(account, …)`.
5. **Gas-limited session keys must use their address as nonce key** (audited upstream rule). viem's
   `toSmartAccount` injects a time-derived key, so the SDK's session-key account pins it.
6. **The ERC-20 budget is an execution-phase check**: an over-budget agent op is included and reverts on-chain
   (gas paid, no funds moved); time range, access list, gas and native limits reject at validation.
7. **`GatewayExecutionModule` (v0.8) cannot be a Gateway depositor**: Gateway attributes deposits/delegates to
   `msg.sender`, so the module would hold the position and share one depositor across every account — now also
   proven on a real Circle **v0.8** account (`test/bufi/v0.8/gateway/GatewayModuleOnCircleV08.t.sol`). Only the
   `GatewayHelper` direct-execution pattern is sound; the module is reference-only (`docs/GATEWAY-1271-EVALUATION.md`).
8. **Circle's v0.8 generation, observed on the vendored source** (not deployed by Circle yet): reference-implementation
   v0.8.0 and v0.8.1 are ABI-identical (only renamed); `allowGlobalValidation:false` is a hard per-selector gate and
   selector grants survive `uninstallExecution`; `installExecution` with empty install data skips the ERC-165 check;
   the v0.8 `ColdStorageAddressBookModule` is a *validation* hook (attached to the sole global validation it bricks
   administration, including its own removal), cannot be seeded through hook install data, and its manifest marks
   `addAllowedRecipients` as `skipRuntimeValidation` — **any stranger can extend an account's allowlist**. Do not
   install that WIP manifest on a treasury as-is; raised with Circle in `docs/CIRCLE-SUBMISSION.md`.
9. **Real bundlers simulate with the stub signature and validate the `X-AppInfo` uri** — three SDK fixes the local mock
   could not catch (see "Live canary"). Passkey owners on a chain without the P-256 precompile (anvil) need ~3M
   verification gas; the playground passes it explicitly.

## Test matrix (commit-pinned; regenerate with the commands in Quickstart)

| Suite | Count | What it pins |
| --- | --- | --- |
| `forge test` (default profile) | 229 | canonical redeploy (3) · earn unit (17) · earn on real MSCA (21) · gateway local (41) + on a real Circle v0.8 account (14) · session-key port on real MSCA (83) · session-key integration (22) · session-key × AddressBook (5) · agentic policy (5) · recipient hook (18) |
| `FOUNDRY_PROFILE=fork forge test --fork-url <base>` | 1 | Circle production MSCA on a Base-mainnet fork sweeps USDC into a live Morpho Vault V2 (`docs/EARN-MORPHO.md`) |
| `@bufi/modular-wallets-core` jest | 446 | 315 upstream unchanged + 131 BUFI (encoding vectors, grant DSL, deployment parametrisation, agent account, testnet constants) |
| `@bufi/mock-circle` bun test | 16 | canonical deploy + idempotence, bundler (initCode deploy + transfer, AA24), paymaster (sponsored op, AA34) |
| `@bufi/msca-recovery` bun test | 6 | independent lane (viem + permissionless, no BUFI SDK): session-key transfer through the sandbox bundler, nonce lane, budget |
| `bun run sandbox:e2e` | 6 steps | SDK → mock → stack → plugins: create/deploy, AddressBook gating, grant, agent spend/over-budget/off-scope, revoke, earn sweep |
| `apps/playground` UI (Vite) | smoke | same scenario in a browser, EOA and passkey (virtual authenticator) owners — `apps/playground/docs/playground.png` |
| `scripts/live/install-on-fuji.ts` | 5 steps | Circle's real API + bundler on Fuji: deploy, install session key, grant, agent spend, AddressBook |

## Evaluations

- `docs/GATEWAY-1271-EVALUATION.md` — a Gateway execution plugin is structurally wrong and unnecessary under ERC-1271; keep `GatewayHelper`.
- `docs/EARN-MORPHO.md` — Morpho Blue via Vault V2 is proven on a Base fork; direct Blue and Midnight stay behind adapters the multisig adopts.

## Provenance

| Submodule | Upstream | Pin |
| --- | --- | --- |
| `contracts/lib/buidl-wallet-contracts` | circlefin/buidl-wallet-contracts | `3c47aa9` (main, 2025-08-15) |
| `contracts/lib/msca-wallet-recovery-upstream` | circlefin/msca-wallet-recovery | `76c4168` (release-2025-03-18) |
| `contracts/lib/account-abstraction` | eth-infinitism/account-abstraction | `releases/v0.7` |
| `contracts/lib/openzeppelin-contracts{,-upgradeable}` | OpenZeppelin | `v5.0.2` |
| `contracts/lib/solady` · `FreshCryptoLib` · `modular-account-libs` · `erc6900-reference-implementation` | as Circle pins | `0.0.243` · `8179e08` · `v0.8.0-rc.0` · `v0.8.0` (+ `v0.8.1` alias for the Gateway module) |
| `contracts/lib/alchemy-modular-account` | alchemyplatform/modular-account | `v1.0.1` (reference for the session-key port; not compiled) |
| `packages/modular-wallets-core` | circlefin/modularwallets-web-sdk `packages/w3s-web-core-sdk` | `2a628e8` / 1.0.15 |

Licenses: Circle contracts GPL-3.0-or-later, Circle SDK + recovery Apache-2.0, Alchemy MAv1 GPL-3.0 /
MIT / CC0 per file, FluidKey AGPL-3.0. BUFI contracts are GPL-3.0-or-later; the SDK fork stays Apache-2.0.
