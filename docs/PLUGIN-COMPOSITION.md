# Plugin composition on a Circle ERC-6900 v0.7 account

Every claim below is pinned by a passing test in `contracts/test/**`; the test name follows each claim.
Account = production `UpgradableMSCA` (canonical bytecode) with `WeightedWebauthnMultisigPlugin` as the owner
plugin. Hooks in Circle's v0.7 account are **keyed by selector**, which is the single fact that decides what
composes with what.

## Selector map: which validation runs for which entry point

| Entry selector | Who validates (userOp) | Who validates (runtime) | Pre-validation hooks that fire |
| --- | --- | --- | --- |
| `execute`, `executeBatch` (IStandardExecutor) | Weighted owner validation (id 0) | none on weighted accounts (owners cannot act at runtime) | `ColdStorageAddressBookPlugin` (recipient allowlist) |
| `installPlugin`, `uninstallPlugin`, `upgradeToAndCall` | Weighted owner validation | — | none |
| `addAllowedRecipients`, `removeAllowedRecipients` (AddressBook) | dependency slot 1 → Weighted id 0 | dependency slot 0 → Weighted id **1 (unimplemented, fail-closed)** | none |
| `autoEarn` (BufiEarnModule) | **none** — not reachable by userOp | plugin SELF id 0: relayer / module owner only | none |
| `changeConfigHash` (BufiEarnModule) | dependency slot 1 → Weighted id 0 *(after the BUFI-6900 fix; unreachable in the 2026-08-02 build)* | slot 0 → fail-closed | none |
| `executeWithSessionKey` (BufiSessionKeyPlugin) | plugin SELF: the session key's ECDSA + permissions | — | **not** AddressBook (different selector) |
| session-key management (`addSessionKey`, `removeSessionKey`, `rotateSessionKey`, `updateKeyPermissions`) | slot 1 → Weighted id 0 | slot 0 → fail-closed | none |
| `executeFromPluginExternal` (called BY a plugin) | n/a (no `validateNativeFunction`) | permission check: caller plugin's manifest (`permitAnyExternalAddress` / per-target) | execution hooks on that selector only — none registered by any plugin here |

### Consequence 1 — the AddressBook allowlist gates the multisig's own transfers, nothing else

`ColdStorageAddressBookPlugin` registers pre-userOp and pre-runtime validation hooks on `execute` and
`executeBatch` only (its manifest; `IAccountLoupe.getPreValidationHooks` confirms). Therefore:

- **Earn deposits bypass it.** `autoEarn` moves funds through `executeFromPluginExternal`, which has no
  `validateNativeFunction` modifier and no hooks. A vault outside the allowlist still receives the deposit while
  the quorum itself cannot move one unit to that vault by `execute`
  (`BufiEarnModuleOnMsca.t.sol::test_addressBook_doesNotGateThePluginInitiatedDeposit_vaultOutsideAllowlistStillReceives`,
  `::test_addressBook_installedFirst_stillDoesNotGateTheDeposit`). What bounds the destination instead is the
  content-addressed config hash the multisig adopted: the plugin can only `approve` a token and `deposit` into
  `config[adoptedHash][chainid][token]`; shares mint to the account; redemption is an `execute`, which AddressBook
  DOES gate. A compromised relayer chooses timing and amount, never destination.
- **Session-key spends bypass it.** `executeWithSessionKey` is the plugin's own selector. Recipient restriction for
  an agent key must be expressed in the key's access list (function-level entries on the token's `transfer`
  selector / address entries). The grant DSL in `@bufi/modular-wallets-core` (`buildBufiGrant`) does exactly that
  — see the session-key section for the proof.
- **Gateway through `execute` is over-gated.** `approve(gateway)` passes when the Gateway address is
  allowlisted, but `addDelegate` / `deposit` / `initiateWithdrawal` / `withdraw` are rejected because AddressBook
  cannot decode a recipient from those selectors and fails closed
  (`GatewayHelperLocal.t.sol`, real-MSCA cases). An AddressBook-gated treasury cannot use Gateway via `execute`
  at all — a product-level constraint to design around, not a bug in either plugin.

### Consequence 2 — weighted owners never act at runtime

`WeightedWebauthnMultisigPlugin` implements no `runtimeValidationFunction` (k-of-n needs signatures). Any plugin
that gives its management functions a runtime-validation dependency must point that slot at function id 1 —
deliberately unimplemented — so the only way in is a userOp validated by id 0. Circle's AddressBook established
the idiom; BUFI's session-key and earn plugins follow it
(`CanonicalStack.t.sol::test_addressBookRuntimePathIsFailClosed`, session/earn suites).

## BufiEarnModule — what the real account changed

| Expectation from the plugin's own docs | Reality on Circle's account | Resolution |
| --- | --- | --- |
| "`changeConfigHash` is a multisig action" | Unreachable: it was not an execution function; `execute(plugin, …)` reverts `TargetIsPlugin`, a bare userOp has no validator, a runtime call hits `InvalidValidationFunctionId(0)` (`::test_changeConfigHash_isUnreachableOnARealMsca`) | Made an execution function with the two owner dependency slots (BUFI-6900 fix); alternative path uninstall + reinstall with the new hash also proven |
| `autoEarn` callable by the quorum | Not reachable by userOp (no userOp validation function), by design relayer-runtime only | Documented; matches the security model (relayer = timing only) |
| Install with owner dependency slots | Reverts `InvalidPluginDependency` — the original manifest declared none | Manifest now declares the two IPlugin dependencies for `changeConfigHash` |
| Deployed build `0xA9a9…` (Fuji + Arc, 2026-08-02) installs on Circle | Would fail ERC-165 (`PluginNotImplementInterface`): built against the EP-0.6 `UserOperation` struct | Rebuilt against Circle's real `IPlugin`; redeploy required |

## GatewayExecutionModule (v0.8) — reference-only status

The module is carried over so the Gateway findings stay reproducible, but the sandbox proves it must not be
listed as-is (`test/bufi/v0.8/gateway/README.md`):

- Gateway attributes deposits, delegates and withdrawals to **`msg.sender`**. When an account calls the module,
  the module is the Gateway depositor: `depositToGateway` spends the module's own tokens
  (`ERC20InsufficientBalance(module, 0, amount)` for an account-funded flow), `completeWithdrawal` pays the module
  and emits amount 0, and every installing account shares one depositor and can revoke another's delegate.
- The workable pattern is the one the desk-v1 `multi-sig-gateway` branch already landed on: the **account calls
  Gateway directly** with `GatewayHelper`-encoded calldata (`test_DirectExecution_PreservesMsgSender`).
- ERC-165: it advertises `IERC6900Module` (Circle v0.8 `IModule` id) + `IGatewayExecutionModule`, not
  `IERC6900ExecutionModule`; neither Circle v0.8 nor the 0.8.1 reference checks the latter at install.
- Interpretation of `withdrawalDelay()` (seconds vs blocks) is unverified against Sepolia; the local mock uses
  blocks.

Recommendation: keep `GatewayHelper` (pure encoder) and retire the execution module's money-moving functions
before any audit; the delegate-lifecycle *policy* belongs in the account's allowlist / session-key access lists.

## BufiSessionKeyPlugin — composition with Weighted + AddressBook

Proven in `test/bufi/v0.7/session/SessionKeyWithAddressBook.t.sol` and `AgenticWalletPolicy.t.sol` (Circle's production
bytecode for both Circle plugins, on the same weighted 2-of-3 account), and reproduced through the SDK fork + mock
Circle API by `apps/playground/scripts/e2e.ts`. Full deviation list: `contracts/src/bufi/v0.7/session/PORT-NOTES.md`.

| Question | Answer | Test |
| --- | --- | --- |
| Does the stock Alchemy plugin install? | **No** — `PluginNotImplementInterface` (v0.6 `UserOperation` in `IPlugin`). The port keeps the ABI byte-identical (interface id + every selector/event/error asserted against Alchemy's interface compiled side by side) and the storage layout identical; the one behavioural change is the v0.7 gas formula. | `SessionKeyOnCircleMsca.t.sol` install/ABI cases; `PORT-NOTES.md` D6 |
| Dependency slots | `[FunctionReference(weighted, 1), FunctionReference(weighted, 0)]` — same pair as the AddressBook; runtime path to key management fails closed, userOp path works; cannot be installed at account creation (init passes no dependencies), same as the AddressBook | `SessionKeyOnCircleMsca.t.sol` |
| Do AddressBook hooks fire for `executeWithSessionKey`? | **No.** AddressBook hooks `execute`/`executeBatch` only and registers no execution hooks. An unrestricted key pays a stranger the owners cannot pay. | `test_addressBookDoesNotGateSessionKeyTransfers` |
| Can the grant express recipients? | **Partly.** The access list inspects `Call.target` + selector. Native-value transfers ARE recipient-gateable (target == recipient), so mirroring the AddressBook set into the key's allowlist gives the intended AND-gate (stranger rejected, mixed batch rejected whole, list re-sync required after AddressBook changes). **ERC-20 transfers are NOT recipient-gateable**: a key scoped to `USDC.transfer` may name any recipient. | `test_erc20RecipientIsNotGatedBySessionKeyAccessList`; e2e step 4 |
| What bounds an agent, then? | token contract + selector, ERC-20 amount per refresh window, native amount, gas prefund per window, `validAfter/validUntil`, required paymaster. Escalation impossible: nine owner selectors + calling the account from inside a session-key op all rejected. | `AgenticWalletPolicy.t.sol`, `SessionKeyOnCircleMsca.t.sol` |
| Where is the ERC-20 budget enforced? | **Execution phase** (upstream design, kept): the op is included and reverts on-chain — gas is paid, no funds move. Time range, access list, gas and native limits are validation-phase (bundler rejects, AA22/AA23/AA24). | e2e step 4; `SessionKeyOnCircleMsca.t.sol` |
| Nonce rule | A gas-limited key must use its own address as the 192-bit nonce key (upstream rule kept). viem's `toSmartAccount` injects a time-derived key, so `toBufiSessionKeyAccount` pins the key — without it every agent op fails `PermissionsCheckFailed`. | `SessionKeyHarness.sol`; e2e |
| Management calls from the SDK | Raw userOp calldata, one call per userOp — never wrapped in `execute(account, …)`: the inner self-call re-enters runtime validation, which weighted owners deliberately cannot pass. Same rule for `installPlugin`, `changeConfigHash`, `addSessionKey`, `removeSessionKey`. | SDK `installPlugin` tests; e2e steps 2/3/5/6 |
| Install order | Irrelevant; neither plugin depends on the other. | `SessionKeyWithAddressBook.t.sol` |

### Closing the ERC-20 recipient gap (design note, not in the audited port)

Two options, both new unaudited code:
1. a BUFI hook plugin registering a `preUserOpValidationHook` on `executeWithSessionKey` that decodes `(Call[], address)`
   and re-uses Circle's `RecipientAddressLib` against the AddressBook set (hooks must be SELF — the PluginManager
   resolves them with an empty dependency list) — **now implemented, unaudited**, as `BufiSessionRecipientHookPlugin`
   (section below);
2. an extension of `_checkCallPermissions` with a per-key recipient list — remains an alternative; it would keep the
   audited port's storage layout only if the list lived in a new plugin-side mapping, and it would need re-syncing
   against the AddressBook the way the native-value mirror does today.

Without the hook installed, the agent envelope is: amount per window + gas per window + expiry + token/selector
scope — recipient restriction for ERC-20 lives in the owner-side grant issuance policy, exactly as
`docs/THREAT-MODEL.md` records. Question 3 of `docs/CIRCLE-SUBMISSION.md` (whether Circle will expose a
single-recipient view on the AddressBook) now only affects the hook's gas profile, not its correctness.

### Upstream behaviours kept verbatim that BUFI must design around

- ERC-20 budget is execution-phase (bundler includes, reverts on-chain, gas paid).
- Reconfiguring a limit keeps `limitUsed` (upstream NatSpec says cleared — it is not).
- `resetSessionKeyGasLimitTimestamp` is public.
- Gas-limited keys must use their address as nonce key.
- Circle's `ValidationDataLib` reports `validAfter >= validUntil` as `authorizer = 1` (AA24 instead of AA22) and
  reverts `WrongTimeBounds` on inverted bounds — ops are still rejected, only the error code differs.

## BufiSessionRecipientHookPlugin — closing the ERC-20 recipient gap

**Status: new, unaudited BUFI code** (`contracts/src/bufi/v0.7/recipient-hook/`). It is option 1 of the design note
above, built and pinned on Circle's canonical bytecode by
`contracts/test/bufi/v0.7/recipient-hook/BufiSessionRecipientHookPlugin.t.sol` (18 tests). Run it with
`FOUNDRY_OUT=out-hook FOUNDRY_CACHE_PATH=cache-hook forge test --match-path 'test/bufi/v0.7/recipient-hook/**' -vv`.

### Mechanism

Hooks in Circle's v0.7 account are keyed by selector, and `PluginManager.install` lets any plugin register a
pre-validation hook on any selector — including one owned by another plugin. The hook plugin has **no execution
functions, no dependencies, `permitAnyExternalAddress = false`, `canSpendNativeToken = false`**; its manifest is
exactly one `preUserOpValidationHook` and one `preRuntimeValidationHook`, both on
`IBufiSessionKeyPlugin.executeWithSessionKey.selector`, both `ManifestAssociatedFunctionType.SELF` (the
PluginManager resolves hooks with an empty dependency list, so `SELF` is the only admissible type).

On every session-key userOp the account runs the hook **before** the session-key plugin's own
`userOpValidationFunction` (`BaseMSCA._authenticateAndAuthorizeUserOp`: pre-hooks first, then the validator). The
hook decodes `userOp.callData[4:]` as `(Call[] calls, address sessionKey)` and, for every call, resolves the
recipient with logic identical to `ColdStorageAddressBookPlugin._getTargetOrRecipient`:

| Call shape | Recipient | Otherwise |
| --- | --- | --- |
| `value != 0` | `target`; calldata must be empty, target must be non-zero | `CallDataIsNotEmpty` / `UnauthorizedRecipient(account, 0)` |
| `value == 0` | `RecipientAddressLib`: ERC-20, then ERC-1155, then ERC-721 selector; target must have code | `InvalidTargetCodeLength` / `UnauthorizedRecipient(account, 0)` |

Each recipient must be in `IAddressBookPlugin(addressBook).getAllowedRecipients(account)`, the same set the
owners' `execute` / `executeBatch` are gated by. The three rejection errors are signature-identical to
`IAddressBookPlugin`'s, so an SDK that already decodes the AddressBook's AA23 data decodes the hook's the same way.
Batches are all-or-nothing (validation reverts on the first bad leg). Empty batches pass the hook but are rejected
by the session-key plugin's own audited "at least one call" rule.

**The AddressBook set is the single source of truth for both paths.** There is no mirrored per-key list and no
re-sync step: an owner-side `addAllowedRecipients` is visible to the agent in its next op, `removeAllowedRecipients`
closes it in the next op (`test_ownersAddThenRemoveRecipient_agentFollowsImmediately`). The key's own access list
still applies on top (AND-gate: a grant naming a stranger cannot widen the AddressBook,
`test_andGate_keyAccessListCannotOverrideTheAddressBook`), as do the ERC-20 / native / gas budgets and the time range.

What `RecipientAddressLib` calls "recipient" is worth knowing before writing a grant
(`test_approveSpender_and_transferFromTo_areTheRecipient`, `test_failsClosed_onUndecodableOrUnsupportedCalls`):

- `approve(spender, amount)` → the **spender** is the recipient (also `increaseAllowance` / `decreaseAllowance`), so
  an agent can only approve an allowlisted address;
- `transferFrom(from, to, amount)` → **`to`**; `from` is never inspected;
- any selector the library does not decode (`decimals()`, empty calldata to a contract, a truncated `transfer`)
  resolves to `address(0)` and is rejected — the hook never falls through to "allow";
- native value **and** calldata in one call is always rejected (`CallDataIsNotEmpty`), so a payable contract call
  can never pass, exactly as on the owners' path.

### Install

Install data is `abi.encode(address addressBookPlugin)`. `onInstall` rejects the zero address, an address without
code, a contract that does not declare `IAddressBookPlugin` via ERC-165, and — the check that makes "same set as the
owners" a property rather than a convention — any AddressBook that is **not an installed plugin of the installing
account** (read through `IAccountLoupe.getInstalledPlugins`; install runs in the execution phase, so the loupe call
is unconstrained). A bad install fails the whole `installPlugin` userOp as `FailToCallOnInstall(hook, reason)`
(`test_install_rejectsAnythingButTheInstalledAddressBook`).

Install order: **AddressBook first** (it must already be installed), then the session-key plugin and the hook in
either order. A pre-hook on a selector nobody owns yet is simply stored by Circle's PluginManager, so hook →
session-key works (`test_install_hookBeforeSessionKey`) as well as session-key → hook
(`test_install_addressBook_sessionKey_hook_loupeListsTheHook`). Neither BUFI plugin depends on the other, and the
hook is not a dependency of the AddressBook, so:

| Uninstall | Effect on the agent path | Test |
| --- | --- | --- |
| hook | gap reopens: the same key pays the same stranger again | `test_uninstallHook_reopensTheGap` |
| session-key plugin (hook still installed) | hook entries stay on the selector, harmless; hook can be uninstalled afterwards | `test_uninstall_sessionKeyFirst_thenHook` |
| AddressBook (hook still installed) | **fails closed**: Circle clears the set on the way out (sets under 5000 entries), so every agent recipient is rejected while the owners' `execute` opens; reinstalling the AddressBook reopens the agent path for the new set | `test_uninstallAddressBook_hookFailsClosed` |

For an AddressBook set of 5000+ entries Circle's `onUninstall` leaves the set in place (`AllowedAddressesNotRemoved`);
the hook then keeps enforcing that frozen set — it never widens. The owners' `execute` / `executeBatch` path is
untouched by the hook (`test_ownersExecutePath_stillWorksAndIsStillAddressBookGated`), and two accounts sharing the
one hook and one AddressBook deployment see only their own sets (`test_isolation_twoAccountsDifferentSets`).

### Storage and ERC-4337 / ERC-7562

The hook runs inside `validateUserOp`, so it obeys the validation-phase rules:

- The plugin's only storage is `mapping(address account => address addressBook)`, keyed by the account
  (account-associated, [STO-021]). The AddressBook set it reads is Circle's `AssociatedLinkedListSet`, also keyed by
  the account. No plugin-global storage is touched, nothing is written, no banned opcodes.
- One `STATICCALL` into the AddressBook plugin (`getAllowedRecipients`) and one `EXTCODESIZE` per zero-value call.
  Reading another plugin's account-associated storage is the same access class every plugin call already is (the
  account calls the AddressBook's own hook on `execute`), but a strict bundler tracer may surface the
  cross-contract read — list it in the bundler allowlist if one is used. `EXTCODESIZE` on a code-less address is
  itself [OP-041]; that branch reverts `InvalidTargetCodeLength` regardless, so the op is rejected either way.
- The runtime path to `executeWithSessionKey` is already rejected by the account before any pre-runtime hook runs
  (`InvalidValidationFunctionId`); the pre-runtime hook is registered anyway so the invariant survives a change there
  (`test_runtimePath_stillRejectedAtTheAccount`, `test_directCalls_unknownFunctionId_and_unboundAccount`).

### Gas

Membership is a linear scan over the array `getAllowedRecipients` returns: O(n) storage walk plus O(calls × n)
memory compares. Circle's set has an O(1) `contains`, but it is `internal` to `AssociatedLinkedListSetLib` and the
plugin exposes no single-recipient view; if one appears, `_contains` is the only thing to swap. Measured
(`test_gas_hookedVsUnhooked_fiveRecipients`, `actualGasUsed` from `UserOperationEvent`, same grant, same op, second
op on a warmed account, 5-entry allowlist):

| Session-key `USDC.transfer` | actualGasUsed |
| --- | --- |
| without the hook | 140,851 |
| with the hook, 5 recipients | 159,259 |
| overhead | **+18,408** (test asserts < 60,000) |

The cost is paid on simulation for any op naming the selector, bounded by the set size.

### Test map

| # | Claim | Test |
| --- | --- | --- |
| 1 | install matrix; loupe lists the hook; manifest is hooks-only; bad install data rejected | `test_install_addressBook_sessionKey_hook_loupeListsTheHook`, `test_install_hookBeforeSessionKey`, `test_install_rejectsAnythingButTheInstalledAddressBook`, `test_uninstall_sessionKeyFirst_thenHook`, `test_manifest_hooksOnly` |
| 2 | the gap is closed for a `USDC.transfer`-scoped key and for an unrestricted key (ERC-20, native, mixed batch); AND-gate; `approve` / `transferFrom` semantics; every undecodable shape rejected | `test_gapClosed_transferScopedKey`, `test_gapClosed_unrestrictedKey_native_erc20_batch`, `test_andGate_keyAccessListCannotOverrideTheAddressBook`, `test_approveSpender_and_transferFromTo_areTheRecipient`, `test_failsClosed_onUndecodableOrUnsupportedCalls` |
| 3 | owners add → agent pays immediately; remove → rejected again | `test_ownersAddThenRemoveRecipient_agentFollowsImmediately` |
| 4 | owners' `execute` path untouched and still AddressBook-gated | `test_ownersExecutePath_stillWorksAndIsStillAddressBookGated` |
| 5 | uninstall hook reopens the gap; uninstall AddressBook fails closed | `test_uninstallHook_reopensTheGap`, `test_uninstallAddressBook_hookFailsClosed` |
| 6 | two accounts, one hook, one AddressBook: isolated sets | `test_isolation_twoAccountsDifferentSets` |
| 7 | gas overhead with 5 recipients | `test_gas_hookedVsUnhooked_fiveRecipients` |
| 8 | direct-call surface: unknown function id, unbound account, runtime hook | `test_runtimePath_stillRejectedAtTheAccount`, `test_directCalls_unknownFunctionId_and_unboundAccount` |
