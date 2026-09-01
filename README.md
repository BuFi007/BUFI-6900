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
| `BufiEarnModule` | v0.7 / EP 0.7 | relayer-triggered deposits into multisig-adopted ERC-4626 vaults; deposit-only | port of FluidKey earn module (Ackee-audited) — see `EARN-NOTES.md` |
| `GatewayExecutionModule` | v0.8 | Circle Gateway delegate lifecycle for treasury MSCAs | from desk-v1 `multi-sig-gateway`; fork suites under `test/fork` |

Composition target: **WeightedWebauthnMultisigPlugin (owners) + ColdStorageAddressBookPlugin (recipients) +
BufiSessionKeyPlugin (agent authority) + BufiEarnModule (yield)** on one account. Findings live in
`docs/PLUGIN-COMPOSITION.md`.

## Findings surfaced by the sandbox so far

1. **Stock Alchemy `SessionKeyPlugin` cannot be installed on a Circle MSCA.** It targets ERC-4337 v0.6
   (`UserOperation`); Circle's `IPlugin` uses v0.7 `PackedUserOperation`, so the ERC-165 interface ids differ and
   `PluginManager.install` reverts `PluginNotImplementInterface`. The port to v0.7 is the BUFI plugin.
2. **The `BufiEarnModule` build deployed 2026-08-02 at `0xA9a9…` (Fuji + Arc testnet) has the same defect** —
   it was written against a vendored `IERC6900.sol` using the v0.6 struct. It compiled and deployed, but Circle's
   account would reject its install. Fixed here by building against Circle's real interfaces.
3. **AddressBook hooks are selector-scoped** (`execute` / `executeBatch`). Plugin-initiated
   `executeFromPluginExternal` calls and `executeWithSessionKey` userOps are separate selectors — see
   `docs/PLUGIN-COMPOSITION.md` for what is and is not gated and how each plugin closes the gap.
4. **Weighted multisig owners cannot act at runtime**, only through userOps. Any plugin whose management
   functions take a runtime-validation dependency must point that slot at the deliberately unimplemented
   function id 1 (fail-closed) and the userOp slot at id 0 — Circle's own AddressBook precedent.

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
