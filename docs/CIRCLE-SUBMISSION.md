# Submission to Circle — BUFI ERC-6900 plugins for Modular Wallets

**From:** BUFI (Business Finance; Circle Alliance member). **Repo:** `BuFi007/BUFI-6900`.
**Ask:** review and, if acceptable, list `BufiSessionKeyPlugin` (and `BufiEarnModule`) as installable plugins for
Circle Modular Wallets on the ERC-6900 v0.7 account generation; guidance on the v0.8 migration path for
`GatewayExecutionModule`.

## What is in the box

1. **A faithful local replica of your stack.** Your creation bytecode and CREATE2 salts from
   `buidl-wallet-contracts/script/bytecode-deploy` replayed on anvil / in Foundry tests, so the sandbox holds the
   production `UpgradableMSCAFactory`, `PluginManager`, `WeightedWebauthnMultisigPlugin` and
   `ColdStorageAddressBookPlugin` at the production addresses with the production manifest hashes. Nothing of
   yours is recompiled or modified.
2. **`BufiSessionKeyPlugin`** — ERC-6900 v0.7 session keys for AI-agent wallets: per-key access lists,
   ERC20/native/gas spend limits with refresh windows, `validAfter`/`validUntil`. A port of Alchemy's audited
   Modular Account v1 `SessionKeyPlugin` to ERC-4337 v0.7 (`PackedUserOperation`) and to your `BasePlugin`; the
   deviation list is `contracts/src/bufi/v0.7/session/PORT-NOTES.md`. Installed on your weighted-multisig account
   with the same dependency-slot arrangement you guided us to for the AddressBook (slot 0 → function id 1
   fail-closed, slot 1 → owner validation id 0).
3. **`BufiEarnModule`** — deposit-only auto-earn into multisig-adopted ERC-4626 vaults, triggered by a relayer.
4. **`GatewayExecutionModule`** (v0.8) — Gateway delegate lifecycle for treasury MSCAs; includes the finding that
   Gateway attributes deposits to `msg.sender`, so an MSCA must call Gateway directly with helper-encoded
   calldata.
5. **SDK fork** `@bufi/modular-wallets-core` — your web SDK plus plugin actions/decorators in your style, and
   **`@bufi/mock-circle`**, a Modular Wallets API stand-in (bundler + ERC-7677 paymaster) so the whole flow runs
   without credentials. Both are offered upstream if useful.

## Testnet addresses (identical on Avalanche Fuji 43113 and Arc testnet 5042002)

- `BufiSessionKeyPlugin` — `0x28504B34871Aa5a00269a960A9390187cbB5c070`, manifest `0xa32b3449ba437645e2386051ad0fcb64b0c2a9fed66b2eb4349505a2cb11ff5d`
- `BufiEarnModule` — `0x57D446a9A9c23d939035a924F7D3643B6eedE4Cf`, manifest `0x5adab6895bc4f41df3405079667ae5103316a130ce3ebe225402958a96652e53`

Both install on your production `UpgradableMSCA` on those chains with `dependencies =
[FunctionReference(WeightedWebauthnMultisigPlugin, 1), FunctionReference(WeightedWebauthnMultisigPlugin, 0)]`.

## Questions for Circle

1. Does `PluginManager.install`'s ERC-165 check intentionally exclude v0.6-shaped plugins (we hit
   `PluginNotImplementInterface` with Alchemy's stock plugin and with an earlier BUFI build), or is a shim planned?
2. Is the "runtime slot → unimplemented function id" pattern the sanctioned fail-closed idiom for weighted
   accounts, or should plugins ship a dedicated always-deny runtime validator?
3. `ColdStorageAddressBookPlugin` hooks `execute`/`executeBatch` only. For plugins that execute through
   `executeFromPluginExternal` or their own selector, is there an account-level way to apply the allowlist, or
   is per-plugin duplication (as we do) the intended model?
4. Modules Beta: if a Circle-audited session-key module for v0.7 accounts exists or is scheduled, we would prefer
   to adopt it — please share timing.
5. v0.8: expected mainnet timeline and whether v0.7 plugins should be re-authored as modules or wrapped.
6. v0.8 `ColdStorageAddressBookModule` (vendored source, not yet deployed): its manifest marks `addAllowedRecipients`
   as `skipRuntimeValidation`, so any caller can extend an account's allowlist, and attaching it to the sole global
   validation locks the account's administration (`test/bufi/v0.8/gateway/GatewayModuleOnCircleV08.t.sol`,
   findings 8–13 in that directory's README). Is this WIP, or intended for a different validation topology?
7. Would you accept `BufiSessionRecipientHookPlugin` (or extend `RecipientAddressLib`/AddressBook) so recipient
   policy covers plugin-owned selectors like `executeWithSessionKey`?

## Test matrix (regenerate with `bun run contracts:test`)

| Layer | Tests | Notes |
| --- | --- | --- |
| Contracts (`forge test`) | 197 | 83 of them are Alchemy's own SessionKeyPlugin cases re-run on Circle's production account bytecode |
| SDK fork (jest) | 441 | 315 upstream tests unchanged — the fork is a drop-in superset |
| Mock Circle API (bun test) | 16 | `circle_getAddress` output equals the address in Circle's own SDK fixture for the same owner |
| Sandbox e2e | 6 steps green | SDK fork → mock → canonical stack → plugins |

Findings we would like you to confirm or correct are enumerated in the repository README ("Findings surfaced by
the sandbox") and `docs/PLUGIN-COMPOSITION.md`.
