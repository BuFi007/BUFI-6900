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
- [x] `test/harness/CircleStackHarness.sol`: Circle bytecode at Circle addresses via CREATE2 salts; k-of-n signing
- [x] `test/stack/CanonicalStack.t.sol`: addresses, manifest hashes, 2-of-3 lifecycle, AddressBook gating
- [x] anvil deployer lives in `packages/mock-circle/src/deploy.ts` (EntryPoint via anvil_setCode, Circle CREATE2, SponsorPaymaster, BUFI plugins) → `contracts/deployments/local.json`; `script/DeployBufiPlugins.s.sol` for testnets. v0.8 stack deploy deferred (Gateway module is reference-only)

## Phase 2 — BUFI plugins (v0.7, EntryPoint 0.7)
- [x] `BufiSessionKeyPlugin` — port of Alchemy MAv1 SessionKeyPlugin (Spearbit+Quantstamp audited) to
      PackedUserOperation + Circle BasePlugin; dependency slots on WeightedWebauthnMultisigPlugin;
      grants = {scope (targets/selectors), budget (ERC20/native/gas), expiry (validAfter/validUntil)}
- [x] `BufiEarnModule` — rewired to Circle's real IPlugin (the deployed 0xA9a9… build used the EP-0.6 struct and
      would fail Circle's ERC-165 install check) + integration test on the real UpgradableMSCA
- [x] `GatewayExecutionModule` (v0.8) — carried over from desk-v1 `multi-sig-gateway`, tests re-homed
- [x] composition matrix tests: Weighted + AddressBook + SessionKey + Earn on ONE account; AND-gating proofs;
      uninstall ordering; agentic policy scenarios (agent key within/over budget, expired, wrong recipient)

## Phase 3 — SDK fork (`packages/modular-wallets-core`, @bufi/modular-wallets-core)
- [x] verbatim fork of `@circle-fin/modular-wallets-core` 1.0.15 (Apache-2.0), bun-run jest/tsup/eslint
- [x] `actions/plugins/*` + `clients/decorators/bufiCascade.ts`: installPlugin/uninstallPlugin/getInstalledPlugins,
      sessionKeys (add/remove/updateTimeRange/setSpendLimits), addressBook, earn — Circle style (action fn + decorator)
- [x] `constants/deployments.ts`: per-chain stack config (canonical Circle + BUFI plugin addresses + sandbox)
- [x] `isCircleUrl` trusted-host opt-in for the mock server; node-safe `fetchFromApi`

## Phase 4 — mock Circle server (`packages/mock-circle`)
- [x] JSON-RPC: circle_getAddress / circle_getAddressMapping / circle_createAddressMapping /
      circle_getUserOperationGasPrice, pm_getPaymasterStubData / pm_getPaymasterData (SponsorPaymaster signer),
      eth_* bundler methods backed by a direct `EntryPoint.handleOps` submitter on anvil, rp_* passkey stubs
- [x] `bun run mock:circle` = anvil + deploy + mock

## Phase 5 — playground (`apps/playground`)
- [x] headless e2e (`bun run sandbox:e2e`): create account via SDK fork → install AddressBook → install
      SessionKey → grant → agent spends within budget / rejected over budget / rejected off-allowlist → Earn
- [x] (follow-up) Vite UI forked from Circle's `examples/circle-smart-account`, pointed at the mock

## Phase 6 — recovery fork (`packages/msca-recovery`), docs, CI, repo
- [x] `docs/AUDIT-SCOPE.md`, `docs/THREAT-MODEL.md`, `docs/PLUGIN-COMPOSITION.md`, `docs/CIRCLE-SUBMISSION.md`
- [x] GitHub Actions: forge build/test, bun test, e2e against anvil
- [ ] create `BuFi007/BUFI-6900`, push; desk-v1 note + memory

## Review (2026-09-01)

- Contracts 197/197, SDK 441/441, mock 16/16, e2e green. Seven findings in README; composition matrix in docs.
- Follow-ups: Vite UI for the playground; v0.8 account harness (Circle `UpgradableMSCA` v0.8 + modules) for the
  Gateway module; ERC-20 recipient hook plugin (after Circle answers submission Q3); testnet deploy of the fixed
  plugins via `script/DeployBufiPlugins.s.sol`; `packages/msca-recovery` session-key scenario.

## Follow-ups — execution plan (2026-09-01, /go)

- [x] H1 `BufiSessionRecipientHookPlugin` — SELF pre-userOp hook on `executeWithSessionKey` that resolves recipients
      with Circle's `RecipientAddressLib` and enforces the AddressBook set → closes the ERC-20 recipient gap
- [x] H2 v0.8 harness — Circle `UpgradableMSCA` v0.8 + `SingleSignerValidationModule`; `GatewayExecutionModule`
      installed as an execution module; msg.sender finding reproduced on a real v0.8 account
- [x] H3 Vite playground UI — fork of Circle's `examples/circle-smart-account` against the mock (passkey owner),
      + BUFI panels (address book, agent grant, agent spend, earn)
- [x] H4 `@bufi/msca-recovery` — BUFI plugin ABIs + `session-key-transfer` scenario
- [x] testnet redeploy — Fuji + Arc: SessionKey 0x28504B34…, Earn 0x57D446a9… (same on both); `contracts/deployments/*.json`, SDK `AVAX_FUJI_DEPLOYMENT` / `ARC_TESTNET_DEPLOYMENT`, README table
- [x] live canary on Fuji through Circle's real API: install + grant + agent spend + AddressBook — green (`scripts/live/install-on-fuji.ts`)
- [ ] mock-circle: simulate validation in `eth_estimateUserOperationGas` (stub signature) so the stub/estimation class of bug is caught locally
- [x] Gateway/ERC-1271 evaluation (`docs/GATEWAY-1271-EVALUATION.md`) — plugin retired, helper kept
- [x] Morpho earn: Base-fork proof against Vault V2 + reliability model (`docs/EARN-MORPHO.md`); Midnight = design only
- [ ] Tenderly defensive + Codex adversarial pass — BLOCKED on Tenderly MCP OAuth (`/mcp` → tenderly) or a TENDERLY_ACCESS_KEY
- [ ] mock-circle: raise passkey verification-gas tiers on anvil (no P-256 precompile) or run anvil `--odyssey`
- [ ] CircleStackHarness `_lastUserOpRevertReason` drains recorded logs twice (v0.8 harness fixed its copy) — fix in v0.7 harness
- [x] Codex adversarial pre-Tenderly pass: `reports/ADVERSARIAL_PRE_TENDERLY.md` — 7 confirmed (F-01 Medium nonce-lane, F-02..F-07 Low, F-08/F-09 info)
- [x] fixes: F-01 (nonce lane for every key, D10), F-06 (earn verifies shares/asset delta), F-08 (sorted configs); F-02..F-05/F-07/F-09 documented as accepted with mitigations
- [x] Tenderly defensive (S1/S2 PASS post-fix; S3–S10 BLOCKED on plan quota — `reports/AUDIT_REPORT.md`); Codex-on-Tenderly pass not run: same quota. Was: S4–S10 on vnet `bufi-6900-fuji-audit` → `reports/AUDIT_REPORT.md`, then the Codex-on-Tenderly adversarial pass
- [x] SDK agent-role grant presets (8183 buyer/provider, 8004 rater, float funder, gateway depositor)
- [x] Arc-testnet fork proof: agent MSCA funds an ERC-8183 job as a session key; provider submits; owners complete

## Open (2026-09-02, end of the /go run)

- [ ] Tenderly: a plan with headroom, then S3–S10 + the Codex-on-Tenderly adversarial pass (`reports/AUDIT_REPORT.md` §Why S3–S10 are blocked)
- [ ] Strict-bundler tracer classification of validation-phase storage access (Codex F-09)
- [ ] Redeploy the recipient hook to Fuji/Arc (it exists only on the audit vnet and locally) and add it to the deployment records
- [ ] mock-circle: raise passkey verification-gas tiers on anvil (no P-256 precompile) or run anvil `--odyssey`
- [ ] Live Fuji canary: extend it with the over-budget and off-scope rejections (only forge/mock prove those today)
