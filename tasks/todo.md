# BUFI-6900 — build plan

Goal: a sandbox that redeploys Circle's ERC-6900 MSCA stack (multisig, address book, factory, plugin manager,
paymaster, EntryPoint) and proves BUFI's plugins install, compose and enforce policy on it — the artifact we hand
to auditors and to Circle. Plus a fork of Circle's web SDK that speaks our plugins in Circle's own coding style.

## Phase 0 — scaffold (DONE)
- [x] bun/turbo monorepo, mise pins (node 24.18.0 / bun 1.3.10)
- [x] `contracts/` single Foundry project, solc 0.8.24 / paris / via_ir = Circle's profile
- [x] upstream pinned as submodules: buidl-wallet-contracts@3c47aa9, msca-wallet-recovery@76c4168,
      account-abstraction@releases/v0.7, OZ 5.0.2, solady 0.0.243, FCL 8179e08, modular-account-libs v0.8.0-rc.0,
      erc6900 ref-impl v0.8.0 (+ v0.8.1 alias), alchemy modular-account v1.0.1 (reference only)
- [x] full Circle v0.7 stack compiles from vendored source (`src/CircleStack.sol`)

## Phase 1 — canonical redeploy + harness
- [ ] `test/harness/CircleStackHarness.sol`: Circle bytecode at Circle addresses via CREATE2 salts; k-of-n signing
- [ ] `test/stack/CanonicalStack.t.sol`: addresses, manifest hashes, 2-of-3 lifecycle, AddressBook gating
- [ ] `script/DeployStack.s.sol`: same on anvil (+ SponsorPaymaster, v0.8 stack, BUFI plugins) → `deployments/local.json`

## Phase 2 — BUFI plugins (v0.7, EntryPoint 0.7)
- [ ] `BufiSessionKeyPlugin` — port of Alchemy MAv1 SessionKeyPlugin (Spearbit+Quantstamp audited) to
      PackedUserOperation + Circle BasePlugin; dependency slots on WeightedWebauthnMultisigPlugin;
      grants = {scope (targets/selectors), budget (ERC20/native/gas), expiry (validAfter/validUntil)}
- [ ] `BufiEarnModule` — rewired to Circle's real IPlugin (the deployed 0xA9a9… build used the EP-0.6 struct and
      would fail Circle's ERC-165 install check) + integration test on the real UpgradableMSCA
- [ ] `GatewayExecutionModule` (v0.8) — carried over from desk-v1 `multi-sig-gateway`, tests re-homed
- [ ] composition matrix tests: Weighted + AddressBook + SessionKey + Earn on ONE account; AND-gating proofs;
      uninstall ordering; agentic policy scenarios (agent key within/over budget, expired, wrong recipient)

## Phase 3 — SDK fork (`packages/modular-wallets-core`, @bufi/modular-wallets-core)
- [ ] verbatim fork of `@circle-fin/modular-wallets-core` 1.0.15 (Apache-2.0), bun-run jest/tsup/eslint
- [ ] `actions/plugins/*` + `clients/decorators/bufiCascade.ts`: installPlugin/uninstallPlugin/getInstalledPlugins,
      sessionKeys (add/remove/updateTimeRange/setSpendLimits), addressBook, earn — Circle style (action fn + decorator)
- [ ] `constants/deployments.ts`: per-chain stack config (canonical Circle + BUFI plugin addresses + sandbox)
- [ ] `isCircleUrl` trusted-host opt-in for the mock server; node-safe `fetchFromApi`

## Phase 4 — mock Circle server (`packages/mock-circle`)
- [ ] JSON-RPC: circle_getAddress / circle_getAddressMapping / circle_createAddressMapping /
      circle_getUserOperationGasPrice, pm_getPaymasterStubData / pm_getPaymasterData (SponsorPaymaster signer),
      eth_* bundler methods backed by a direct `EntryPoint.handleOps` submitter on anvil, rp_* passkey stubs
- [ ] `bun run sandbox:up` = anvil + deploy + mock

## Phase 5 — playground (`apps/playground`)
- [ ] headless e2e (`bun run sandbox:e2e`): create account via SDK fork → install AddressBook → install
      SessionKey → grant → agent spends within budget / rejected over budget / rejected off-allowlist → Earn
- [ ] Vite UI forked from Circle's `examples/circle-smart-account`, pointed at the mock

## Phase 6 — recovery fork (`packages/msca-recovery`), docs, CI, repo
- [ ] `docs/AUDIT-SCOPE.md`, `docs/THREAT-MODEL.md`, `docs/PLUGIN-COMPOSITION.md`, `docs/CIRCLE-SUBMISSION.md`
- [ ] GitHub Actions: forge build/test, bun test, e2e against anvil
- [ ] create `BuFi007/BUFI-6900`, push; desk-v1 note + memory
