# Audit scope — BUFI-6900

## In scope (BUFI-authored or BUFI-ported Solidity)

| Path | Lines of concern | Notes for the auditor |
| --- | --- | --- |
| `contracts/src/bufi/v0.7/session/**` | `BufiSessionKeyPlugin.sol`, `permissions/*`, vendored libraries | Port of alchemyplatform/modular-account **v1.0.1** `src/plugins/session/**` (audited: Spearbit 2024-01-31 `0e3fd1e`, Quantstamp 2024-02-20 `8ae319e`, both PDFs in `contracts/lib/alchemy-modular-account/audits/`). Every deviation from the audited original is enumerated with line references in `PORT-NOTES.md`. Please diff against upstream rather than reading from scratch. |
| `contracts/src/bufi/v0.7/recipient-hook/**` | `BufiSessionRecipientHookPlugin.sol` (321), `IBufiSessionRecipientHookPlugin.sol` (34) | **New, unaudited BUFI code with no upstream to diff against — read this one from scratch and read it first.** A pre-validation hook that closes the ERC-20 recipient gap of session keys (below). Its `_getTargetOrRecipient` deliberately diverges from `ColdStorageAddressBookPlugin`'s and that divergence is the single most consequential decision in the new code — see "Where to spend the review". 19 tests in `test/bufi/v0.7/recipient-hook/`. |
| `contracts/src/bufi/v0.7/earn/**` | `BufiEarnModule.sol` | Port of fluidkey/fluidkey-earn-module (Ackee-audited Safe module, Rhinestone AutoSavings lineage) to an ERC-6900 v0.7 plugin. Deviations listed in `EARN-NOTES.md`. |
| `contracts/src/bufi/v0.8/gateway/**` | `GatewayExecutionModule.sol`, `GatewayHelper.sol` | ERC-6900 **v0.8** execution module for Circle Gateway (delegate lifecycle). Targets the v0.8 account generation, not the v0.7 production accounts. |
| `contracts/test/harness/**`, `contracts/test/**` | — | Test code; in scope only insofar as the auditor relies on it to reproduce claims. |

## Out of scope (vendored, unmodified, already audited by their owners)

- Circle `buidl-wallet-contracts` (`contracts/lib/buidl-wallet-contracts`, pinned `3c47aa9`): `UpgradableMSCA`,
  `UpgradableMSCAFactory`, `PluginManager`, `PluginExecutor`, `WeightedWebauthnMultisigPlugin`,
  `ColdStorageAddressBookPlugin`, `SponsorPaymaster`. The sandbox deploys **Circle's shipped creation bytecode**
  (`script/bytecode-deploy/build-output/*.json`), not a recompilation.
- eth-infinitism EntryPoint v0.7, OpenZeppelin 5.0.2, solady, FreshCryptoLib, erc6900 reference/libs.
- The TypeScript packages (`packages/**`) — they encode calldata and drive the sandbox; they hold no funds and
  are not part of the on-chain trust boundary. Reviewers are welcome to use them to reproduce flows.

## Claims the suites substantiate (each maps to a test name)

1. Circle's stack is recreated bit-for-bit at canonical addresses; manifest hashes equal the SDK's pinned
   constants — `test/stack/CanonicalStack.t.sol::test_canonicalAddressesAndManifestHashes`.
2. A k-of-n weighted multisig account created through the production factory installs
   ColdStorageAddressBookPlugin with the production dependency-slot arrangement, and the allowlist gates
   `execute` transfers — `::test_weightedMultisigLifecycle_2of3_withAddressBook`.
3. The address-book runtime path is fail-closed on weighted accounts (dependency slot 0 → unimplemented
   function id 1) — `::test_addressBookRuntimePathIsFailClosed`.
4. `BufiSessionKeyPlugin` installs on the production account, enforces access lists / spend limits / gas
   limits / time ranges / required paymaster, isolates state per account, cannot escalate, and is uninstallable —
   `test/bufi/v0.7/session/**`.
5. Composition matrix (Weighted + AddressBook + SessionKey + Earn on one account) and the exact selector
   coverage of each hook — `docs/PLUGIN-COMPOSITION.md`, `test/bufi/v0.7/session/SessionKeyWithAddressBook.t.sol`,
   `test/bufi/v0.7/earn/BufiEarnModuleOnMsca.t.sol`.
6. `BufiEarnModule` deposits only into vaults the multisig adopted (content-addressed config hash) and only
   from an authorised relayer; funds cannot leave the account through it —
   `test/bufi/v0.7/earn/**`.

7. `BufiSessionRecipientHookPlugin` binds to an AddressBook the account itself installed, and rejects every
   `executeWithSessionKey` call whose resolved recipient is outside that account's allowlist — same on-chain set
   the owners' `execute` path reads, no mirrored per-key list —
   `test/bufi/v0.7/recipient-hook/BufiSessionRecipientHookPlugin.t.sol`.

## Where to spend the review

Reviewer time is not uniform across the table above. Ranked:

1. **`recipient-hook/**` — new code, no audited ancestor.** Everything else here is a port of something a
   reputable firm already reviewed, so the question there is "did the port change behaviour" and `PORT-NOTES.md`
   answers it line by line. The hook has no such baseline.

   Concentrate on `_getTargetOrRecipient`. Circle's `ColdStorageAddressBookPlugin` **reverts** when a zero-value
   call carries no decodable token recipient; this plugin instead falls back to requiring the **call target** to be
   on the allowlist. That was not a simplification — reverting made the hook and the agentic rails mutually
   exclusive (an agent could move tokens but never call `createJob` / `setBudget` / `giveFeedback`), proved on an
   Arc fork. The consequence to weigh: for an allowlisted contract, the hook stops being a firewall — that
   contract interprets its own calldata however it likes (adversarial findings F-02 / F-03, `reports/ADVERSARIAL_PRE_TENDERLY.md`).
   The asymmetry that keeps token policy intact is that a *decodable* transfer is always judged by its recipient
   and never by its target, so `USDC.transfer(stranger, …)` is rejected whether or not USDC is listed.

   Also worth adversarial attention: the hook runs inside `validateUserOp`, so its ERC-7562 posture matters. It
   makes one `STATICCALL` into the AddressBook and one `EXTCODESIZE` per zero-value call. Both are argued safe in
   the contract NatSpec; that argument is ours, not an auditor's.

2. **`session/**` deviations D1–D10**, especially **D10** — the session-key nonce-lane rule was moved out of the
   `hasGasLimit` branch so it binds every key, not only gas-limited ones (adversarial finding F-01).

3. **`earn/**` F-06 and F-08** — `autoEarn` now verifies the deposit landed (asset match, non-zero shares, exact
   debit) and `setConfig` requires strictly increasing `(chainId, token)`.

4. Everything else: diff against upstream.

## Numbers at the tagged commit

Measured 2026-09-02 against the **tracked** tree (`forge test --no-match-contract GhostShieldAddressBookTest`),
not carried forward from a previous revision. Measure the tracked tree, not the working tree: a working tree can
contain an uncommitted file, and a count an auditor cannot reproduce from a clean clone is worse than no count.

| Suite | Result |
| --- | --- |
| `forge test` (default profile) | **264 passed / 0 failed**, 16 suites |
| `@bufi/modular-wallets-core` jest | **461 passed**, 84 suites, 8 snapshots |
| — coverage | 98.93% stmts · 94.48% branch · 98.57% funcs · 98.91% lines |
| `@bufi/mock-circle` (bun) | **16 passed**, 3 files, 126 assertions |

Fork suites are excluded from the default profile and each needs a **different** RPC:

| Suite | Profile | Network | Status |
| --- | --- | --- | --- |
| `test/fork/agentic/**` | `fork-arc` | Arc testnet 5042002, block 60099079 | **3 passed** (re-verified 2026-09-02 through two independent RPCs) |
| `test/fork/earn/**` | `fork` | Base mainnet 8453, block 50769826 | 1 test; needs a Base mainnet RPC |
| `test/fork/gateway/**` | `fork-arc` | Sepolia | needs `$SEPOLIA_RPC_URL` |

**Solidity coverage** — `FOUNDRY_PROFILE=coverage forge coverage --ir-minimum --report summary`, full table and
method notes in `reports/COVERAGE.md`:

| | v0.7 tree |
| --- | --- |
| Lines | **91.35%** (602/659) |
| Statements | **92.17%** (659/715) |
| Branches | **90.83%** (99/109) |
| Functions | **93.62%** (88/94) |

Per contract, the two worth an auditor's eye: `BufiSessionRecipientHookPlugin` is 96.25% lines / **100% branches**
/ 100% functions — the newest and least audited contract is the best covered. `BufiEarnModule` is the weakest at
80% lines / **56.25% branches**, so the F-06 and F-08 failure paths are under-exercised.

**`src/bufi/v0.8/gateway/**` has no coverage figure and none is claimed.** The coverage profile skips it: with
via-IR off (which `forge coverage` requires for accurate source mapping) solc 0.8.24's legacy codegen cannot copy
the harnesses' struct arrays to storage, and with `--ir-minimum` on, Circle's *vendored* v0.8 `BaseMSCA` hits a
Yul stack-too-deep we do not control. 214 of the 264 tracked tests run under coverage. Reasoning and the rejected
alternative are in `reports/COVERAGE.md`.

`.gas-snapshot` is committed (263 entries). There are **0 invariant tests** and 12 fuzz tests — bucket 2 in
`reports/READINESS-BUCKETS.md`.

## Known limitations the auditor should not rediscover

- WebAuthn (P-256 passkey) owners are exercised by Circle's own suites, not ours; our harness signs with EOA
  owners in the same wire format (`BaseMultisigPlugin.checkNSignatures`). The plugin under test does not depend
  on owner key type.
- The mock Circle API does not verify WebAuthn attestations (`rp_*` are stubs); it is a transport stand-in.
- Fork suites under `test/fork/**` are excluded from the default profile and need three different networks
  (Arc testnet, Base mainnet, Sepolia) — see the table above. A previous revision of this document said "a
  Sepolia RPC", which is true of one suite of three.
- `BufiSessionRecipientHookPlugin` is **not deployed on any chain** as of this writing, so no explorer-verified
  instance exists to read alongside the source. The other three BUFI plugins are deployed on Avalanche Fuji and
  Arc testnet (`contracts/deployments/*.json`) but are **not** explorer-verified either. Bucket 3 in
  `reports/READINESS-BUCKETS.md`.
- Membership in the hook is a linear scan (`O(calls x n)`) because Circle's `AssociatedLinkedListSetLib.contains`
  is `internal` and the AddressBook plugin exposes no single-recipient view. This is a known cost, not an
  oversight; if Circle exposes one, `_contains` is the only thing that changes.
