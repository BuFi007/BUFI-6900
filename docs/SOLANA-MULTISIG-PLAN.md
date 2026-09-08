# Solana multisig support — plan

**Status: design. No Rust written.** Whether BUFI's weighted-multisig treasury + agentic-wallet model
can exist on Solana, what carries across from `BUFI-6900`, and what has to be rebuilt. Companion to
`docs/VAULT-BOOK-PLAN.md`, which assumes EVM throughout.

## 0. The framing that matters

This is **a second stack, not a deployment target**. Nothing in `contracts/` ports: Solidity → Rust/Anchor,
no ERC-6900, no ERC-4337, no ERC-1271, no Circle MSCA. "Enable Solana deployments for our multisig" is not a
config change.

What makes it worth doing anyway: **Squads V4 already ships the payout half of the policy model** — per-key
budgets with windows and a destination allowlist — as audited, immutable on-chain primitives. It does **not**
ship the position half (deposit / withdraw / rebalance under agent authority); see §2. The first draft said
"most of the policy model" and was wrong about the half that matters for a yield treasury.

## 1. Ground truth (verified on-chain 2026-09-08, not from docs)

| Fact | Evidence |
| --- | --- |
| **Squads V4 Multisig is immutable.** `solana program show SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf -u m` → `Authority: none`. Audited by OtterSec, Neodyme, Certora, Trail of Bits. | upgrade authority revoked on mainnet |
| **Smart Account Program is upgradeable**, by a **3-of-5 autonomous Squads multisig**. Authority `HT3Jknwuu…Vu2` is the vault of multisig `DtgsedPQi8DdsgGLZiFii3ShwhrQN8v14EYsWAjmroxC`; `config_authority` is unset, so membership/threshold changes need a 3-of-5 vote themselves. **`time_lock = 0`** — an approved upgrade lands immediately. | decoded from the multisig account; the deploy tx `mLotv17z…` shows the authority as non-signer writable with `SQDS4ep65…` in the instruction list |
| **Circle Gateway is LIVE on Solana mainnet.** GatewayWallet `GATEwy4YxeiEbRJLwB6dXgg7q61e6zBPrMzYj5h1pRXQ`, GatewayMinter `GATEm5SoBJiSw1v2Pz1iPBgUYkXzCUJ27XSXhDfSyzVZ` (devnet: `GATEwdfm…X5vu` / `GATEmKK2…Havr`). **Correction:** an earlier draft said devnet-only, inferred from the absence of a Solana row in `/gateway/references/contract-addresses`. That page is EVM-only by design; Solana has its own pages. Also: `BurnIntentSet`s from Solana are not supported — each transfer needs a separate signed `BurnIntent`. | `/gateway/references/solana-programs`, `/gateway/references/solana` |
| **Circle Modular Wallets are EVM-only.** No MSCA, no ERC-6900, no bundler/paymaster, no `@bufi/modular-wallets-core` on Solana. | Circle docs |

## 2. What maps — and the overclaim the first draft made

**`SpendingLimit` moves tokens. That is all it does.** `spendingLimitUse` performs a SOL/SPL **transfer** to a
destination. It does not authorize arbitrary lending instructions, it cannot redeem a position, and it enforces
no principal accounting. Its `destinations[]` constrains that transfer path only — ordinary quorum-approved
vault transactions are unaffected by it.

So the first draft's "SpendingLimit replaces the two plugins this repo exists to build" is **wrong**. It
replaces the *payout* half. Agent authority over Squads-held **positions** — deposit, withdraw, rebalance — has
no proposal-free primitive in V4 at all.

| BUFI-6900 | Squads V4 | Fit |
| --- | --- | --- |
| ERC-20 budget + window on **outbound transfers** | `SpendingLimit { amount, period }` | direct |
| AddressBook recipient set, **for transfers** | `SpendingLimit.destinations[]` | direct — but an **empty list means unrestricted**, the inverse of fail-closed |
| Agent pays out alone under a cap | `spendingLimitUse`, no proposal | direct |
| Agent moves funds **into or between venues** | nothing | **no mapping.** Needs a policy program, or every move is a quorum proposal |
| Owner quorum | `threshold` + `Permission{Initiate,Vote,Execute}` | partial — §3 |
| Paymaster sponsorship | `feePayer` separate from `member` | free |

**The policy compiler loses semantics, and must fail loudly rather than quietly.** Mapping `BufiGrant` →
`SpendingLimit` drops: per-key expiry (no native equivalent), arbitrary refresh intervals (Squads offers four
fixed periods with different reset behaviour), selector scoping, and gas budgets. `BufiGrant` does not even
carry the recipient set — that lives in the EVM AddressBook. **A faithful compiler rejects an unsupported
policy; it never emits a weaker one silently.** That is a hard requirement on the §7 work item, not a detail.

## 3. Gap 1 — weights. Answerable by nesting, unproved in practice

`state/multisig.rs`: `Member { key: Pubkey, permissions: Permissions }` — **no weight field**. `threshold: u16`
over vote-permissioned members. Strictly k-of-n.

**Uniform weights already port exactly.** `_uniformWeights(3,1)` at threshold 2 *is* 2-of-3. And the Gateway
float-face pattern in `docs/AGENTIC-WALLET.md` (agent weight 1, threshold 1) is just **1-of-N** — it needs no
workaround at all.

**Non-uniform weights: nested multisigs.** In `instructions/proposal_vote.rs` the voting account is
`pub member: Signer<'info>`, and `validate()` checks only `is_member(member.key())` and
`member_has_permission(..., Vote)`. **Nothing requires an EOA.** A PDA satisfies `Signer` via `invoke_signed`,
so an inner multisig's vault PDA can hold a member seat on an outer multisig and vote by CPI.

This is general, not a trick: nested k-of-n composes AND and OR, so it expresses **any monotone boolean access
structure** — and every weighted threshold scheme is one. `A(2),B(1),C(1) @ threshold 2` becomes 1-of-2 outer
over `{A, inner 2-of-2 {B,C}}`.

**Cost is not "one extra transaction per level."** Two things the first draft did not price:

- **Construction size.** Expressing an arbitrary weighted scheme by expanding winning coalitions can require
  exponentially many branches. Cost tracks the number of participating groups and their proposal lifecycles,
  not nesting depth. For the small, hand-designed structures a treasury actually uses this is fine; as a
  general claim it was unpriced.
- **Per-level lifecycle.** Each inner group must create a vault transaction *and* a proposal, gather
  approvals, clear its own timelock, and execute — to cast **one** outer vote.

And the governance shape changes: independently mutable inner memberships turn one weighted policy into
several governance policies that can drift apart.

**Open, and blocking (S4).** Source review says the CPI vote is reachable — Squads signs with the inner vault
PDA, the outer only requires a `Signer` that is a vote-permissioned member, and Solana permits the CPI. What is
*not* established is the operational story: outer approval needs an **active, non-stale** proposal, while
already-approved inner vault transactions stay executable across config changes — so a membership change does
not uniformly revoke pending authority across levels. Add transaction-index races, duplicate votes,
cancellation, and an outer proposal reaching threshold mid-flight. **Prove this on devnet before committing to
nesting.** The first draft marked gap 1 "solved"; it is solved in principle and unproved in practice.

## 4. Gap 2 — no vault standard. Not solvable, and not new

Solana has no ERC-4626 equivalent. Every lending venue has its own interface.

This is less of a change than it looks: `fx-telarana`'s `UsycErc4626Adapter` exists **precisely because USYC's
Teller is not ERC-4626** (no `withdraw`, no `convertTo*`, no `max*`, and the Teller is not the share token).
The adapter-per-venue pattern is already how this org integrates non-standard venues.

`docs/VAULT-BOOK-PLAN.md` survives structurally: `Venue { target, kind, cap }`, principal-cap accounting,
caps-on-chain / targets-off-chain. Only `VenueKind` grows, and on Solana it grows per venue rather than
per exception.

## 5. Gap 3 — policy enforcement. On-chain, and extensible

From the Smart Account Program README: *"Atomic policy enforcement and transaction execution"* and
*"**Policies**: set rules on which an account can execute transactions and extend your account's functionality
by **creating your own policy programs**."*

Enforcement is in the program; the REST API at `developer-api.squads.so` is a convenience layer, not the trust
boundary. "Create your own policy programs" is the direct ERC-6900 analogue — and it is the clean home for
weighted approval without nesting.

Not yet, though: **v0.1**, `@sqds/smart-account` unpublished, **AGPL-3.0**, and **no upgrade timelock**.

**Correction on the licensing point:** an earlier draft framed AGPL as a clash with BUFI's posture. It is not
novel — `contracts/src/bufi/v0.7/earn/BufiEarnModule.sol` is **already AGPL-3.0-only** (`LICENSING.md:15`),
inherited from FluidKey. The network-use clause is still worth a deliberate read, but this repo already ships
AGPL in-tree.

## 6. Cross-chain: what "Circle MSCA supports Squads" can and cannot mean

An ERC-6900 plugin is EVM bytecode. It cannot execute on Solana, and **no plugin can make a Circle MSCA control
a Squads multisig directly.**

What can link them — V4 has the hook built in. `Multisig.config_authority`: *"if this parameter is set to any
other key, all the config changes for this multisig will need to be signed by the `config_authority`."* So a
PDA of a bridge-receiver program can hold `config_authority`, or hold a member seat with Vote permission (same
CPI mechanism as §3). The bridge is CCIP, Wormhole, or an off-chain relayer.

**Recommendation: do not put the bridge in the approval path.** A cross-chain quorum is only as strong as the
weaker of {EVM quorum, bridge}, and it inherits the bridge's latency and liveness. That trades away the
property that makes the EVM stack defensible.

**Mirror the policy, not the authority.** `packages/modular-wallets-core/src/cascade/agentGrantPresets.ts`
already describes policy abstractly — `{ scope.allow, budget.erc20, expiry }` — and `buildBufiGrant` compiles
it to EVM permission updates. The same preset compiles to a Squads `SpendingLimit` (within the limits in §2).
One policy vocabulary, two backends, each chain keeping its own local quorum. Use the bridge for **value only**
(CCTP or Gateway — both live on Solana mainnet), never for per-transaction approval.

**Two things this does NOT give you, both from adversarial review:**

1. **Mirroring is not one security boundary.** The same budget `B` installed on both chains authorizes up to
   `2B`, and neither chain can enforce a global cap from local state. Rotations and policy changes can land on
   one chain and not the other. The design must either split the budget explicitly or preallocate per-chain
   shares of a global one, and must define partial-rollout behaviour. Unspecified today.
2. **A Squads PDA cannot sign a Solana burn intent.** Gateway on Solana needs an **Ed25519 signature** from the
   depositor or an authorized delegate, produced off-chain. A PDA has no private key and cannot produce one.
   So a Squads-held Gateway position needs a delegate **key**, which moves the effective approval boundary off
   the multisig entirely. This is a custody and authority problem, not the minor interface question S5 was
   filed as — it is the single hardest open item in this plan.

## 7. Build order

1. **Prove nesting on devnet first (S4).** It is the load-bearing assumption of gap 1 and nothing is proved.
   If it does not hold operationally, the weighted-treasury story on V4 collapses and the Smart Account policy
   program moves from "later" to "required".
2. **Target Squads V4, not the Smart Account Program**, for the payout path. Immutable, four audits, and the
   budget + destination-allowlist primitive is already there.
3. **Backend-agnostic policy layer** in `@bufi/modular-wallets-core`: lift `BufiGrant` out of the EVM compiler
   so `buildBufiGrant` (EVM) and a new `buildSquadsSpendingLimit` (Solana) are two targets of one vocabulary —
   with the **reject-don't-weaken** rule from §2 as a hard requirement, and the empty-`destinations[]`
   fail-open trap covered by a test.
4. **Decide S7**: without a policy program, every venue move on Solana is a quorum proposal. That may be
   acceptable for V1 — say so explicitly rather than discovering it.
5. **Venue adapters per Solana lending venue**, following the `UsycErc4626Adapter` shape.
6. **Revisit the Smart Account Program** when it is past v0.1, has a published SDK, and has an upgrade timelock.
   A weighted-approval policy program there removes the nesting overhead and answers S7 in one move.

## 8. Open questions

| # | Question | Blocks |
| --- | --- | --- |
| S1 | Is an upgrade timelock planned for the Smart Account Program? `time_lock = 0` today means no window to react to a 3-of-5 compromise. | whether a treasury can ever sit on it |
| S2 | Does AGPL-3.0 on the Smart Account Program conflict with BUFI's licensing posture (`LICENSING.md`)? | same |
| S3 | Circle Gateway Solana **mainnet** date. Devnet-only today. | whether the unified-balance story is one chain or two |
| S4 | **Blocking.** Nesting on devnet end-to-end: inner `vaultTransactionExecute` CPIs outer `proposal_approve`, across a config change, with index races and stale-proposal behaviour observed. Source review says reachable; nothing is proved. | gap 1 |
| S5 | **Raised in severity.** A Squads PDA cannot produce the off-chain Ed25519 signature a Solana burn intent requires. Does a delegate key mean the Gateway position is effectively outside the multisig? | whether Squads can hold a Gateway position at all |
| S6 | How is a global (cross-chain) budget expressed when each chain enforces locally (§6)? | the policy-mirroring design |
| S7 | What supplies agent authority over Squads-held **positions** (§2) — a Smart Account policy program, or is every venue move a quorum proposal in V1? | the whole agentic story on Solana |

## 9. Out of scope

Porting `contracts/` in any form. Cross-chain per-transaction approval. Treating Gateway as a liquid
JIT-pullable source on either chain (7-day `withdrawalDelay()` on EVM; Solana not on mainnet).
