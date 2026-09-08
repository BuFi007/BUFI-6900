# Codex handoff — BUFI vault book + Solana multisig

Paste everything below the line as your first message to Codex. It is written to be read cold, with no
prior conversation. Every load-bearing claim carries a citation so you can verify rather than trust.

---

You are taking over two design plans and turning them into implementation. Model: gpt-6-astra. Work at
`xhigh` for design decisions, `high` for code.

## What this repo is

`BUFI-6900` — an ERC-6900 plugin sandbox for Circle Modular Smart Contract Accounts (MSCA). It redeploys
Circle's production v0.7 stack at Circle's canonical addresses on a local chain, installs BUFI's own plugins
on it, and proves they compose. Read `README.md` first, then `docs/AGENTIC-WALLET.md` for the product shape.

Four plugins matter:

| Plugin | Role |
| --- | --- |
| `WeightedWebauthnMultisigPlugin` (Circle) | owner set, weights + threshold, ERC-1271 |
| `ColdStorageAddressBookPlugin` (Circle) | recipient allowlist on `execute` / `executeBatch` |
| `BufiSessionKeyPlugin` | agent session keys: target+selector scope, ERC-20/native/gas budgets with refresh windows, expiry, required paymaster |
| `BufiSessionRecipientHookPlugin` | recipient enforcement on `executeWithSessionKey` |
| `BufiEarnModule` | relayer-triggered deposits into an ERC-4626 vault. **Deposit-only.** |

## The two plans

- `docs/VAULT-BOOK-PLAN.md` — per-account curated venue allowlist, principal-cap accounting, rebalance, exit.
- `docs/SOLANA-MULTISIG-PLAN.md` — whether this model can exist on Solana via Squads V4.

**Both have already survived one adversarial review and were corrected** (commit `ce9ba9a`). Sections that
say "the first draft claimed X, that was wrong" are scar tissue — read them, they are the highest-value part.
Do not re-derive those corrections; attack what is left.

## Ground truth — verified, do not re-litigate

| Fact | Evidence |
| --- | --- |
| **ERC-6900 v0.7 hooks compose as AND.** Every hook on a selector must pass. A permissive hook can never widen what another hook denies. Corollary: a hook CAN add a requirement to a selector another plugin owns. | `contracts/lib/buidl-wallet-contracts/src/msca/6900/v0.7/account/BaseMSCA.sol:161,483`, `libs/ExecutionHookLib.sol` |
| **A plugin cannot call the account or another plugin.** `executeFromPluginToExternal` reverts if `target == address(this)` or the target implements `IPlugin`. | `.../managers/PluginExecutor.sol:80` |
| **On a treasury with the AddressBook installed, the owner quorum cannot exit an ERC-4626 position by hand.** `redeem`/`withdraw` carry no decodable recipient → resolves `address(0)` → fails closed, even with the vault allowlisted. Break-glass is uninstall → redeem → reinstall. | `contracts/test/bufi/v0.7/earn/TreasuryVaultExit.t.sol` (passing) |
| **An agent CAN exit, in one op.** `executeWithSessionKey([vault.withdraw, token.transfer])` works because the BUFI recipient hook judges an undecodable zero-value call **by target**. | `contracts/src/bufi/v0.7/recipient-hook/BufiSessionRecipientHookPlugin.sol:306`, proven in `contracts/test/bufi/v0.7/session/SpendFromVault.t.sol` and on a Base fork against live Morpho Vault V2 in `contracts/test/fork/earn/BufiSpendFromMorphoVaultV2.t.sol` |
| **Grant-time trap:** a vault registered with an ERC-20 spend limit rejects `withdraw` at validation — `isAllowedERC20Function` is `transfer \|\| approve` only. Vault shares are ERC-20, so this is easy to hit. | `contracts/src/bufi/v0.7/session/permissions/SessionKeyPermissions.sol:217,642` |
| **Morpho Vault V2 reports `maxWithdraw == 0` for a holder that can withdraw.** Never preflight capacity with it. | pinned in the fork test above |
| **`ERC-1271` is a plugin-owned selector** on `UpgradableMSCA` (no native implementation); the weighted plugin claims it as execution function [3]. | `.../plugins/v1_0_0/multisig/WeightedWebauthnMultisigPlugin.sol:189` |
| **Squads V4 Multisig is immutable** (`Authority: none`); the Smart Account Program is upgradeable by a 3-of-5 autonomous Squads multisig with `time_lock = 0`. | `solana program show SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf -u m`; multisig `DtgsedPQi8DdsgGLZiFii3ShwhrQN8v14EYsWAjmroxC` |
| **Squads V4 has no member weights.** `Member { key, permissions }`, threshold is k-of-n. Voting takes a plain `Signer` with only membership+permission checks, so a PDA can vote by CPI. | `Squads-Protocol/v4` `state/multisig.rs`, `instructions/proposal_vote.rs` |
| **Circle Gateway is live on Solana mainnet.** `GATEwy4YxeiEbRJLwB6dXgg7q61e6zBPrMzYj5h1pRXQ` / `GATEm5SoBJiSw1v2Pz1iPBgUYkXzCUJ27XSXhDfSyzVZ`. Solana has its own doc pages; the `/gateway/references/contract-addresses` page is EVM-only. | `developers.circle.com/gateway/references/solana-programs` |
| **FluidKey's earn module has no withdraw path at all** — wrap + approve + `IERC4626.deposit`, nothing else. Spending from yield happens in the transaction their app builds. BUFI's deposit-only shape is inherited, not an omission. | `fluidkey/fluidkey-earn-module@122cde1`, `src/FluidkeyEarnModule.sol` |

## Your job, in order

**1. Answer the blocking questions before writing Solidity.** They are Q6–Q11 in `VAULT-BOOK-PLAN.md` §9 and
S4–S7 in `SOLANA-MULTISIG-PLAN.md` §8. The three that gate everything:

- **Q6 — dispatch.** An agent cannot call `rebalance` on a plugin (`PluginExecutor.sol:80`). Either it is an
  owner-gated execution function reached by userOp, or the agent submits two `Call`s and a hook enforces the
  pair. Pick one and justify it against the AND-composition constraint.
- **Q8 — ledger coverage.** The principal ledger is authoritative only if every mutation routes through the
  module. Today it does not: agent withdrawals, owner exits, legacy `autoEarn`, share transfers, third-party
  deposits, uninstall/reinstall. Write the rule for each or the caps mean nothing.
- **S4 — nesting.** Prove on devnet that an inner Squads multisig's vault PDA can CPI `proposal_approve` on an
  outer multisig, across a config change, with index races and stale-proposal behaviour observed. Source
  review says reachable. Nothing is proved. If it fails, the weighted-treasury story on V4 collapses.

**2. Then build, in this order:** vault book plugin (account-owned venue list, quorum-written) → `autoEarn`
with a vault argument → `exitVenue` (the §5 replacement for the broken hook idea) → rebalance, only once Q7's
bounds exist.

**3. Non-goals.** Do not port `contracts/` to Rust. Do not build value-based rebalancing. Do not put a
cross-chain bridge in any approval path. Do not treat Circle Gateway as a synchronous liquidity source.

## Repo conventions

```bash
bun install
bun run contracts:test                                   # forge, default profile — 293 tests
FOUNDRY_PROFILE=fork forge test --fork-url https://mainnet.base.org \
  --fork-block-number 50769826 --match-path 'test/fork/earn/**' -vv   # public RPC, no key needed
cd packages/modular-wallets-core && npx jest             # 481 tests
```

- solc 0.8.24, evm `paris`, `via_ir`, 200 runs — Circle's exact profile. Do not change it; bytecode
  equivalence with Circle's production deployment is the point of the harness.
- The `fork` profile is `cancun` and matches only `test/fork/earn/**`. Passing `--no-match-path` on the CLI
  **overrides** `foundry.toml`'s `no_match_path` and pulls in fork tests that then fail without an RPC.
- Licensing is per-directory, see `LICENSING.md`. `BufiEarnModule.sol` is **AGPL-3.0-only** (inherited from
  FluidKey); the session-key port and new BUFI code are GPL-3.0-or-later; the SDK fork stays Apache-2.0.
- New plugin code is unaudited. Say so in the NatSpec, as the existing plugins do.

## Gotchas that will cost you an hour each

1. **Two plugins cannot own the same selector.** Relevant to any migration that keeps the legacy earn module
   installed alongside a new one (`PluginManager.sol`).
2. **Weighted multisig owners cannot act at runtime**, only through userOps. Any plugin management function
   needing a runtime-validation dependency must point that slot at the weighted plugin's deliberately
   unimplemented function id 1 (fail-closed) and the userOp slot at id 0. Circle's AddressBook is the
   precedent; `BufiEarnModule.changeConfigHash` follows it.
3. **The AddressBook fails closed on every non-token selector.** This is the root cause of the exit bug, and
   it blocks Gateway calls too (`docs/GATEWAY-1271-EVALUATION.md` finding 6). Any design that assumes a
   composed treasury can call an arbitrary protocol through `execute` is wrong.
4. **Decoding a Squads V4 `Multisig` account:** `rent_collector` is a Borsh `Option<Pubkey>` — 1 byte when
   `None` — but `Multisig::size()` always reserves 33. Using the size layout to deserialize shifts the member
   count and every member by 32 bytes.
5. **USYC is not ERC-4626.** Its Teller lacks `withdraw`/`convertTo*`/`max*`, and the Teller is not the share
   token, so `autoEarn`'s share-minted guard would revert. Use `fx-telarana`'s `UsycErc4626Adapter`, which is
   a standard wrapper and does override `totalAssets()`.

## How to work

Verify before asserting. Every claim above has a citation; check the ones your design depends on. When you
find one of them wrong, say so plainly and cite what you found — the last review turned up four errors in
these plans and that was the most valuable output of the session.
