# Ultimate Treasury: one weighted multisig, one Gateway balance, EVM and Solana

**Status: plan with progress (updated 2026-10-05).** Nothing below is built unless §6 says it is done, ticked or partly done, and every address,
hash and count cited for a ticked item is in [EVIDENCE-LEDGER.md](EVIDENCE-LEDGER.md). Asset first, chain abstracted: a team
holds USDC (then EURC, cirBTC and the rest of the StableFX list as Gateway adds them), sees ONE balance, and
moves it with the same weighted approvals and recipient allowlist whichever chain the money sits on.

Sources read for this plan (2026-10-05): Circle blog "Gateway Adds ERC-1271 Support for Programmable
Authorization" (Aug 4 2026), "Fund Gateway Balances up to 40x Faster With Fast Deposit" (Sep 9 2026),
"A Practical Guide to Building With Circle Gateway"; developers.circle.com `gateway/references/erc-1271`,
`howtos/transfer-with-erc-1271`, `references/solana`, `references/solana-programs`, `howtos/manage-delegates`,
`references/contract-interfaces-and-events`, `references/supported-blockchains`. Existing work reviewed in
this repo and desk-v1 (see §2).

## 1. Facts that shape the design

| Fact | Source | Consequence |
| --- | --- | --- |
| Gateway validates ERC-1271 by simulating `isValidSignature` read-only in an AWS Nitro enclave, against ≥2 of 3 independent RPCs, on blocks up to **5 min** old | erc-1271 reference | A contract treasury can sign burn intents itself. Key rotation takes up to 5 min to bite. Validation logic must be **view-only**: no budget counters decremented inside `isValidSignature`. |
| ERC-1271 is **EVM-only** | erc-1271 reference | Solana needs another answer (§4). |
| Solana burn intents are signed by the depositor's **Ed25519 key or a delegate**; no BurnIntentSets from Solana | references/solana | A Squads vault (PDA, no key) can deposit and register a delegate by quorum vote, but every burn is then authorised by that one delegate key. |
| `depositWithAuthorization(token, from, value, validAfter, validBefore, nonce, bytes signature)` exists on GatewayWallet; USDC FiatToken validates ERC-1271 for `from` | contract-interfaces; `contracts/src/bufi/conduit/interfaces/IFiatTokenV2.sol:6` | The multisig deposits by **signing**, not by a user operation. Circle's ColdStorageAddressBook (which rejects `deposit`/`addDelegate`, GATEWAY-1271-EVALUATION.md:17) is never in the path. |
| Removing a delegate does **not** cancel burn intents it already signed | technical-guide "Delegates" | Delegates are high-privilege. Prefer ERC-1271 over delegates on EVM; on Solana make the delegate itself a quorum (§4). |
| `withdrawalDelay` is counted in **blocks** | contract-interfaces | Closes the open question in PLUGIN-COMPOSITION.md:74. |
| `maxBlockHeight` must be about 7 days of blocks above head (Arc testnet floor 1,209,599, ledger §5; Arc mainnet 1,209,600; Solana devnet 3,024,000 slots, ledger §5) | desk `docs/security/erc1271-gateway-signer.md:291-329`; [EVIDENCE-LEDGER.md](EVIDENCE-LEDGER.md) §5 | Burn intents are long-lived; the policy (§3) must be enforced at signing time, not by expiry. |
| Fast Deposit (Unified Balance Kit): CCTP Fast Transfer from 9 sources into Avalanche and Polygon, Arc mainnet "planned"; **USDC only** | Fast Deposit blog | Fund the balance in seconds; the deposit lands on Avalanche/Polygon. |
| Gateway: 13 chains incl. Solana (domain 5) and Arc (domain 26, ~0.5 s to credit); USDC only today | supported-blockchains | EURC/cirBTC: design for multi-asset now, enable per asset when Circle does. |

## 2. What existed before this work (code review, 2026-10-05)

- **Proven live, Path A only:** a Circle developer-controlled wallet as Gateway signer: burn on Arc testnet → mint on
  Base Sepolia, tx `0x5fed9956a5d61efd046659622c44da0181616c58aaa0525a01023e0d64abbb79` (desk `tasks/notes/2026-09-10-gateway-dcw-spend-proven.md:13`).
- **Built, never proven:** MSCA as Gateway depositor + ERC-1271 signer (desk plan 330, Gate 3 "live open").
  The 1271 blob builder exists (`packages/circle-kit/src/erc1271-plugin-signature.ts:349`); `/v1/transfer`
  with `contractSigner:true` was only shown to route (2026-08-05). **Before this work, no ERC-1271 burn had been
  minted from desk.** This repo's GatewayTreasury has since minted one (ledger §1).
- **Blockers on record:** AddressBook rejects Gateway calls; the nested treasury-quorum signer does not exist;
  the August QA passkey is lost; `isValidSignature` sees only the digest, so nothing limits what the quorum signs.
- **Solana:** EOA-only Gateway code in desk Shiva; Squads weighted treasury proven on devnet (this repo,
  `packages/weighted-treasury`), no Gateway leg before this work. The Squads + FROST Gateway leg has since run
  live (ledger §3).
- **Assets:** desk types allow `USDC | EURC` for Gateway; no EURC run, no cirBTC anywhere.

## 3. EVM leg: a Gateway-native weighted treasury with policy-checked ERC-1271

The piece the founder asked for: **"a plugin supported for Gateway."** It makes the multisig's signature mean
"the quorum approved THIS transfer to THIS allowlisted recipient", not just "the quorum signed some hash".

**`GatewayIntentGuard` (new, Solidity, view-only):** given `(hash, signature)` where the signature carries the
full `BurnIntent` (or `ReceiveWithAuthorization` for deposits) plus the owners' signatures:

1. Re-derive the EIP-712 hash from the carried struct and require it equals `hash` (no blind signing).
2. Weighted check: owner signatures (EOA, or a nested ERC-1271 contract such as a Circle MSCA whose own owners
   may be passkeys) sum to `thresholdWeight` (same rule and the same spec as `packages/weighted-treasury`). There
   is no direct P-256 owner type. Nested owners are proven live with a real Circle MSCA owner (ledger §7).
3. Policy, all view-only so Gateway's simulation can run it: `sourceDomain` = the local domain;
   `destinationDomain` in allowed domains and `destinationContract` = that domain's configured GatewayMinter;
   `destinationRecipient` in the allowlist and shaped for that domain (20-byte EVM address or 32-byte Solana key);
   `sourceToken`/`destinationToken` in listed assets; `value` nonzero and at or under the per-intent cap; `maxFee`
   at or under the fee cap; `destinationCaller` zero or on its own caller list; `hookData` always empty.
4. Deposits: a `ReceiveWithAuthorization` to GatewayWallet is approved only with `to == GatewayWallet`.

Two packagings, same logic:

- **(a) Standalone `GatewayTreasury` contract (sandbox, ships now):** the contract IS the Gateway depositor
  and `sourceSigner`. Owners, weights and allowlist live in it; admin changes need the quorum + a timelock.
  Emergency levers `revokeIntent` and `pause` need the quorum but no timelock; Gateway sees them after its block
  lag of up to about 5 minutes. Unpausing is a timelocked admin op.
  Anyone (Squads, Altitude, a DAO) can deploy one. No Circle allowlist needed.
- **(b) ERC-6900 guard for Circle MSCAs (v0.7 proven live, v0.8 forge only):** `GatewayIntentGuard`, a v0.7 plugin and a v0.8
  module in `contracts/src/bufi/gateway-guard/` (design in `docs/GATEWAY-INTENT-GUARD.md`). It applies the same
  policy to the account's ERC-1271 route and reads Circle's AddressBook for EVM-domain recipients only. Tested in
  forge (GatewayIntentGuardPluginTest 42, GatewayIntentGuardModuleV08Test 14, ledger §6). The v0.7 plugin is proven
  live: installed on a real Circle MSCA on Arc testnet with a multisig-signed user operation, Gateway refused a
  non-allowlisted recipient and a blind quorum signature and accepted the policy-conformant intent (ledger §8).
  Circle's factory allowlist governs only plugins installed at creation, so no Circle change was needed to install it
  on-chain; Circle's Modular Wallets API and app surfaces would still need to support it (founder note 2026-09-27).

**Budgets:** per-period caps need state, and Gateway's simulation is read-only. Options for the plan:
per-intent cap only (v1), or a period budget the quorum pre-books on-chain (`book(periodId, amount)`) that the
guard reads. v1 ships the per-intent cap and says so. The cap bounds value only. Each intent debits value + fee,
so the most one intent can take is `maxDebitPerIntent()` = 4.01 USDC on v2 (ledger §1).

## 4. Solana leg: three options, ranked

Gateway on Solana accepts only an Ed25519 signature from the depositor or a delegate. A Squads vault cannot
produce one. So:

| Option | How | Who can move the money | Status |
| --- | --- | --- | --- |
| **S1. Threshold delegate (recommended for v1)** | The Squads quorum deposits from its vault and registers ONE delegate whose Ed25519 key is a **FROST threshold key** split among the same owners (weights = share counts). Squads can revoke it (`closeable_at_block`). | A weighted quorum of FROST share holders. The allowlist is not on-chain. Two off-chain gates stand in for it: the app server checks the recipient against the EVM treasury's on-chain allowlist, then `frost-delegate sign` checks `policy.json` before any share signs. The two lists are kept in sync by hand. Share holders who sign without `frost-delegate` are bound by neither. | Built and run live, Solana devnet → Arc testnet (ledger §3). The sandbox DKG runs every participant in one process, so the sandbox threshold property is not real (§7 Q3). |
| S2. Single delegate key | Squads registers a plain key | Whoever holds the key | Works today; **not acceptable** as "multisig". |
| **S3. "Solana ERC-1271" (ask Circle)** | Gateway's enclave reads a Squads-approved intent record (a PDA created by a quorum-executed `approve_intent(hash)`), the read-only equivalent of `isValidSignature` / Safe's approved hashes | The Squads quorum, on-chain, with Squads policies | Needs Circle. This is the ask in the submission. |

**One balance, two depositors.** A Gateway balance is keyed by depositor per domain. The EVM treasury is
deployed on Arc testnet only, with plain CREATE (ledger §1). A same address on every EVM chain is not available:
`localDomain` is a constructor argument, so the init code differs per chain. Each EVM chain needs its own
treasury, and its positions are separate depositors, like the Solana one. The Solana position belongs to a
different key. The app shows one number (sum), and spends from either; moving value between them is a
Gateway transfer Solana → EVM recipient = the EVM treasury (then `depositFor`), approved on the Solana side.
Global budget: per-chain shares of one budget, never the same budget on both (SOLANA-MULTISIG-PLAN.md §6).

## 5. Sandbox: "Ultimate Treasury" built with Arc Studio

**What actually happened (2026-10-05).** Arc Studio drafted the contracts only (turn 1). The app turn timed out, so
`apps/ultimate-treasury` was built by hand in this repo. Everything was re-verified locally: forge (142 passed on the
gateway paths), our own canary scripts, and the live runs in [GATEWAY-TREASURY-CANARY.md](GATEWAY-TREASURY-CANARY.md).
Items from turn 3 below that were NOT done:

- Balances cover Arc testnet (the EVM treasury) and Solana devnet (the Squads vault) only. Base Sepolia and Fuji
  positions are not read.
- No Fast Deposit funding flow.
- Gateway fee constants are not quoted in the app from a live fee source. The app uses a fixed "typical fee" to pick
  the source position.

The plan as written before the run follows.

Arc Studio (`arc-studio` 1.1.3, authenticated) builds and deploys in its own hosted Vite + Foundry sandbox on
Arc testnet with Gateway preloaded. It never touches this repo; we send context with `--file` and pull artifacts.

**Session `ultimate-treasury`, balanced/max preset, three turns:**

1. **Contracts:** `GatewayTreasury` + `GatewayIntentGuard` (§3a) with Foundry tests: weighted acceptance
   (reuse the parity matrix from `packages/weighted-treasury/test/parity.test.ts`), allowlist / domain / token /
   cap rejections, hash-binding (no blind signing), deposit via `depositWithAuthorization`, timelocked admin.
   Context sent: `docs/WEIGHTED-TREASURY-SQUADS.md`, `packages/weighted-treasury/src/spec.ts`, the GatewayWallet
   interface (`contracts/src/bufi/v0.8/gateway/interfaces/IGatewayWallet.sol`), the BurnIntent EIP-712 types.
2. **Deploy + live canary on Arc testnet → Base Sepolia:** deposit 5 USDC by quorum-signed authorization;
   POST `/v1/transfer` with `contractSigner:true`; `gatewayMint` on Base Sepolia. Plus negative probes: a
   non-allowlisted recipient must be refused by Gateway ("contract signature verification failed"), a
   below-threshold quorum likewise. **This is the first ERC-1271 Gateway burn we would ever have minted.**
3. **App, asset first:** one USDC number (Gateway `/v1/balances` across Arc, Base Sepolia, Fuji and the Solana
   devnet depositor), per-chain breakdown collapsed by default; "Send" asks asset, amount, recipient, never a
   chain unless the user opens it; approvals collected per owner; status from intent to mint; Fast Deposit
   funding where routes exist; EURC/cirBTC rows shown as "not on Gateway yet".

We pull the result into `apps/ultimate-treasury` + `contracts/src/bufi/gateway-treasury/`, then re-verify
locally (`forge test`, our own canary script) before claiming anything. Arc Studio's word is not evidence.

**Solana in the sandbox:** turn 4 (separate, local): Squads vault on devnet deposits into GatewayWallet
(`GATEwdfmYNELfp5wDmmR6noSr2vHnAfBPMm2PvCzX5vu` on devnet, from
`packages/weighted-treasury/scripts/gateway-solana-delegate.ts`), registers a FROST delegate (built as 4 shares,
threshold 3, A holds 2; ledger §3), signs a Solana → Arc burn with the threshold key, mints on
Arc. Uses `packages/weighted-treasury` for the Squads side.

## 6. Acceptance (what "done" means for the submission)

Every hash for a ticked item is in [EVIDENCE-LEDGER.md](EVIDENCE-LEDGER.md) in full.

- [x] `GatewayTreasury` + guard: forge green on `test/bufi/gateway-*`: 142 passed (GatewayTreasuryTest 54,
  GatewayTreasuryNestedOwnersTest 28, GatewayTreasuryCircleMscaOwnerTest 4, GatewayIntentGuardPluginTest 42,
  GatewayIntentGuardModuleV08Test 14), including the parity matrix, every policy rejection and the regression tests
  for the security-review fixes. Full default profile: 458 passed on the working tree (ledger §6), which includes
  4 tests from an untracked file; 454 on a clean export of the tracked tree at `d332422`. The v0.7 guard and nested
  owners are also proven live (ledger §7, §8).
- [x] Live: ERC-1271 burn from the treasury contract minted on a second chain. Current source, v2 treasury
  `0xC3f4De2372167F7FFA0a1B3FbF221a8a7289e7d5`, mint on Base Sepolia (ledger §1). The v1 run (ledger §2) is
  superseded: it predates the review fixes.
- [x] Live: Gateway refuses a non-allowlisted recipient and a sub-threshold quorum (v2, ledger §1; reproducible
  400s, not on-chain).
- [x] Live: deposit by quorum-signed `depositWithAuthorization` (no user operation), v2 (ledger §1).
- [x] Solana: Squads deposit + FROST-delegate burn → mint on Arc testnet (ledger §3,
  docs/GATEWAY-TREASURY-CANARY.md).
- [ ] Ultimate Treasury app. Done: one USDC balance (Arc + Solana positions), asset-first send, per-owner approvals,
  status from intent to mint, refusal demos, live sends on both legs (ledger §2 and §3, against v1 bytecode on the
  EVM leg). The app now points at v2; no app send against v2 is recorded yet. Not done: Base Sepolia and Fuji
  balances, Fast Deposit (§5). It runs as a local dev app only. A hosted preview is intentionally not offered: the
  signer is dev-only by design, so a hosted build can read balances but cannot send.
- [x] Submission doc for Circle: the ERC-6900 plugin (§3b), the GatewayIntentGuard and the Solana program-signer ask
  (§4 S3), in `docs/SUBMISSION-ULTIMATE-TREASURY.md` (refreshed 2026-10-05).

## 7. Open questions

1. **Answered (2026-10-05).** Gateway's enclave resolves nested ERC-1271: a treasury owned by an EOA and a real
   Circle MSCA was refused at 1-of-3 inner signatures and accepted at 2-of-3 (ledger §7). It also runs the v0.7
   guard's pre-runtime hook and treats a hook revert as invalid (ledger §8). Unmeasured: gas for heavier owners.
2. **Proven on Arc testnet only.** `depositWithAuthorization` with the treasury contract as the 1271 `from` was
   credited on Arc testnet (v1 and v2, ledger §1 and §2). Every other Gateway chain's USDC version (FiatToken v2.2+
   needed) is still unchecked. Check each before listing a chain.
3. **Open.** FROST key ceremony for passkey owners (passkeys cannot hold an Ed25519 share). Current behaviour: the
   sandbox DKG runs every participant in one process and writes all shares to `.sandbox/ultimate-treasury/frost/`
   on one machine, so the sandbox threshold property is not real. Passkey owners are not supported on the Solana
   leg. Circle user-controlled Solana wallets are Ed25519, but producing a FROST share from one is unexplored.
4. **Open.** Who submits `gatewayMint` on the destination. Current behaviour: one sandbox EVM fee payer
   (`0x09Ce8E2B3Fede2727dA4392Ea8Fe618305ba0474`) submits every mint on Base Sepolia and Arc testnet, with
   `destinationCaller` = 0. A Gas Station-sponsored wallet is not wired.
