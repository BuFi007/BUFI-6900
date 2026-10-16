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
├─ packages/cre                   @bufi6900/cre — Chainlink CRE catalog, client, attestation/evidence types
├─ packages/the-graph             @bufi6900/the-graph — ERC-8004 identity+reputation, ERC-8183 job-escrow subgraphs
├─ packages/ens                   @bufi6900/ens — ENSv2 workspace naming, face-first shapes, preview registry
├─ packages/ledger                @bufi6900/ledger — Ledger hardware signer for treasuries (web + React Native)
├─ apps/playground                headless e2e + Vite UI against the mock
└─ docs/                          AUDIT-SCOPE · THREAT-MODEL · PLUGIN-COMPOSITION · CIRCLE-SUBMISSION
```

## ETHGlobal ETHOnline 2026 — 👻 BUFI

**BUFI is a financial OS purpose-built for distributed B2B teams that are stablecoin and AI-first.**

- Showcase: https://ethglobal.com/showcase/bufi-8ecop
- Product monorepo: https://github.com/BuFi007/desk-v1
- CRE workflow engine: https://github.com/BuFi007/chainlink-cre

### Packages

| Package | What it is |
| --- | --- |
| [`packages/modular-wallets-core`](packages/modular-wallets-core) | Fork of Circle's web SDK with ERC-6900 plugin actions as first-class |
| [`packages/cre`](packages/cre) | Chainlink CRE catalog, gateway client, attestation + evidence types |
| [`packages/subgraph-arc`](packages/subgraph-arc) | BUFI's own Arc subgraph: ERC-8004 identity + reputation and Circle's ERC-8183 escrow on one graph, with workspace joins, verified ratings and the payment-score attestation — builds standalone |
| [`packages/the-graph`](packages/the-graph) | Typed reads over that subgraph for ERC-8004 identity/reputation and ERC-8183 job escrow |
| [`packages/ens`](packages/ens) | ENSv2 workspace naming, face-first, with its honest Sepolia-only limits |
| [`packages/ledger`](packages/ledger) | Ledger hardware signer for treasuries, web + React Native, plus its CSP regression |
| [`packages/mock-circle`](packages/mock-circle) | Modular Wallets API + bundler + paymaster mock, zero Circle credentials |
| [`packages/msca-recovery`](packages/msca-recovery) | Fork of Circle's MSCA wallet recovery |
| [`contracts/src/bufi`](contracts/src/bufi) | The ERC-6900 plugins — session keys, Earn, Gateway |

### How it's made

BUFI is a unified financial workspace for agile B2B teams, combining stablecoin payments, self-custodial treasury management, AI assistance, privacy, and ERP/CRM workflows in one cross-platform product.

Its custody architecture uses Circle User-Controlled Wallets as treasury signers for Circle MSCA Modular Wallets with weighted approvals. For agentic workflows, AI requests permission and scope to the treasury and goes through a treasury ceremony for scoped and safe agentic transactions. Teams can also connect existing Web3 wallets, including Ledger hardware devices, to access shared workflows such as invoicing, reimbursements, payroll, contracts, deals, products, and project management.

For secure AI-assisted treasury operations, BUFI integrates Circle's ERC-6900 Allowlist plugin with human-in-the-loop treasury ceremonies. This enables policy-controlled agentic payments while preserving explicit user oversight. The architecture works across web and mobile, allowing treasury activity and AI notifications to be reviewed and handled from either platform.

Each workspace has an ERC-8004 identity for agent-to-agent flows. During workspace setup, ENSv2 naming distinguishes collective workspace wallets from personal wallets, supported by colour coding to reduce operational ambiguity. For AI agents, BUFI supports WebMCP, LLM discoverability, and x402 nanopayments, allowing assistants to discover and procure tools and enabling workspaces to be discovered for hiring.

BUFI combines the Circle and Arc stack with Ledger to create a global, self-custodial ERP for the future of work. The platform supports swaps, FX across StableFX assets on Avalanche Mainnet and Arc testnet, yield and earn functionality, allowlisted payments, conditional payments, onchain automation, and multi-step settlement.

During ETHOnline 2026, we completed BUFI's privacy implementation. BUFI means Private Business Finance, represented by its ghost identity. We integrated Hinkal's privacy payment solution as Ghost Balances for MSCA treasuries and personal wallets, alongside StableFX support on Arc testnet. This allows companies and independent contributors to transact globally and privately while retaining programmable treasury controls.

We also extended ERC-8004 identities into a payment-scoring system using Chainlink Confidential CRE. This provides the foundation for a human and agent workspace marketplace where financial workspaces can be discovered and hired based on reputation and scoring. A dedicated agentic workflow manages quotes, contracts, invoices, and settlement for workspace hiring, enabling humans and agents to hire and transact with one another through a unified financial operating layer. To power the agentic marketplace and discoverability, we enabled an MCP and Arc Subgraph to keep this agentic workspace "Behance meets Fiverr" in sync. When a workspace gets a quote and deal done in the CRM, the contract and escrow itself is settled leveraging the ERC-8183 Agentic Commerce contract combined with Chainlink CRE for disputes and settlement, with AI reviewing deliverables and disputes in a multi-model juror dispute resolution system, as workspaces and their agents get hired through ERC-8183 job escrow and A2A.

Circle's MSCA architecture and the ERC-6900 plugin model offer a path beyond developer-controlled agent wallets toward scoped agentic accounts and automated yield treasuries. We developed BUFI-6900, a collection of plugins that defines modular capabilities for Circle MSCA wallets. Similar to the skills.sh directory, and built to support the Circle Agent Stack Marketplace and Coinbase Bazaar, these capabilities could be installed as reusable "Wallet Skills", allowing agent wallets to evolve without replacing their underlying accounts. Further integration work is required because Circle's plugin installation contract currently relies on a Circle-managed allowlist. We provide these plugins for consideration to power BUFI 2.0 with enhanced capabilities for scoped agentic accounts, agentic policy, unified USDC gateway balances, and automated yield treasury multisigs.

> **`packages/subgraph-arc` builds and deploys from this repo** (`bun install`, then `bun run --cwd packages/subgraph-arc build`); it is the Arc subgraph behind the marketplace, based on Space Object's hackathon subgraphs with their permission and extended with BUFI's business logic.
>
> **On the four packages added for this submission.** `cre`, `the-graph`, `ens` and `ledger` are lifted verbatim from the product monorepo (`BuFi007/desk-v1`) so the hackathon work reads as standalone packages. They still import from that workspace (`@bu/*`), so they are published for review and portability rather than to build in isolation here. Each package README maps every file to its canonical home.

## Quickstart

```bash
mise install                     # node 24.18.0, bun 1.3.10 (foundry 1.5.x installed separately: foundryup)
git submodule update --init --recursive
bun install
bun run contracts:test           # forge: canonical redeploy + every plugin suite
bun run mock:circle              # anvil + Circle stack at canonical addresses + BUFI plugins + mock API on :8788
bun run sandbox:e2e              # SDK fork drives the full agentic-wallet flow against the mock
```

## Audit scope: contracts inventory and deployments

This section is the auditor's map. It lists every contract under `contracts/src/`, how each one is owned, and
where each one is deployed. Owners were read on-chain with `owner()` / `pendingOwner()` on 2026-10-16. In-scope
code is everything under `contracts/src/bufi/`. `contracts/lib/` (pinned upstream, see "Provenance") and
`contracts/src/CircleStack.sol` (re-exports Circle's audited stack unchanged) are reference only.

### Toolchain and commands

- Compiler: **solc 0.8.24**, `evm_version = paris`, `via_ir = true`, optimizer 200 runs (Circle's profile, `contracts/foundry.toml`).
- Foundry 1.5.x. Dependencies are git submodules: `git submodule update --init --recursive`.
- Build: `cd contracts && forge build` (or `bun run contracts:build`).
- Test: `cd contracts && forge test` (or `bun run contracts:test`). Fork suites are excluded from the default profile:
  `FOUNDRY_PROFILE=fork forge test --fork-url <base>` (Morpho earn) and `FOUNDRY_PROFILE=fork-arc forge test --fork-url <arc>`
  (agentic + gateway).
- Static analysis: `bun run contracts:slither`, `bun run contracts:lint`. Coverage: `bun run contracts:coverage`.
- Deploy scripts (`contracts/script/`):
  - `DeployBufiPlugins.s.sol`: session-key, earn and recipient-hook plugins, CREATE2 (Arachnid) at the same address on every chain.
  - `DeployTreasuryConduit.s.sol`: `TreasuryConduit`, CREATE2 (Arachnid), salt `keccak256("bufi.treasury-conduit.v2")`, then `setTarget` per chain.
  - `DeployTreasuryEarn.s.sol`: `TreasuryEarnVault` (canary) + `TreasuryRedeemConduit`.
  - `DeployTreasurySwapAndDeposit.s.sol`: `TreasurySwapAndDeposit`.
  - `gateway-treasury/DeployGatewayTreasury.s.sol`: `GatewayTreasury`.
  - `gateway-guard/LiveGatewaySetup.s.sol`: live Gateway guard setup (plugin + guarded MSCAs) on Arc testnet.
- Deployment records: `contracts/deployments/<network>.json`; receipts: `contracts/broadcast/<script>/<chainId>/run-latest.json`.

**Build/test result at the commit of this README:** `forge build` succeeded (260 files, solc 0.8.24; lint warnings only), and `forge test` (default profile) passed **454/454 across 28 suites, 0 failed, 0 skipped** (2026-10-16, Foundry 1.5.1). 

### Contracts inventory (`contracts/src/`)

None of the BUFI contracts is upgradeable: no proxy, no `upgradeTo`, no `delegatecall` into mutable code. Plugins
and modules run in the context of the Circle MSCA that installs them. The MSCA itself (Circle's `UpgradableMSCA`)
is UUPS-upgradeable by the account's own owners.

| Contract | Path | Purpose | Upgradeable | Ownership / admin model |
| --- | --- | --- | --- | --- |
| `TreasuryConduit` | `src/bufi/conduit/TreasuryConduit.sol` | Moves a treasury MSCA's stablecoins in one tx (ERC-3009 pull + call to a registered protocol target) under a quorum-signed intent with memo | No | `Ownable2Step`; owner only manages the target registry (`setTarget`) and `rescue` |
| `TreasuryRedeemConduit` | `src/bufi/conduit/TreasuryRedeemConduit.sol` | Exit rail for a treasury Earn position: EIP-712-authorised ERC-4626 redeem back to the treasury | No | `Ownable2Step`; owner manages the vault allowlist (`setVault`) |
| `TreasurySwapAndDeposit` | `src/bufi/conduit/TreasurySwapAndDeposit.sol` | `TreasuryConduit` target that swaps an ERC-3009 stable and deposits into an ERC-4626 vault / Aave v3 pool | No | `Ownable2Step`; owner manages the venue and destination allowlists (`setVenue`, `setDest`) |
| `GatewayTreasury` | `src/bufi/gateway-treasury/GatewayTreasury.sol` | Standalone weighted-multisig treasury for Circle Gateway that enforces the burn-intent / ERC-3009 policy | No | No single owner: signer-set quorum, timelocked admin ops (EIP-712 `AdminOp`, epoch-bound) |
| `GatewayIntentGuardPlugin` | `src/bufi/gateway-guard/GatewayIntentGuardPlugin.sol` | ERC-6900 **v0.7** plugin that applies the Gateway intent policy to a Circle weighted-multisig MSCA's ERC-1271 signatures | No | Ownerless; per-account config set by the account at install |
| `GatewayIntentGuardModule` | `src/bufi/gateway-guard/GatewayIntentGuardModule.sol` | ERC-6900 **v0.8** validation-hook packaging of the same policy | No | Ownerless; per-account config |
| `GatewayIntentGuardCore` (abstract) | `src/bufi/gateway-guard/GatewayIntentGuardCore.sol` | Shared per-account config + policy evaluation for the plugin and the module | n/a | n/a |
| `GatewayIntentPolicy` (library) | `src/bufi/gateway-guard/GatewayIntentPolicy.sol` | Pure Gateway intent policy and EIP-712 digests shared by `GatewayTreasury` and the guard | n/a | n/a |
| `IGatewayIntentGuard` (interface) | `src/bufi/gateway-guard/IGatewayIntentGuard.sol` | Guard ABI + install config | n/a | n/a |
| `BufiSessionKeyPlugin` | `src/bufi/v0.7/session/BufiSessionKeyPlugin.sol` | Agent session keys: target/selector access lists, ERC-20/native/gas spend limits, time windows (port of Alchemy MAv1) | No | Ownerless; each account manages its own keys through its own validation |
| `SessionKeyPermissions`, `SessionKeyPermissionsBase`, `SessionKeyPermissionsLoupe` (abstract) | `src/bufi/v0.7/session/permissions/` | Permission storage, enforcement and views for the session-key plugin | n/a | n/a |
| `PluginStorageLib` (library) | `src/bufi/v0.7/session/libraries/PluginStorageLib.sol` | ERC-4337 account-associated storage | n/a | n/a |
| `IBufiSessionKeyPlugin`, `ISessionKeyPermissionsUpdates` (interfaces) | `src/bufi/v0.7/session/` | Session-key ABIs | n/a | n/a |
| `BufiSessionRecipientHookPlugin` | `src/bufi/v0.7/recipient-hook/BufiSessionRecipientHookPlugin.sol` | Pre-validation hook that checks `executeWithSessionKey` recipients against the account's AddressBook | No | Ownerless; bound per account at install |
| `IBufiSessionRecipientHookPlugin` (interface) | `src/bufi/v0.7/recipient-hook/` | Hook ABI | n/a | n/a |
| `BufiEarnModule` | `src/bufi/v0.7/earn/BufiEarnModule.sol` | Relayer-triggered, deposit-only sweep of idle USDC/EURC into multisig-adopted ERC-4626 vaults (port of FluidKey) | No | `Ownable` (single-step); owner adds/removes relayers and registers vault config sets (`setConfig`). Accounts must explicitly adopt a config hash |
| `GatewayExecutionModule` | `src/bufi/v0.8/gateway/GatewayExecutionModule.sol` | ERC-6900 v0.8 execution module for the Circle Gateway delegate lifecycle. **Reference only**: structurally unsound as a depositor (see Findings 7) | No | Ownerless; Gateway wallet address is immutable |
| `GatewayHelper` | `src/bufi/v0.8/gateway/GatewayHelper.sol` | Calldata encoder for direct Gateway execution from an MSCA (the supported pattern) | No | Ownerless; immutable Gateway address |
| `GatewayConstants`, `GatewayEnums`, `GatewayStructs`, `IGatewayExecutionModule`, `IGatewayHelper`, `IGatewayMinter`, `IGatewayWallet` | `src/bufi/v0.8/gateway/` | Types and interfaces | n/a | n/a |
| `IFiatTokenV2` (interface) | `src/bufi/conduit/interfaces/IFiatTokenV2.sol` | The ERC-3009 entry points of Circle's FiatToken | n/a | n/a |
| `CircleStack` | `src/CircleStack.sol` | Re-exports Circle's v0.7 MSCA stack so it compiles unchanged. **Out of scope** (Circle's audited code) | n/a | n/a |

**Test / mock / experimental (not for production):**

| Contract | Path | Notes |
| --- | --- | --- |
| `TreasuryEarnVault` | `src/bufi/conduit/TreasuryEarnVault.sol` | 1:1 ERC-4626 wrapper, used only as the Arc-testnet canary target. Ownerless. Not a production vault |
| `SandboxUSDC` | `src/sandbox/SandboxUSDC.sol` | Mintable 6-decimal USDC stand-in for the local sandbox. Never deploy anywhere real |
| `GatewayExecutionModule` | `src/bufi/v0.8/gateway/GatewayExecutionModule.sol` | Kept as reference/evaluation (see above) |
| Test harnesses, mocks, adversarial PoCs | `contracts/test/**` | Not deployed |

### Deployments by chain

Owners verified on-chain on 2026-10-16. "deployer" = BUFI testnet/desk deployer EOA `0x09Ce8E2B3Fede2727dA4392Ea8Fe618305ba0474`.
Commit = the `commit` field of the broadcast record (`—` where no broadcast record is tracked).

#### Mainnet (production)

These chains are the ones production uses: Arc 5042 and Avalanche 43114. Every address below has code on-chain, and its owner was read on 2026-10-16. No BUFI contract is deployed on Base, Arbitrum or Ethereum mainnet. `MemoConduit` and Peanut are not built from `contracts/src/`.

**Arc mainnet (5042)**, record `contracts/deployments/arc-mainnet.json` (RPC `https://rpc.mainnet.arc.io`)

| Contract | Address | Commit | Owner (on-chain) | Explorer |
| --- | --- | --- | --- | --- |
| `TreasuryConduit` v2 | `0xA9817049F0a48d4653719465A7829E85b3A415e7` | — | **Safe `0x47Dc7D18A6E3a79F696714E7D47456a49B430D09`** (no pending) | [arcscan](https://arcscan.app/address/0xA9817049F0a48d4653719465A7829E85b3A415e7) |
| `TreasuryRedeemConduit` | `0x361340F0B3a8EC00067eA3c024Ae6919A2a0D06A` | — | **Safe `0x47Dc7D18A6E3a79F696714E7D47456a49B430D09`** (no pending) | [arcscan](https://arcscan.app/address/0x361340F0B3a8EC00067eA3c024Ae6919A2a0D06A) |
| `MemoConduit` (source not in this repo) | `0x516340a244132c62BEdaE5F886Fd35845Af16ba2` | — | no `owner()` | [arcscan](https://arcscan.app/address/0x516340a244132c62BEdaE5F886Fd35845Af16ba2) |

**Avalanche C-Chain (43114)**, record `contracts/deployments/avax-mainnet.json`

| Contract | Address | Commit | Owner (on-chain) | Explorer |
| --- | --- | --- | --- | --- |
| `TreasuryConduit` v2 | `0x49c89b198321ed0782a4f9a44de2b237ebd77cf0` | `f19666f` | **Safe `0x47Dc7D18A6E3a79F696714E7D47456a49B430D09`** (2-step transfer accepted; pendingOwner 0x0) | [snowtrace](https://snowtrace.io/address/0x49c89b198321ed0782a4f9a44de2b237ebd77cf0) |
| `MemoConduit` (source not in this repo) | `0x536268d0A6C32a7161BA146F5673dFcF13F1fFe2` | — | no `owner()` | [snowtrace](https://snowtrace.io/address/0x536268d0A6C32a7161BA146F5673dFcF13F1fFe2) |
| Peanut V4.4 (third party, out of scope) | `0xd092f910be70328426530bCa92C746De1e0989eC` | — | no `owner()` | [snowtrace](https://snowtrace.io/address/0xd092f910be70328426530bCa92C746De1e0989eC) |
| Peanut batcher (third party, out of scope) | `0xE9963b5f864099c3A4454c395C8Cf1bBd97eCA91` | — | no `owner()` | [snowtrace](https://snowtrace.io/address/0xE9963b5f864099c3A4454c395C8Cf1bBd97eCA91) |

CREATE2 via the Arachnid deployer, deploy tx `0xcb3b59cb…e2dabe4b51e` (block 97727352). Registered targets
(`targets(addr) == true` on-chain): Uniswap Universal Router `0x661E93cca42AfacB172121EF892830cA3b70F08d`, Uniswap no-Permit2
proxy `0x0000000085E102724e78eCd2F45DC9cA239Affad`, LI.FI diamond `0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE`
(setTarget txs `0x56b48efa…`, `0xe8f16403…`, `0x3d43cccd…`), and Uniswap SwapRouter02 `0xbb00FF08d01D300023C629E8fFfFcb65A5a578cE`, added by the Safe in tx `0xfde861e8…9c022def81` (block 97727911), which also executed `acceptOwnership()`.

#### Testnets (not production)

**Arc testnet (5042002)**, records `contracts/deployments/arc-testnet.json`, `arc-testnet.gateway-live.json`

| Contract | Address | Commit | Owner (on-chain) | Explorer |
| --- | --- | --- | --- | --- |
| `TreasuryConduit` v2 | `0xA9817049F0a48d4653719465A7829E85b3A415e7` | `5c4389b` | deployer (no pending) | [arcscan](https://testnet.arcscan.app/address/0xA9817049F0a48d4653719465A7829E85b3A415e7) |
| `TreasuryRedeemConduit` | `0x361340f0b3a8ec00067ea3c024ae6919a2a0d06a` | `3e35743` | deployer (no pending) | [arcscan](https://testnet.arcscan.app/address/0x361340f0b3a8ec00067ea3c024ae6919a2a0d06a) |
| `TreasuryEarnVault` (canary) | `0x0a9a082c24364b90b73e20e57d7625a3aa798bca` | `3e35743` | ownerless | [arcscan](https://testnet.arcscan.app/address/0x0a9a082c24364b90b73e20e57d7625a3aa798bca) |
| `TreasurySwapAndDeposit` | `0x77859bc836e03c7fa18fe08f02e2d48a5b01435b` | `3e35743` | deployer (no pending) | [arcscan](https://testnet.arcscan.app/address/0x77859bc836e03c7fa18fe08f02e2d48a5b01435b) |
| `BufiSessionKeyPlugin` | `0xBd607dBAC82CF1351C352FB65fC29dE9D0095339` | — | ownerless | [arcscan](https://testnet.arcscan.app/address/0xBd607dBAC82CF1351C352FB65fC29dE9D0095339) |
| `BufiEarnModule` | `0xeb94A8b7412418B506b24dBeD4Aed0E9ba5453c2` | — | deployer (`Ownable`, single-step) | [arcscan](https://testnet.arcscan.app/address/0xeb94A8b7412418B506b24dBeD4Aed0E9ba5453c2) |
| `BufiSessionRecipientHookPlugin` | `0xAa8B4fb76e8Eb712435E2b948B3A35c4C069d98A` | `ff65079` | ownerless | [arcscan](https://testnet.arcscan.app/address/0xAa8B4fb76e8Eb712435E2b948B3A35c4C069d98A) |
| `GatewayIntentGuardPlugin` | `0x9586776fa5eFAa0DD1251dF947A3Df8113EF9B59` | — | ownerless | [arcscan](https://testnet.arcscan.app/address/0x9586776fa5eFAa0DD1251dF947A3Df8113EF9B59) |
| `GatewayTreasury` (v3) | `0x7671e34415652194Adc7Db58aF98f0EF123755E5` | — | signer-set quorum (no `owner()`) | [arcscan](https://testnet.arcscan.app/address/0x7671e34415652194Adc7Db58aF98f0EF123755E5) |

**Avalanche Fuji (43113)**, record `contracts/deployments/avax-fuji.json`

| Contract | Address | Commit | Owner (on-chain) | Explorer |
| --- | --- | --- | --- | --- |
| `TreasuryConduit` v2 | `0xA9817049F0a48d4653719465A7829E85b3A415e7` | `5c4389b` | deployer (no pending) | [snowtrace](https://testnet.snowtrace.io/address/0xA9817049F0a48d4653719465A7829E85b3A415e7) |
| `BufiSessionKeyPlugin` | `0xBd607dBAC82CF1351C352FB65fC29dE9D0095339` | — | ownerless | [snowtrace](https://testnet.snowtrace.io/address/0xBd607dBAC82CF1351C352FB65fC29dE9D0095339) |
| `BufiEarnModule` | `0xeb94A8b7412418B506b24dBeD4Aed0E9ba5453c2` | — | deployer (`Ownable`, single-step) | [snowtrace](https://testnet.snowtrace.io/address/0xeb94A8b7412418B506b24dBeD4Aed0E9ba5453c2) |
| `BufiSessionRecipientHookPlugin` | `0xAa8B4fb76e8Eb712435E2b948B3A35c4C069d98A` | `ff65079` | ownerless | [snowtrace](https://testnet.snowtrace.io/address/0xAa8B4fb76e8Eb712435E2b948B3A35c4C069d98A) |

**Arbitrum Sepolia (421614)**, **Base Sepolia (84532)**, **Ethereum Sepolia (11155111)**: conduit only

| Chain | `TreasuryConduit` v2 | Commit | Owner (on-chain) | Explorer |
| --- | --- | --- | --- | --- |
| Arbitrum Sepolia | `0xA9817049F0a48d4653719465A7829E85b3A415e7` | `5c4389b` | deployer (no pending) | [arbiscan](https://sepolia.arbiscan.io/address/0xA9817049F0a48d4653719465A7829E85b3A415e7) |
| Base Sepolia | `0xA9817049F0a48d4653719465A7829E85b3A415e7` | `5a672ab` | deployer (no pending) | [basescan](https://sepolia.basescan.org/address/0xA9817049F0a48d4653719465A7829E85b3A415e7) |
| Ethereum Sepolia | `0xA9817049F0a48d4653719465A7829E85b3A415e7` | `3e35743` | deployer (no pending) | [etherscan](https://sepolia.etherscan.io/address/0xA9817049F0a48d4653719465A7829E85b3A415e7) |

Note: `contracts/deployments/arb-sepolia.json` also lists the BUFI plugin addresses, but `BufiEarnModule` at
`0xeb94…53c2` has **no code** on Arbitrum Sepolia as of 2026-10-16. Treat only the conduit as deployed there.

### Notes for auditors

- **Owner keys.** Every testnet `Ownable` contract is owned by the deployer EOA, a placeholder to rotate before shared
  use. On mainnet, the conduit is owned by the BUFI Safe.
- **Admin surface.** Owner powers are limited to registries/allowlists (conduit targets, redeem vaults, swap venues/destinations, earn relayers and config sets) plus `TreasuryConduit.rescue`.
  Owners cannot move treasury funds through an intent; that takes the treasury's quorum signature.
- **`BufiEarnModule` uses single-step `Ownable`**. Every other owned contract uses `Ownable2Step`.
- Prior work: `reports/ADVERSARIAL_PRE_TENDERLY.md`, `docs/AUDIT-SCOPE.md`, `docs/THREAT-MODEL.md`, `docs/PLUGIN-COMPOSITION.md`.

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
| `forge test` (default profile) | 454 (28 suites, 2026-10-16) | canonical redeploy (3) · earn unit (17) + on real MSCA (21) · gateway local (38) + helper on MSCA (3) + on a real Circle v0.8 account (14) · session-key port on real MSCA (83) + integration (22) + × AddressBook (5) · agentic policy (5) · recipient hook (19) · adversarial (34: composition 6 · earn 10 · recipient hook 4 · session key 14) |
| `FOUNDRY_PROFILE=fork forge test --fork-url <base>` | 1 | Circle production MSCA on a Base-mainnet fork sweeps USDC into a live Morpho Vault V2 (`docs/EARN-MORPHO.md`) |
| `@bufi/modular-wallets-core` jest | 461 | 315 upstream unchanged + 131 BUFI (encoding vectors, grant DSL, deployment parametrisation, agent account, testnet constants) |
| `@bufi/mock-circle` bun test | 16 | canonical deploy + idempotence, bundler (initCode deploy + transfer, AA24), paymaster (sponsored op, AA34) |
| `@bufi/msca-recovery` bun test | 6 | independent lane (viem + permissionless, no BUFI SDK): session-key transfer through the sandbox bundler, nonce lane, budget |
| `bun run sandbox:e2e` | 6 steps | SDK → mock → stack → plugins: create/deploy, AddressBook gating, grant, agent spend/over-budget/off-scope, revoke, earn sweep |
| `FOUNDRY_PROFILE=fork-arc forge test --fork-url <arc testnet>` | 3 | an agent MSCA runs a real ERC-8183 job on Circle's native Arc contract as a session key (`docs/AGENTIC-WALLET.md`) |
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
