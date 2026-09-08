# Vault book — plan

**Status: design. No Solidity written.** How a weighted-multisig treasury curates its own set of yield venues,
lets an agent rebalance inside that set, and keeps Circle Gateway as a settlement bucket rather than a yield
position. Supersedes the module-owner-curated `configHash` model in `BufiEarnModule`.

## 1. What is actually wrong today

Four defects, each verified in this repo rather than assumed.

| # | Defect | Evidence |
| --- | --- | --- |
| D1 | **The treasury cannot choose its own venues.** `setConfig` is `onlyOwner` on the shared module (`BufiEarnModule.sol:164`) — the MODULE owner curates the menu, the multisig only adopts a content hash off it. A treasury cannot add a vault the module owner has not registered. The deployed owner is still the deployer placeholder (`0x09Ce8E2B…`, README). | `BufiEarnModule.sol:164` |
| D2 | **One venue per token.** `config[configHash][chainId][token] = vault` (`:192`) is a single address, and `autoEarn(token, amount)` (`:260`) sends the whole sweep to it. Diversification is not expressible at all. | `BufiEarnModule.sol:102, 192, 260` |
| D3 | **The owner quorum cannot exit a position by hand.** `redeem` / `withdraw` carry no decodable ERC-20/721/1155 recipient, so `ColdStorageAddressBookPlugin` resolves `address(0)` and fails closed at validation — *even when the vault is on the allowlist*. The only in-place exit on a composed treasury is the agent path added in `SpendFromVault.t.sol`. | `test/bufi/v0.7/earn/TreasuryVaultExit.t.sol` (passing) |
| D4 | **No rebalance path exists.** `changeConfigHash` (`:206`) re-points FUTURE deposits; it does not move the existing position. Venue A → venue B today means exit (see D3) then sweep again. | `BufiEarnModule.sol:206` |

D3 also invalidates a line in `docs/EARN-MORPHO.md` §5, corrected in this change.

## 2. The vault book

A per-account, owner-curated set of venues. The list lives **on the account**, not on a shared module — that is
the whole of D1.

```
tokenVenues[account][token]  →  Venue[]

struct Venue {
    address target;      // the vault / Gateway wallet
    VenueKind kind;      // ERC4626 | GATEWAY
    uint256  principalCap;   // in token units; 0 = uncapped
}
```

Written only by an owner-quorum user operation, with the same two-dependency-slot shape
`ColdStorageAddressBookPlugin.addAllowedRecipients` and `changeConfigHash` already use: slot 0 backs runtime
validation (pointed at the weighted plugin's deliberately unimplemented id 1, so runtime is fail-closed), slot 1
backs userOp validation. `MAX_TOKENS`-style bounds carry over; add a `MAX_VENUES_PER_TOKEN`.

**Why not "VaultAddressBook".** Circle's AddressBook is a *recipient* allowlist with a token-transfer decoder,
and that decoder is precisely what causes D3. A venue list is a *target + operation* allowlist. Inheriting the
AddressBook abstraction inherits the bug. What it should inherit instead is the divergence already proven in
`BufiSessionRecipientHookPlugin.sol:306`: an undecodable zero-value call is judged by its TARGET.

## 3. Diversification: cap on-chain, target off-chain

The requested feature is weighted positions — 40 % Morpho, 30 % USYC, 30 % elsewhere. **Do not enforce weights
on-chain.** Three reasons, in order of severity.

1. **It puts an oracle inside the safety boundary.** Checking a weight means valuing each position, which means
   trusting `convertToAssets(balanceOf(account))` — a third-party share price — as a POLICY input. Morpho Vault
   V2 already reports `maxWithdraw == 0` for a holder who demonstrably can withdraw (pinned in
   `test/fork/earn/BufiSpendFromMorphoVaultV2.t.sol`). A venue that overstates share value would let an agent
   report compliance while concentrated. Today the allowlist is a set-membership check and is unmanipulable;
   weights turn it into a manipulable computation.
2. **Interfaces are not uniform.** Gateway is not ERC-4626: `totalBalance(token, depositor)`,
   `availableBalance`, `withdrawingBalance`, plus an ERC-1155-shaped `balanceOf(depositor, id)`
   (`IGatewayWallet.sol`). Every venue kind needs an adapter, and every adapter is new unaudited code in the
   policy path. Confirm USYC's shape before designing around it — it is not assumed here.
3. **Drift is continuous.** Different yields push the position out of band constantly: either constant
   rebalancing (gas, slippage, exit-liquidity risk) or bands wide enough that the weights stop meaning anything.

### What to do instead

| Layer | Holds | Why there |
| --- | --- | --- |
| On-chain | per-venue **caps on principal** (cost basis) | the module's own ledger — no price oracle in the policy path |
| Off-chain (agent / Shiva) | **target weights** | reads live values, proposes the move |

**The accounting, stated precisely.** An earlier draft of this section wrote the withdrawal leg as
`principal -= amount * (sharesBurned / sharesHeld)`. That is broken three ways and must not be built:
integer `sharesBurned / sharesHeld` is **0 on every partial withdrawal**; the asset amount is the wrong
multiplicand (principal 100 / 100 shares, withdraw 25 assets at par → subtracts 6.25, not 25); and a full
redemption after growth to 120 subtracts 120 from a principal of 100 and underflows.

Cost basis is removed in proportion to **shares burned**, never to assets received:

```
deposit(assets, sharesMinted):
    principal[a][t][v] += assets
    shares  [a][t][v] += sharesMinted

withdraw(sharesBurned):
    if sharesBurned >= shares[a][t][v]:            // full exit: no residue either way
        realized[a][t] += int(assetsOut) - int(principal[a][t][v])
        principal[a][t][v] = 0
        shares   [a][t][v] = 0
    else:
        basisOut = mulDiv(principal[a][t][v], sharesBurned, shares[a][t][v])   // round DOWN
        realized[a][t] += int(assetsOut) - int(basisOut)
        principal[a][t][v] -= basisOut
        shares   [a][t][v] -= sharesBurned
```

Rules the implementation must hold, each a test:

1. `mulDiv` with 512-bit intermediate (OZ `Math.mulDiv`). Round **down**, so residual basis is never
   understated and the cap never silently loosens.
2. The full-exit branch is explicit. Never reach zero shares by subtraction — it is where the underflow and
   the "principal 20 against zero shares" residue both come from.
3. `realized` is signed and per-(account, token), not per-venue. A venue exited at a loss must not silently
   return its full historical allowance to the cap (see limitation 3 below).
4. `shares[]` is the module's own counter, not `IERC20(venue).balanceOf`. It only stays true if **every**
   mutation routes through the module — which is the honest weak point, see §4a.

### What principal caps do NOT give you

State these in the product, not just here. They are real reductions in scope, not conservative framing.

1. **Appreciated exposure is invisible.** A venue at its principal cap can be worth far more than the cap.
2. **Denominator collapse.** A venue that was 40% of principal becomes 100% of *surviving value* when the
   others fail — and its cap is still satisfied. Absolute caps also permit concentration after a treasury
   spends down.
3. **Loss recycling.** Exiting a losing venue releases its historical principal allowance. Repeated
   round-trips can accumulate realized losses far beyond any single cap. Rule 3 above (signed `realized`)
   is the hook for bounding this; the bound itself is unspecified and needs a decision.
4. **One vault, one asset.** A conforming ERC-4626 vault has a single `asset()`. Registering the same vault
   under two tokens MUST revert. Multi-token venues (Gateway, Solana programs) hold **per-token** positions;
   summing caps across tokens is meaningless, and independent per-token caps do not bound aggregate venue
   exposure. That bound, if wanted, is a separate venue-level limit.
5. **Correlation is not addressed.** Distinct venue addresses sharing an issuer or an underlying market
   defeat the diversification the caps appear to buy.

### Correction to the argument, from adversarial review

The first draft leaned on two claims that do not hold:

- *"Morpho Vault V2 reports `maxWithdraw == 0`, therefore `convertToAssets` cannot be trusted as policy input."*
  Wrong inference. `maxWithdraw` is a **capacity** view, and ERC-4626 explicitly permits conservative capacity
  estimates. It says nothing about share-price accuracy. The narrower claim survives: a policy decision
  computed from a third-party share price is a different risk class than a set-membership check, and it is the
  reason to keep the on-chain layer oracle-free. The `maxWithdraw` finding is still worth keeping as an
  integration note (`test/fork/earn/BufiSpendFromMorphoVaultV2.t.sol`), just not as this argument's support.
- *"Continuous drift means constant rebalancing or meaningless bands."* Overstated. Drift is real; that it
  forces one of those two outcomes was asserted, not shown.

## 4. Rebalance

```
rebalance(address token, address fromVenue, address toVenue, uint256 shares)
```

Both venues in the account's book; destination under its principal cap after the move.

### 4a. Three problems the first draft did not have answers for

**Dispatch.** A session key reaches targets through `executeFromPluginExternal`, which rejects
`target == address(this)` and any `IPlugin` target (`PluginExecutor.sol:80`). So an agent **cannot call
`rebalance` on the vault book plugin at all**. Scoping a key to venue addresses does not help either — venues
do not implement `rebalance`. This needs an explicit dispatch design: either `rebalance` becomes an execution
function on the account reached by a userOp (owner-gated, not agent-reachable), or the agent submits the two
legs as ordinary `Call`s and the book enforces the pair through an execution hook. **Unresolved — decide
before any Solidity.**

**Metering.** The session key's ERC-20 budget counts `transfer` and `approve` on flagged contracts
(`SessionKeyPermissions.sol:642`). It cannot see value moved *inside* a `rebalance` or a `withdraw`. And
flagging a venue as ERC-20-budgeted rejects its withdrawal selectors outright — the trap already pinned in
`SpendFromVault.t.sol`. So **the existing budget mechanism cannot bound a rebalance.** A per-window turnover
counter in the book is the likely answer; it does not exist yet.

**Ledger coverage.** §3's accounting is authoritative only if every mutation routes through the module. It
does not today: agent withdrawals go straight to the vault (`SpendFromVault.t.sol`), owner exits would too,
legacy `autoEarn` writes no basis, and share transfers, third-party deposits into the account, and
uninstall/reinstall are all uncovered. Each needs an explicit rule before caps mean anything.

### 4b. "Value cannot leave the allowlist" is false

The first draft used this to argue an agent can safely hold standing rebalance authority. It does not hold:

- A permitted contract call can carry a **receiver, beneficiary or delegate** in its calldata. The recipient
  hook's own divergence (`BufiSessionRecipientHookPlugin.sol:306`) judges an undecodable call **by target
  only** — it never inspects who receives. `receiver = account` is an SDK convention, not an enforced boundary.
  Gateway `depositFor` is the same shape: an allowlisted target that credits someone else.
- Even with receivers pinned, a compromised rebalance key can churn fees and rounding, route everything to the
  worst permitted venue, and drain immediately-available liquidity. F-06's guards prove assets moved and shares
  appeared; they prove **nothing about the exchange rate**.

So standing agent rebalance authority needs, in addition to the book: enforced slippage/loss bounds per move,
a per-window turnover cap, a liquid-reserve floor, and receiver pinning on every venue call. Until those
exist, **rebalance is an owner-quorum operation.** That is a reversal of the first draft's recommendation.

## 5. Exit fix (D3) — the first draft's approach cannot work

The first draft proposed that the vault book's hook admit `redeem`/`withdraw` on the owners' `execute` path,
judged by target. **That is impossible.** ERC-6900 v0.7 composes hooks as **AND**: `_processPreExecHooks` and
the pre-validation path run *every* hook registered on the selector, and each must pass
(`BaseMSCA.sol:483`). `ColdStorageAddressBookPlugin` already hooks `execute`, and it fails closed on
`redeem`/`withdraw`. A second, more permissive hook cannot override that rejection, in any install order.

Two approaches that do work:

| Option | Mechanism | Cost |
| --- | --- | --- |
| **A. Dedicated exit selector** (preferred) | `exitVenue(token, venue, shares)` as an **execution function** on the vault book plugin, owner-gated through the two dependency slots (`changeConfigHash`'s shape). It moves funds via `executeFromPluginExternal`, which the AddressBook does not gate. | new execution function; the account gains a second funds-moving door, so its validation wiring is the whole security argument |
| **B. Change the AddressBook** | ask Circle to extend `RecipientAddressLib` with ERC-4626 selectors, or don't install the AddressBook on venue-holding treasuries | not ours to ship; already open as submission Q3 |

Option A also fixes the ledger gap in §4a — an exit through the module can write cost basis, which a raw
`execute` never could.

Until either lands, the break-glass path stands and belongs in the runbook: **uninstall the AddressBook →
redeem → reinstall**, three quorum userOps with the allowlist off for the middle one. `TreasuryVaultExit.t.sol`
proves the first two steps; **it does not yet prove reinstall**, which is the step an operator actually needs.
Extend that test.

Note the asymmetry this closes: on a fully composed treasury today the agent has more reach than the owners.

## 6. Gateway: a second bucket, not a weight

| Property | Consequence |
| --- | --- |
| **Not** generally illiquid — 7 days is the *trustless fallback* withdrawal path (`initiateWithdrawal` → `withdraw`). Gateway also supports instant transfers, including same-chain, via mint/burn. | Excluding Gateway from **synchronous on-chain sourcing** is still right: a burn intent is an off-chain-signed, attested flow, not something an execution hook or a `Call[]` can complete atomically. Calling the balance "illiquid" was wrong and is corrected here. |
| Not ERC-4626 — `totalBalance` / `availableBalance` / `withdrawingBalance` / ERC-1155-shaped `balanceOf` | needs its own adapter for any balance read; per-token positions (see §3 limitation 4) |
| Settlement / liquidity rail, not a yield venue | separate bucket with its own cap, weights only inside the yield bucket |

Policeable on the Gateway path today with target + selector scoping: `deposit`, `depositFor`, `addDelegate`,
`removeDelegate`, `initiateWithdrawal`, `withdraw`. Note `depositFor` credits an arbitrary depositor — it is an
allowlisted target that moves value to someone else's balance, exactly the §4b shape.

**Float is not bounded by drip size.** The "shrink the allocation" lever in §7 controls funding *throughput*,
not money *at risk*: unused windows accumulate. A cap on outstanding Gateway balance, reservation of pending
transfers, and a replenishment kill-switch are all still unspecified.

## 7. Burn-intent policy — cheaper than the first draft claimed

Two facts still hold: `UpgradableMSCA` has no native `isValidSignature`, and `WeightedWebauthnMultisigPlugin`
claims it as execution function [3] (`:189`). The first draft concluded that per-intent policy therefore
requires **replacing** Circle's ownership plugin, at a positioning cost. **That conclusion was wrong**, for the
same reason §5 was wrong, inverted:

**Hooks are AND.** A plugin can register an execution hook on a selector another plugin *owns*. So a read-only
hook on `isValidSignature` can require `approvedIntentDigest[d] == true` **in addition to** Circle's weighted
signature check. It adds a requirement; it never replaces one. Circle's canonical plugin, its address and its
manifest hash all stay.

| Lever | Mechanism | Price |
| --- | --- | --- |
| **1. Shrink the allocation** | agent drips float under a session-key budget | free — but see the float-accumulation caveat in §6; this bounds throughput, not exposure |
| **2. Pin approved digests** (revised) | an execution hook on `isValidSignature` requiring a quorum-pinned digest, *alongside* the weighted check | new unaudited hook. **No plugin fork, no positioning cost.** Every cross-chain move needs a prior quorum op |
| **3. Ask Circle** | intent fields passed to 1271, or per-validation-entity routing on v0.8 | free, slow; open item 3 in `GATEWAY-1271-EVALUATION.md` |

**Two caveats on lever 2, both from adversarial review:**

- Circle's ERC-1271 validation is **simulated by their TEE/RPC service against recent state**, and the burn
  carries that service's signature. It is not fresh on-chain policy execution at burn time, so **revocation
  lags** and a pinned-digest gate is a policy over what the service will attest, not a hard on-chain gate at
  the moment of burn. Verify the exact staleness window before relying on it.
- **The delegate path may not be dead.** Circle now documents EVM delegates that are **ERC-1271 contracts**,
  not only EOAs. A policy-bearing delegate contract deserves evaluation before building lever 2 at all. The
  first draft's "delegates are EOAs, therefore no policy is possible" is obsolete. What remains true: delegate
  authorization is token-scoped, and `removeDelegate` does not invalidate pre-signed intents.

## 8. Migration off `configHash`

The content-addressed adoption model exists to stop a module owner silently re-routing deposits. Once the venue
list is on-account and owner-written, that threat is gone and the hash is redundant.

1. Ship the vault book plugin alongside the current earn module; no account changes.
2. New `autoEarn(token, amount, venue)` overload validating `venue` against the book. Keep the old two-argument
   form working off `accountConfig` for installed accounts.
3. Accounts migrate by installing the book and populating it (one quorum op), then uninstalling the old module.
4. Retire `setConfig` / `changeConfigHash` once no account holds an adopted hash.

`autoEarn`'s F-06 guards (`asset()` match, shares minted, exact asset delta) carry over unchanged and extend to
the withdrawal side of `rebalance`.

## 8b. USYC — Q1 answered, and it needs no new adapter

Checked against `fx-telarana`, which already integrates it.

**USYC direct does NOT work with the current earn module.** Its Teller
(`fx-telarana/contracts/src/vault/interfaces/IUsycTeller.sol`, live on Arc testnet at
`0x9fdF14c5B14173D74C08Af27AebFf39240dC105A`) is ERC-4626-*style*, not ERC-4626:

| | Teller | Consequence |
| --- | --- | --- |
| `deposit(assets, receiver)`, `previewDeposit`, `previewRedeem`, `previewWithdraw`, `asset()` | present, standard | fine |
| `redeem(shares, receiver, account)` | same selector and semantics as ERC-4626's `redeem` | fine |
| `withdraw`, `convertTo*`, `max*`, `totalAssets`, `mint` | **absent** | the spend path in `docs/SPENDING-FROM-YIELD.md` calls `withdraw(uint256,address,address)` — it would not exist |
| **the Teller is not the share token** — USYC is a separate ERC-20 | structural | `autoEarn`'s F-06 guard reads `IERC20(vault).balanceOf(account)` to prove shares were minted. Pointed at the Teller that reads zero, so every deposit would revert `ZeroSharesMinted` |
| subscribe/redeem gated by an on-chain Entitlements authority on the USYC token | operational | the holding address must be entitled — a permissioned venue |

**But the wrapper already exists and is a standard ERC-4626.**
`fx-telarana/contracts/src/vault/UsycErc4626Adapter.sol` — asset = USDC, OpenZeppelin `ERC4626` with only
`_deposit` / `_withdraw` overridden to route through the Teller. So `deposit(assets, receiver)` and
`withdraw(assets, receiver, owner)` — the exact two calls this stack uses — are the stock implementations.
`_decimalsOffset() = 6` hardens the empty-vault inflation attack. Deployed on Arc testnet at
`0x9DF553fD6844F851080Aa126E40294f33c129d1E`, CREATE2-deterministic, consumed by the `IlAwareLimitOrderHook`
v4 stack.

Three consequences for this plan:

1. **`VenueKind` stays at two values — `ERC4626 | GATEWAY`.** USYC arrives as ERC-4626 through the adapter. No
   third adapter to write, no third code path in the policy engine. Q4's storage shape is unblocked.
2. **Entitlement sits on the adapter, not on the depositing treasury.** The adapter custodies the USYC, so a
   treasury MSCA needs no USYC entitlement of its own. That is a large simplification — and it is also what
   creates the question below. **A second adapter instance does not inherit it:** a fresh CREATE2 salt gives a
   fresh address that must be entitled on its own. Confirm the entitlement process before assuming the
   separate-pool fix in "the blocking question" is cheap.
3. **USYC is T+0 atomic.** So it IS a JIT-pullable venue: the spend path works against it unchanged. T+0 is
   not a guarantee that *any size* redeems immediately — freezes, entitlement changes and liquidity limits all
   still apply, and the sourcing path must surface the vault's own revert rather than pre-flighting capacity
   (see the `maxWithdraw` note in §3).

   One review point checked and rejected: the adapter is **not** a bare OZ `ERC4626` with only `_deposit` /
   `_withdraw` overridden — it also overrides `totalAssets()` to value the custodied USYC through
   `teller.previewRedeem(usyc.balanceOf(this))` plus idle USDC. Stock `totalAssets()` would have counted only
   idle USDC and ignored the position; it doesn't, so standard-wrapper compatibility holds.

### The blocking question is compliance, not engineering

The adapter's own NatSpec draws a wall: *"the wrapped principal is protocol-pooled order capital sitting in USYC
(treasury-tier), never retail NAV — the `retailAssets ∩ USYC = ∅` wall holds."*

A BUFI treasury MSCA depositing into that adapter puts customer treasury balances into the **same pool** as the
FX venue's order capital. Two things follow, and neither is an engineering call:

- whether that co-mingling is permitted under the `retailAssets ∩ USYC = ∅` wall as written;
- if it is, that a treasury's principal-cap accounting is then against a pooled vault whose NAV also moves with
  the FX venue's behaviour. That is a real concentration exposure and belongs in the venue's risk note, not
  buried in a cap parameter.

If the answer is that they must not share a pool, the fix is a second instance of the same adapter contract
(CREATE2 with a different salt) dedicated to treasury capital. Same code, separate position, wall intact.

## 9. Out of scope, and open questions

Out of scope: value-based rebalancing, automatic illiquid exits, cross-chain rebalancing, and any sourcing
path that completes a Gateway burn intent synchronously.

| # | Question | Blocks |
| --- | --- | --- |
| Q1 | ~~USYC's interface~~ — answered in §8b | resolved |
| Q4 | Principal cap absolute (token units) or relative (bps of total principal)? Relative needs a running total | vault book storage shape |
| Q5 | Is treasury capital allowed in the same `UsycErc4626Adapter` pool as FX order capital (§8b)? A separate instance needs its own entitlement | whether USYC is a venue in V1 |
| **Q6** | **How does an agent dispatch `rebalance` at all** (§4a)? Execution function reached by userOp, or two `Call`s paired by a hook? | any rebalance work |
| **Q7** | **What bounds a rebalance** — turnover cap, slippage bound, liquid-reserve floor? The ERC-20 budget provably cannot | standing agent authority |
| **Q8** | **What is the rule for every uncovered ledger mutation** (§4a): legacy `autoEarn`, agent withdrawals, share transfers, third-party deposits, uninstall/reinstall, opening basis at migration | whether caps mean anything |
| **Q9** | **Is loss recycling bounded** (§3 limitation 3), and by what? | cap semantics |
| **Q10** | **Gateway outstanding-balance ceiling** and replenishment kill-switch (§6) | Gateway bucket |
| **Q11** | **What is Circle's ERC-1271 attestation staleness window** (§7), and can an ERC-1271 *contract delegate* carry policy instead? | whether lever 2 is needed at all |

## 10. Test plan

| Suite | Pins |
| --- | --- |
| unit | book writes are quorum-only; runtime is fail-closed; `MAX_VENUES_PER_TOKEN`; principal accounting round-trips exactly through deposit → partial withdraw → full withdraw |
| on real MSCA | `autoEarn` to two venues for one token; cap rejection at the boundary; `rebalance` A→B under an agent key; rebalance to an unlisted venue rejected |
| exit (D3) | `exitVenue` through the owner quorum with the AddressBook installed; **plus** extend `TreasuryVaultExit.t.sol` to reinstall the AddressBook after the break-glass redeem — it stops at redeem today |
| accounting | the §3 formula against: partial withdrawal (must NOT be 0), full exit after growth (no underflow), full exit after loss (no residue), `mulDiv` rounding direction, two tokens on one venue (must revert for ERC-4626) |
| hook composition | prove AND semantics: a permissive book hook does NOT let `execute(vault, redeem)` past the AddressBook |
| adversarial | a venue that reports inflated `convertToAssets` cannot move principal accounting; a venue that mints zero shares; rebalance re-entrancy through a malicious venue |
| fork | Base mainnet: two live venues for USDC, agent rebalances between them, caps hold |
