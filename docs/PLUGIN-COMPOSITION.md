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

_Filled from `test/bufi/v0.7/session/**` and `contracts/src/bufi/v0.7/session/PORT-NOTES.md` once the port
lands (see README "Findings")._
