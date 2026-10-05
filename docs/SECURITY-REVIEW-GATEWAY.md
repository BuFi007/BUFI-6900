# Security review: Gateway treasury, GatewayIntentGuard, Ultimate Treasury app

Date 2026-10-05. Internal review, not a third-party audit. Every address, transaction hash and post-fix test count
cited here is in [`EVIDENCE-LEDGER.md`](EVIDENCE-LEDGER.md); that file is the source of truth. The red-first counts
come from the fix step's run log, and the commit hashes come from git.

## Scope

| Area | Paths |
| --- | --- |
| EVM treasury | `contracts/src/bufi/gateway-treasury/GatewayTreasury.sol`, `contracts/script/gateway-treasury/DeployGatewayTreasury.s.sol` |
| Shared intent policy and guard | `contracts/src/bufi/gateway-guard/` (`GatewayIntentPolicy.sol`, `GatewayIntentGuardCore.sol`, `GatewayIntentGuardPlugin.sol` (v0.7), `GatewayIntentGuardModule.sol` (v0.8), `IGatewayIntentGuard.sol`) |
| Solana leg | `tools/frost-delegate/`, `packages/weighted-treasury/scripts/gateway-solana-delegate.ts` |
| App and scripts | `apps/ultimate-treasury/` (dev-only signer in `server/`), `scripts/gateway-treasury/canary.ts` |

## Method

1. Three review lenses ran in parallel, each over the whole scope:
   - **App and signer** (IDs `UT-n`): the dev signer, the Vite plugin, the FROST tool and the scripts.
   - **Gateway spec** (IDs `GT-n (spec)`): the code against Circle's Gateway rules (ERC-1271, Solana delegate,
     block lag, fees).
   - **Contract security** (IDs `GT-n`, `GG-n`): the Solidity in `gateway-treasury/` and `gateway-guard/`.
2. The lenses produced 22 raw findings (9, 6 and 7).
3. Each finding was then given to skeptic reviewers who tried to refute it. The fix step reports 15 findings as
   confirmed. Per-finding votes and reasons were not recorded.
4. Fixes were test first where a test exists. The fix step recorded these red-first runs: 7 of the 12 new `test_GT*`
   tests in `GatewayTreasury.t.sol` and 4/4 new guard plugin tests failed on the old code. `cargo test` and
   `bun test` did not compile or import before the fix, which is not a failing assertion. No red-first run is
   recorded for the other 5 `GatewayTreasury` tests. UT-9 has no regression test (checked by hand); UT-8 got one after the fact-check.
5. After the fixes: `forge test --match-path "test/bufi/gateway-*/**"` 142 passed, full default profile 458
   passed, `bun test server` in the app 22 passed, `cargo test` in `tools/frost-delegate` 5 passed (ledger §6).

IDs repeat across lenses (each lens numbered from 1). In this doc, `GT-n (spec)` is the Gateway spec lens and a
bare `GT-n` is the contract security lens.

## Confirmed findings and fixes

The fix step reported 15 confirmed findings but did not list which IDs those are. The table below is
reconstructed from the fix notes, commits `7939cb7` (contracts), `0ac347d` (frost-delegate and scripts) and
`b7e2472` (app hardening), and the test files. It lists every finding the fix step addressed, merging duplicates
the fix notes merged. That gives 17 rows, two more than the reported count. The fix notes count GT-1 and GG-1 as
one fix, which this table splits into two rows. That accounts for one of the extra rows. The other may be a fix
made without a skeptic-confirmed finding.

Status "fixed, live in v2" means the fix is in the bytecode of GatewayTreasury v2
`0xC3f4De2372167F7FFA0a1B3FbF221a8a7289e7d5` (ledger §1). The v1 deployment `0x692Db08885870fA99ADA4Acdee02633947669daF`
has none of the contract fixes and is superseded. The guard is not deployed anywhere.

| ID | Lens | Severity | Title | Scenario | Fix | Regression tests | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| GT-1, GT-1 (spec) | contract security, Gateway spec | medium | Recipient not tied to destination domain | An allowlisted EVM address passes as a Solana recipient, or a Solana key passes on an EVM domain, and the EVM minter truncates a non-canonical word. | `GatewayIntentPolicy.matchesDomainShape`: on EVM domains the recipient and destination token must be a non-zero 20-byte address, and a non-zero caller must be one too. On Solana (domain 5) the same values must be a 32-byte key. A zero caller means any caller and is not shape-checked. Unknown domains are treated as EVM. | `test_GT1_recipientShapeBoundToDomain` in `contracts/test/bufi/gateway-treasury/GatewayTreasury.t.sol` | fixed, live in v2 |
| GG-1 | contract security | medium | Guard accepts address-book and explicit recipients on any domain | A recipient from the account's AddressBook is accepted on the Solana domain. | Same shape check in `GatewayIntentGuardCore`; the AddressBook is used for EVM domains only. | `test_GG1_addressBookRecipient_refusedOnSolanaDomain`, `test_GG1_explicitRecipients_boundToDomainShape` in `contracts/test/bufi/gateway-guard/GatewayIntentGuardPlugin.t.sol` | fixed in source, guard not deployed |
| GT-4, GT-6 (spec) | contract security, Gateway spec | low | `sourceDomain` and `destinationContract` not checked | The quorum signs an intent naming another source domain or a destination contract that is not Circle's minter. | `sourceDomain` pinned (`localDomain` in the treasury, `sourceDomain` in the guard init). `destinationContract` must equal the configured minter for the destination domain (`destinationMinters`). New error `DestinationContractNotAllowed` in the guard. | `test_GT4_destinationContractAndSourceDomainPinned`, `test_GT4_constructor_requiresMinterPerDomain` in `GatewayTreasury.t.sol`; `test_GT4_destinationContractAndSourceDomainPinned` in `GatewayIntentGuardPlugin.t.sol` | treasury: fixed, live in v2; guard: fixed in source, not deployed |
| GT-6 | contract security | low | Destination caller shares the recipient allowlist | Any address allowed as a relayer is also a valid payee, and the reverse. | Separate `allowedDestinationCallers` set and setters (`setAllowedDestinationCaller`, `setGatewayDestinationCaller`). The v0.7 plugin manifest goes from 5 to 7 setters. | `test_GT6_destinationCallerNotImpliedByRecipientAllowlist` in `GatewayTreasury.t.sol`; `test_GT6_recipientIsNotADestinationCaller` in `GatewayIntentGuardPlugin.t.sol` | treasury: fixed, live in v2; guard: fixed in source, not deployed |
| GT-2 | contract security | low | Admin ops never expire | A queued op whose execution failed stays live and anyone can trigger it later, including after an owner rotation. | Queued ops expire 7 days after eta (`ADMIN_OP_GRACE`, `OpExpired`). `adminEpoch` is bumped by `setOwners` and `setAdminTimelock`; older ops fail with `OpStale`. | `test_GT2_adminOpExpiresAfterGrace`, `test_GT2_ownerRotationInvalidatesPendingOps`, `test_GT2_timelockChangeInvalidatesPendingOps` in `GatewayTreasury.t.sol` | fixed, live in v2 |
| GT-3 | contract security | low | A signed admin op that was never queued cannot be revoked | Leaked admin signatures stay usable forever because there is nothing to cancel. | The signed AdminOp includes `deadline` and `epoch`; `queueAdmin` takes a `deadline` argument; `cancelAdmin` burns a nonce that was never queued. | `test_GT3_cancelNeverQueuedNonce_burnsIt`, `test_GT3_adminSignaturesExpireAndDieOnRotation` in `GatewayTreasury.t.sol` | fixed, live in v2 |
| GT-2 (spec) | Gateway spec | medium | No fast revocation of a signed burn intent | A signed intent that has not been submitted yet cannot be stopped, because every lever is timelocked. | `revokeIntent(digest, sigs)` refuses one intent and `pause(nonce, sigs)` refuses all burn intents, both quorum-signed with no timelock. Unpause is the timelocked `setPaused(false)` admin op. | `test_GT2_revokeIntent_immediate`, `test_GT2_pause_immediate_unpauseTimelocked` in `GatewayTreasury.t.sol` | fixed, live in v2; lag remains (see residual risks) |
| GT-3 (spec), fee part of GT-4 | Gateway spec, contract security | low | Per-intent cap understates the outflow | Gateway debits value plus fee, and the fee cap (2.01) is above the value cap (2), so one intent can debit about twice the cap. | `maxDebitPerIntent()` returns `perIntentCap + maxFeeCap` and the docs say each intent debits value plus fee. No fee-to-value bound was added. | `test_GT3_maxDebitPerIntent_includesFee` in `GatewayTreasury.t.sol` | partly fixed (exposed and documented, not bounded) |
| GT-4 (spec), UT-3 | Gateway spec, app and signer | medium | Solana leg has no programmatic intent policy | The FROST group key is a full Gateway delegate and `frost-delegate` signed any bytes, so any message a share threshold agrees on spends from the vault. | `frost-delegate sign` requires `--current-slot`, parses the message as exactly one hook-free burn intent and checks `<dir>/policy.json` (depositor, signer, domains, minter, token, recipient and caller per domain, value cap, fee cap, expiry window) before any share signs. | `policy_accepts_the_canonical_intent`, `policy_refuses_each_violation`, `refuses_anything_that_is_not_one_burn_intent` in `tools/frost-delegate/src/main.rs` | fixed in the tool; off-chain only (see residual risks) |
| UT-1 | app and signer | high | Vite dev server serves the sandbox keys | `/@fs/<repo>/.sandbox/ultimate-treasury/keys.json` returned 200, exposing every owner key and FROST share over HTTP. | `vite.config.ts` denies the sandbox key directory and repo files through `/@fs`; the app still serves. | `describe('UT-1 dev server file exposure')`: `/@fs/... is refused` (9 paths), `the app itself still serves`, `OPTIONS on the signer is refused (no CORS preflight answer)` in `apps/ultimate-treasury/server/hardening.test.ts` | fixed (local dev app) |
| UT-2 | app and signer | high | Refusal demos skip caps and balance; Solana refusal predicted from the wrong weights | `expectRefusal` removed the 1 USDC cap, per-intent cap and balance check, and the Solana refusal was predicted from on-chain EVM weights while signing used the FROST share map. | Caps and the balance check are unconditional. Solana sends return 409 when on-chain weights and the FROST share map disagree. | `describe('UT-2 send validation')`: `a refusal request cannot lift the sandbox cap`, `a refusal request cannot skip the balance check`, `Solana leg refuses when on-chain weights drifted from the FROST share map`, `a consistent request still validates` in `hardening.test.ts` | fixed (local dev app) |
| UT-4 | app and signer | medium | `localOnly` trusts the Host header | With `vite --host`, a LAN peer sending `Host: localhost` reached the signer; a page on another localhost port was accepted. | The signer gates on the socket address and the full origin, not on spoofable headers. | `describe('UT-4 localOnly')`: `a LAN peer spoofing Host: localhost is refused`, `loopback without Origin is allowed`, `a page on another localhost port is refused`, `the dev page itself is allowed`, `DNS rebinding (foreign Host) is still refused` in `hardening.test.ts` | fixed (local dev app) |
| UT-5 | app and signer | medium | Successful mint reported as an error; attestation lost | After 40 s of RPC lag a successful mint read as an error and the attestation was dropped, so a retry paid twice. | The attestation is written to the sandbox attestation directory (`server/send.ts`, `recordPendingMint`); a second send to the same recipient and amount is blocked while one is unminted; the minted amount is read from the receipt's Transfer log (`server/mint-log.ts`). | `describe('UT-5 mint bookkeeping')`: `a second send to the same recipient + amount is blocked while an attestation is unminted`, `minted amount is read from the receipt Transfer log, not a lagging balanceOf` in `hardening.test.ts` | fixed (local dev app) |
| UT-6 | app and signer | low | `dkg` overwrites live shares and writes them world-readable | Re-running `dkg` replaced the live delegate's shares, and the files were readable by other users. | `dkg` refuses to overwrite and writes owner-only (0600) files. | `dkg_refuses_to_overwrite_and_writes_owner_only_files` in `tools/frost-delegate/src/main.rs` | fixed; single-process DKG remains (see residual risks) |
| UT-7 | app and signer | low | Threshold pre-check counts duplicate signer labels | `--signers A,A` counted A's weight twice in the pre-check. | Duplicate or unknown labels are refused. | `duplicate_or_unknown_signer_labels_are_refused` in `tools/frost-delegate/src/main.rs` | fixed |
| UT-8 | app and signer | low | `u256be` drops the high 128 bits | A value or block height above 2^128 encodes wrong in `gateway-solana-delegate.ts`. | `u256be` moved to `packages/weighted-treasury/src/encoding.ts`: all four 64-bit words, overflow refused. Commit `0ac347d` had claimed this without changing the code; fixed after the fact-check caught it. | `encoding.regression-1.test.ts` (packages/weighted-treasury/test) (7 values incl. above 2^128, plus overflow refusal) | fixed |
| UT-9 | app and signer | low | Canary sends real funds to an unvalidated `TREASURY` | A typo in `TREASURY` sends USDC to an arbitrary address in step 1. | `canary.ts` checks that `TREASURY` is an address, has code on Arc testnet, and reads back its owners and Gateway wallet before sending. | No automated test. Verified by hand: `TREASURY=0x123` fails with "TREASURY is not an address"; an EOA fails with "has no code on Arc testnet"; a missing `DEPLOYER_PK` fails before anything runs. | fixed, manually verified |

## Findings not upheld or merged

The run summary does not record the skeptics' reasons, so no reason is given where none was recorded.

| ID | Lens | Severity | Title | Outcome |
| --- | --- | --- | --- | --- |
| GT-1 (spec) | Gateway spec | medium | Recipient, domain and token checked as independent sets | Merged into GT-1 above. |
| GT-6 (spec) | Gateway spec | low | `checkIntentShape` never pins `sourceDomain` or `destinationContract` | Merged into GT-4 above. |
| UT-3 | app and signer | medium | Solana policy only in dev-server code; `frost-delegate` signs arbitrary bytes | Merged into GT-4 (spec) above. |
| GT-5 | contract security | low | Permissionless `sweepToGateway` can block the timelocked escape hatch | Not upheld. `sweepToGateway` is unchanged. |
| GT-5 (spec) | Gateway spec | low | The guard constrains only the ERC-1271 path; the quorum can change policy instantly or add a delegate the guard never sees | No code change. Kept as a residual risk below. |

## Residual risks

These are open after the fixes. They come from the fix step's open issues.

1. **Fee is not bounded relative to value.** `maxFeeCap` is not kept below `perIntentCap` and there is no
   fee-to-value ratio. Arc's per-transfer fee floor (`maxFee` 2.01) is larger than small values, so either rule
   would refuse the live 1 USDC flow. `maxDebitPerIntent()` exposes the real per-intent debit (4.01 USDC on v2).
   Lowering `maxFeeCap` is a policy decision for the owners.
2. **An admin op is not consumed when its first execution fails.** Consuming it in a try/catch would let any
   caller burn it with a low-gas call. The 7-day expiry, the epoch and `cancelAdmin` bound it instead.
3. **Revoke and pause latency.** `revokeIntent` and `pause` reach Gateway only after its off-chain block lag (up
   to about 5 minutes). A pause also needs the quorum, not one owner. Gateway can still burn from the withdrawing
   balance.
4. **Solana policy is off-chain.** `frost-delegate`'s `policy.json` binds only signing that goes through the
   binary. A threshold of share holders who sign without it is not bound. The app server also checks the EVM
   treasury's on-chain allowlist before a Solana send, so two lists gate that path, and the sandbox `policy.json`
   must be kept in sync with the EVM allowlist by hand. The real fix is a Solana counterpart to ERC-1271 in
   Gateway, which is an open ask to Circle.
5. **The sandbox DKG runs every participant in one process.** It acts as a trusted dealer, so the threshold
   property is not real in the sandbox. Changing owner weights needs a new DKG and a new Squads `add_delegate`;
   until then Solana sends return 409.
6. **The guard has no timelock.** `GatewayTreasury` has one. The same quorum can reconfigure the guard at once,
   or uninstall it in v0.7 and reopen plain ERC-1271. In v0.8 only validations that carry the hook are guarded.
   Installing the guard also makes the account's ERC-1271 Gateway-only, so use a dedicated depositor account.
7. **Coverage-profile skip list is unverified for the v0.8 guard suite.** `GatewayIntentGuardModuleV08.t.sol`
   imports `CircleV08Harness`, which the coverage profile skips because of a stack-too-deep error. The skip list in
   `contracts/foundry.toml` was not updated and this was not checked.
8. **UT-8 was fixed late.** The fact-check found that `0ac347d` claimed a fix it did not make. It is now fixed with a
   regression test. Live runs were unaffected: every value and block height was far below 2^128.

Also open and not a finding: the guard (v0.7 plugin and v0.8 module) and nested ERC-1271 owners are tested in
forge only and have never run against live Gateway (ledger, "Not proven live"). Whether Gateway's enclave
simulation follows the nested calls, passes the signature trailer through unchanged, and treats a hook revert as
an invalid signature is unknown. The nested-owner gas cap is a 1,000,000 constant.
