# Is a Gateway plugin efficient at all? — evaluation against Circle Gateway's ERC-1271 rail

**Verdict: no. A Gateway *execution* plugin is structurally wrong on a Circle MSCA, and with Gateway's ERC-1271
support (shipped 2026-08-04) it is also unnecessary. The account itself is the Gateway depositor and the burn-intent
signer; the only defensible on-chain Gateway policy is a small pre-validation *hook* on the account's own `execute`
path, and even that duplicates what `ColdStorageAddressBookPlugin` already does (badly) for Gateway targets.**

## Evidence

| # | Fact | Where it is proven |
| --- | --- | --- |
| 1 | Gateway attributes deposits, delegates and withdrawals to `msg.sender`. When an ERC-6900 account routes a call through an execution module, the module is `msg.sender` → the module becomes the depositor, `depositToGateway` spends the **module's** balance, `completeWithdrawal` pays the module, and every installing account shares one Gateway position (any account can revoke another's delegate). | `contracts/test/bufi/v0.8/gateway/GatewayExecutionModuleLocal.t.sol::test_depositToGateway_pullsFromTheModule_notTheCallingAccount`, `::test_authorizeDelegate_isAttributedToTheModule_notTheCallingAccount`; on a real Circle v0.8 account in `GatewayModuleOnCircleV08.t.sol` (harness follow-up) |
| 2 | The account calling Gateway **directly** (helper-encoded calldata through `execute`) is attributed correctly. | `GatewayHelperLocal.t.sol::test_DirectExecution_PreservesMsgSender` + the three real-MSCA cases |
| 3 | Gateway's ERC-1271 validation calls `isValidSignature` **on the account**, read-only, over the bare EIP-712 burn-intent digest; the plugin rehashes it. Nothing inside the digest is recoverable, so **no per-intent policy (recipient, amount, destination) can be enforced in validation** — only key-level scoping. Revocation applies with ≤5 min lag. | desk-v1 `docs/security/erc1271-gateway-signer.md` (V1, V3), plan 212 wave-1 spike; canary run 2026-08-18 provisioned a passkey-owned ops MSCA on Fuji + Arc for this rail |
| 4 | A plugin cannot add validation-time policy either: ERC-1271 `isValidSignature` on a Circle MSCA is routed to the ownership plugin (`WeightedWebauthnMultisigPlugin`); other plugins get no say, and any state-changing accounting is impossible (read-only). | Circle `BaseMSCA.isValidSignature` routing; V3 in the desk doc |
| 5 | Gas: the module path adds a full extra call frame and its own storage on top of Gateway's cost (module `authorizeDelegate` 47–54k, `depositToGateway` 57–91k in the local suite) while the helper encoders cost ~1k and the account's `execute` overhead is the same for any target. The module buys nothing for that gas. | `forge test --gas-report` on the gateway suites |
| 6 | With `ColdStorageAddressBookPlugin` installed, an account cannot call Gateway through `execute` at all: `approve(gateway)` passes when the Gateway address is allowlisted, but `addDelegate` / `deposit` / `initiateWithdrawal` / `withdraw` are rejected because the AddressBook fails closed on selectors it cannot decode. | `GatewayHelperLocal.t.sol` real-MSCA cases |

## What the rail actually looks like with ERC-1271

```
treasury / ops MSCA  ──execute(GatewayWallet, deposit(USDC, amt))──▶  Gateway position owned by the MSCA
        │
        └── burn intent signed by the owner set → Gateway calls MSCA.isValidSignature (read-only) → attestation → mint
```

No plugin appears in that picture. The module we carried over from `multi-sig-gateway` was designed before the
ERC-1271 rail existed (its own NatSpec says "Gateway validates burn intent signatures OFF-CHAIN first"); the
`GatewayHelper` encoders are the surviving useful part and the SDK/Shiva already build those calls.

## What *could* be a plugin (and whether it is worth it)

| Candidate | Value | Cost | Recommendation |
| --- | --- | --- | --- |
| **Gateway policy hook** — a SELF `preUserOpValidationHook` on `execute`/`executeBatch` that, when `target == GatewayWallet`, allows only `deposit`/`depositFor`/`addDelegate`/`removeDelegate`/`initiateWithdrawal`/`withdraw` with an allowlisted delegate set and per-window deposit caps | Closes finding 6 (AddressBook over-gates Gateway) without opening the allowlist to arbitrary calls; gives treasuries a delegate allowlist on-chain | New unaudited code; still cannot gate burn intents (finding 3) — those are bounded only by which owners can sign and by Gateway's own allocation cap; duplicates policy the AddressBook could express if Circle added a Gateway-aware decoder | **Only if Circle confirms AddressBook will not learn Gateway selectors** (submission Q3). Otherwise ask Circle to extend `RecipientAddressLib` — cheaper for everyone |
| Gateway execution module (v0.7 or v0.8) | none — wrong `msg.sender`, shared position | audit surface, gas | **Retire.** Keep `GatewayHelper` as a library + the local/fork tests as regression evidence |
| Validation module that scopes burn-intent signers (v0.8) | would let a treasury delegate Gateway-only signing to a key | ERC-1271 routing goes to the ownership validation; a separate validation entity is a v0.8 feature Circle's production accounts (v0.7) do not have | Revisit on v0.8; on v0.7 the "Gateway-only key" is simply an owner with a low weight, which is what plan 212 D7 does |

## Consequences for the cascade

- **Depositor identity = the MSCA address** (treasury or ops), never a plugin, never a delegate contract.
  Allocation-is-the-cap doctrine (plan 212 D7) stays the spend bound; per-intent recipient policy stays
  off-chain at intent creation (V1 verdict), on-chain only at `execute` via the AddressBook / a Gateway hook.
- **Agentic wallets and Gateway**: a `BufiSessionKeyPlugin` key can be scoped to `GatewayWallet` + the deposit
  selectors (target + selector access list) with a native/gas budget; it cannot sign burn intents (those are
  owner-signed through the ownership plugin), which is the right separation — agents can *fund* a Gateway
  position, never *move* it cross-chain.
- **Treasury earn and Gateway do not conflict**: earn deposits go through `executeFromPluginExternal` (not gated,
  bounded by the adopted config hash), Gateway deposits through `execute` (gated by AddressBook / hook).

## Open items to verify with Circle

1. Whether `ColdStorageAddressBookPlugin` will decode Gateway selectors (then no Gateway hook is needed).
2. V4 in the desk doc — attest-time vs burn-time validation and the measured revocation lag — still docs-sourced.
3. Whether Circle's v0.8 accounts will expose ERC-1271 routing per validation entity (would enable a Gateway-only
   signer without weight games).
