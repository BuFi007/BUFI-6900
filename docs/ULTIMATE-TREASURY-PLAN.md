# Ultimate Treasury: one weighted multisig, one Gateway balance, EVM and Solana

**Status: plan (2026-10-05). Nothing below is built unless marked.** Asset first, chain abstracted: a team
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
| `maxBlockHeight` must be ≥ 7 days of blocks (Arc 1,209,600) | desk `docs/security/erc1271-gateway-signer.md:291-329` | Burn intents are long-lived; the policy (§3) must be enforced at signing time, not by expiry. |
| Fast Deposit (Unified Balance Kit): CCTP Fast Transfer from 9 sources into Avalanche and Polygon, Arc mainnet "planned"; **USDC only** | Fast Deposit blog | Fund the balance in seconds; the deposit lands on Avalanche/Polygon. |
| Gateway: 13 chains incl. Solana (domain 5) and Arc (domain 26, ~0.5 s to credit); USDC only today | supported-blockchains | EURC/cirBTC: design for multi-asset now, enable per asset when Circle does. |

## 2. What already exists (code review, 2026-10-05)

- **Proven live, Path A only:** a Circle developer-controlled wallet as Gateway signer: burn on Arc testnet → mint on
  Base Sepolia, tx `0x5fed9956…bb79` (desk `tasks/notes/2026-09-10-gateway-dcw-spend-proven.md:13`).
- **Built, never proven:** MSCA as Gateway depositor + ERC-1271 signer (desk plan 330, Gate 3 "live open").
  The 1271 blob builder exists (`packages/circle-kit/src/erc1271-plugin-signature.ts:349`); `/v1/transfer`
  with `contractSigner:true` was only shown to route (2026-08-05). **No ERC-1271 burn has ever been minted.**
- **Blockers on record:** AddressBook rejects Gateway calls; the nested treasury-quorum signer does not exist;
  the August QA passkey is lost; `isValidSignature` sees only the digest, so nothing limits what the quorum signs.
- **Solana:** EOA-only Gateway code in desk Shiva; Squads weighted treasury proven on devnet (this repo,
  `packages/weighted-treasury`), no Gateway leg.
- **Assets:** desk types allow `USDC | EURC` for Gateway; no EURC run, no cirBTC anywhere.

## 3. EVM leg: a Gateway-native weighted treasury with policy-checked ERC-1271

The piece the founder asked for: **"a plugin supported for Gateway."** It makes the multisig's signature mean
"the quorum approved THIS transfer to THIS allowlisted recipient", not just "the quorum signed some hash".

**`GatewayIntentGuard` (new, Solidity, view-only):** given `(hash, signature)` where the signature carries the
full `BurnIntent` (or `ReceiveWithAuthorization` for deposits) plus the owners' signatures:

1. Re-derive the EIP-712 hash from the carried struct and require it equals `hash` (no blind signing).
2. Weighted check: owner signatures (EOA, passkey/P-256, nested ERC-1271) sum to `thresholdWeight`
   (same rule and the same spec as `packages/weighted-treasury`).
3. Policy, all view-only so Gateway's simulation can run it: `destinationRecipient` ∈ allowlist,
   `destinationDomain` ∈ allowed domains, `sourceToken`/`destinationToken` ∈ listed assets,
   `value` ≤ per-intent cap, `destinationCaller` either zero or allowlisted, `hookData` empty unless allowlisted.
4. Deposits: a `ReceiveWithAuthorization` to GatewayWallet is approved only with `to == GatewayWallet`.

Two packagings, same logic:

- **(a) Standalone `GatewayTreasury` contract (sandbox, ships now):** the contract IS the Gateway depositor
  and `sourceSigner`. Owners, weights and allowlist live in it; admin changes need the quorum + a timelock.
  Anyone (Squads, Altitude, a DAO) can deploy one. No Circle allowlist needed.
- **(b) ERC-6900 validation plugin for Circle MSCAs (proposal):** the same checks as the account's ERC-1271
  route, reading Circle's AddressBook for the allowlist. Needs Circle to allowlist it (founder note
  2026-09-27: our plugins are not on Circle's allowlist), so it is a submission item, not a dependency.

**Budgets:** per-period caps need state, and Gateway's simulation is read-only. Options for the plan:
per-intent cap only (v1), or a period budget the quorum pre-books on-chain (`book(periodId, amount)`) that the
guard reads. v1 ships the per-intent cap and says so.

## 4. Solana leg: three options, ranked

Gateway on Solana accepts only an Ed25519 signature from the depositor or a delegate. A Squads vault cannot
produce one. So:

| Option | How | Who can move the money | Status |
| --- | --- | --- | --- |
| **S1. Threshold delegate (recommended for v1)** | The Squads quorum deposits from its vault and registers ONE delegate whose Ed25519 key is a **FROST threshold key** split among the same owners (weights = share counts). Squads can revoke it (`closeable_at_block`). | A weighted quorum, at the signature layer. The allowlist is enforced by the signing coordinator, not on-chain; disclosed. | Buildable now; FROST Ed25519 libs exist (e.g. `frost-ed25519` Rust, ZcashFoundation). |
| S2. Single delegate key | Squads registers a plain key | Whoever holds the key | Works today; **not acceptable** as "multisig". |
| **S3. "Solana ERC-1271" (ask Circle)** | Gateway's enclave reads a Squads-approved intent record (a PDA created by a quorum-executed `approve_intent(hash)`), the read-only equivalent of `isValidSignature` / Safe's approved hashes | The Squads quorum, on-chain, with Squads policies | Needs Circle. This is the ask in the submission. |

**One balance, two depositors.** A Gateway balance is keyed by depositor per domain. The EVM treasury has one
address on every EVM chain (CREATE2), so its EVM positions are already unified. The Solana position belongs to
a different key. The app shows one number (sum), and spends from either; moving value between them is a
Gateway transfer Solana → EVM recipient = the EVM treasury (then `depositFor`), approved on the Solana side.
Global budget: per-chain shares of one budget, never the same budget on both (SOLANA-MULTISIG-PLAN.md §6).

## 5. Sandbox: "Ultimate Treasury" built with Arc Studio

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
(`GATEwdfm…`), registers a FROST 2-of-3 delegate, signs a Solana → Arc burn with the threshold key, mints on
Arc. Uses `packages/weighted-treasury` for the Squads side.

## 6. Acceptance (what "done" means for the submission)

- [ ] `GatewayTreasury` + guard: forge suite green, including the parity matrix and every policy rejection.
- [ ] Live: ERC-1271 burn from the treasury contract minted on a second chain, tx hashes recorded.
- [ ] Live: Gateway refuses a non-allowlisted recipient and a sub-threshold quorum (refusals recorded).
- [ ] Live: deposit by quorum-signed `depositWithAuthorization` (no user operation).
- [ ] Solana: Squads deposit + FROST-delegate burn → EVM mint on devnet/testnet, or S1 marked blocked with the reason.
- [ ] Ultimate Treasury app: one balance, asset-first send, approvals, status; deployed preview URL.
- [ ] Submission doc for Circle: the ERC-6900 plugin (§3b) and the Solana program-signer ask (§4 S3).

## 7. Open questions

1. Does Gateway's enclave simulation resolve **nested** ERC-1271 (treasury contract → MSCA owner)? Unproven;
   the canary uses EOA/passkey owners first, nested second.
2. Does `depositWithAuthorization` on GatewayWallet accept a 1271 `from` on every Gateway chain's USDC version?
   Check each FiatToken version (v2.2+ needed) before listing a chain.
3. FROST key ceremony UX for passkey owners (passkeys cannot hold an Ed25519 share): owners would need a second
   key type on Solana. Circle user-controlled Solana wallets are Ed25519; can they produce a FROST share? Probably
   not; the coordinator may need its own share store. Decide before S1.
4. Who submits `gatewayMint` on the destination (gas): a Gas Station-sponsored wallet, or `destinationCaller` = 0.
