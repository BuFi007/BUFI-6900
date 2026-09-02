# BufiSessionKeyPlugin — port notes

**Upstream:** alchemyplatform/modular-account **v1.0.1**, commit `1ceb7935b3d8642283f0dc8fd0a7a7f00132be9d`
(`lib/alchemy-modular-account`), files `src/plugins/session/**`, `src/libraries/PluginStorageLib.sol`.
Audits: `lib/alchemy-modular-account/audits/`.

**Target:** Circle `UpgradableMSCA` (circlefin/buidl-wallet-contracts, `lib/buidl-wallet-contracts`), ERC-6900 **v0.7**,
ERC-4337 **v0.7** EntryPoint `0x0000000071727De22E5E9d8BAf0edAc6f37da032`. Toolchain: solc 0.8.24, via-IR, optimizer 200,
evm paris (`contracts/foundry.toml`). OpenZeppelin 5.0.2. erc6900/modular-account-libs `d64adb5`.

**Why a port:** Circle's `IPlugin` takes `PackedUserOperation` in `preUserOpValidationHook` / `userOpValidationFunction`;
Alchemy's takes the v0.6 `UserOperation`. The ERC-165 interface ids differ, so Circle's `PluginManager.install` reverts
`PluginNotImplementInterface` on the stock plugin.

---

## Composition findings

Proven in `test/bufi/v0.7/session/SessionKeyWithAddressBook.t.sol` with `ColdStorageAddressBookPlugin` (Circle's
production bytecode at its canonical address) installed on the **same** weighted-multisig account:

1. **AddressBook hooks do NOT fire for session-key userOps.** `ColdStorageAddressBookPlugin` registers its
   pre-userOp and pre-runtime validation hooks on `IStandardExecutor.execute` and `executeBatch` **only**, and registers
   **no execution hooks** at all (`getExecutionHooks(executeFromPluginExternal.selector).length == 0`). A session-key
   userOp carries the `executeWithSessionKey` selector and executes through `executeFromPluginExternal`, so the
   AddressBook plugin is never consulted. `test_addressBookDoesNotGateSessionKeyTransfers` shows the owners' `execute`
   to a stranger rejected by the AddressBook while an unrestricted session key pays the same stranger (ERC-20 and native).

2. **Recipient enforcement for an agent key is therefore ONLY the key's own access list**, which inspects
   `Call.target` and the 4-byte selector — never the recipient encoded inside ERC-20 calldata. Consequences:
   - **Native-value transfers are gateable** (`target == recipient`): mirroring the AddressBook set into the key's
     allowlist as address entries gives the intended AND-gate. `test_andGate_nativeRecipients_strangerRejected` and
     `test_andGate_followsAddressBookUpdates` prove a stranger is rejected in validation (`AA23` /
     `PermissionsCheckFailed`) and a mixed batch is rejected as a whole; a stranger promoted on the AddressBook becomes
     reachable only after the key list is re-synced too.
   - **ERC-20 transfers are NOT gateable per recipient** with the stock permission model. A key scoped to
     `USDC.transfer` may still name **any** recipient. `test_erc20RecipientIsNotGatedBySessionKeyAccessList` pins this:
     the transfer to a stranger succeeds; only the token contract and the selector are enforced.

3. **What closing the ERC-20 gap would take** (out of scope for an audited port, recorded for the next decision): a
   BUFI hook plugin that registers a `preUserOpValidationHook` on `executeWithSessionKey.selector`, decodes
   `(Call[], address)`, and reuses Circle's `RecipientAddressLib` against the AddressBook set (or its own set); OR a
   deliberate extension of `_checkCallPermissions` with a per-key recipient list. Both are new code an auditor has not
   seen. Circle's `PluginManager` resolves pre-validation hooks with an empty dependency list, so the hook must be SELF.

4. **Install order does not matter** for the finding (AddressBook installed first here); neither plugin depends on the
   other, both depend only on the weighted plugin's function ids `1` (runtime, unimplemented → fail-closed) and `0`
   (`USER_OP_VALIDATION_OWNER`).

---

## File map (how to diff against upstream)

| Ported file (`src/bufi/v0.7/session/`) | Upstream (`lib/alchemy-modular-account/src/`) | Status |
| --- | --- | --- |
| `IBufiSessionKeyPlugin.sol` | `plugins/session/ISessionKeyPlugin.sol` | interface renamed, `Call` import swapped, ABI identical (D1) |
| `permissions/ISessionKeyPermissionsUpdates.sol` | `plugins/session/permissions/ISessionKeyPermissionsUpdates.sol` | verbatim except import (D2) |
| `libraries/PluginStorageLib.sol` | `libraries/PluginStorageLib.sol` (MIT) | verbatim, pragma pinned (D3) |
| `permissions/SessionKeyPermissionsBase.sol` | `plugins/session/permissions/SessionKeyPermissionsBase.sol` | verbatim except pragma/imports (D4) |
| `permissions/SessionKeyPermissionsLoupe.sol` | `plugins/session/permissions/SessionKeyPermissionsLoupe.sol` | verbatim except pragma/imports/name (D5) |
| `permissions/SessionKeyPermissions.sol` | `plugins/session/permissions/SessionKeyPermissions.sol` | one behavioural change: v0.7 gas cost (D6) |
| `BufiSessionKeyPlugin.sol` | `plugins/session/SessionKeyPlugin.sol` + `plugins/BasePlugin.sol` | base class + v0.7 struct + OZ5 (D7) |
| — (dependency) | `libraries/AssociatedLinkedListSetLib.sol`, `libraries/Constants.sol` | taken from `@modular-account-libs` (D8) |
| — (dependency) | `helpers/CastLib.sol` | taken from `@circle/libs/CastLib.sol` (D9) |

Suggested diff: `diff <(grep -v '^//' lib/alchemy-modular-account/src/plugins/session/permissions/SessionKeyPermissions.sol)
<(grep -v '^//' src/bufi/v0.7/session/permissions/SessionKeyPermissions.sol)` and likewise per row. Every intentional
change is marked `PORT:` inline (`grep -n PORT src/bufi/v0.7/session -r`).

---

## Deviations from the audited original (complete list)

### D1 — `IBufiSessionKeyPlugin.sol` ← `ISessionKeyPlugin.sol`
- Interface renamed `ISessionKeyPlugin` → `IBufiSessionKeyPlugin` (`:28`). Names do not enter selectors or ERC-165 ids;
  `test_abiMatchesAlchemyInterface` (`SessionKeyOnCircleMsca.t.sol`) asserts `type(IBufiSessionKeyPlugin).interfaceId ==
  type(ISessionKeyPlugin).interfaceId` and every function / event / error selector individually, compiling Alchemy's
  interface side by side.
- `Call` imported from `@circle/msca/6900/v0.7/common/Structs.sol` (`:26`) instead of Alchemy's `IStandardExecutor.sol`;
  both are `{address target; uint256 value; bytes data;}`.
- Unused `UserOperation` import dropped. Pragma `^0.8.22` → `0.8.24`.

### D2 — `permissions/ISessionKeyPermissionsUpdates.sol`
- Import path/name only (`:24`, and the parameter type of `setAccessListType`, `:35`). All eight selectors asserted
  equal to Alchemy's in `test_abiMatchesAlchemyInterface`.

### D3 — `libraries/PluginStorageLib.sol`
- Vendored verbatim under its MIT header; pragma `^0.8.22` → `0.8.24` (`:14`). `@modular-account-libs` ships the same
  code as `ModuleStorageLib` (diff: name, pragma, assembly annotation); vendored under the original name so the storage
  derivation diffs line-for-line against the audited tree.

### D4 — `permissions/SessionKeyPermissionsBase.sol`
- Pragma (`:23`) and the two imports (`:25-26`). Prefix constants, key widths, batch index, struct layouts and every
  storage pointer derivation are unchanged.

### D5 — `permissions/SessionKeyPermissionsLoupe.sol`
- Pragma (`:22`), imports (`:24-25`), `@inheritdoc` target name. Bodies unchanged.

### D6 — `permissions/SessionKeyPermissions.sol`
- Imports (`:30-35`): `PackedUserOperation` + `UserOperationLib` from the pinned eth-infinitism v0.7 tree replace the
  v0.6 `UserOperation`; `Call` from Circle; Circle's `SIG_VALIDATION_SUCCEEDED` is imported **as** `SIG_VALIDATION_PASSED`
  (both `0`; `SIG_VALIDATION_FAILED` both `1`) so the audited bodies read unchanged.
- `using UserOperationLib for PackedUserOperation;` (`:46`).
- `_checkUserOpPermissions(PackedUserOperation calldata, Call[] memory, address)` (`:80`; upstream `:67`).
- **Gas spend limit — the one behavioural change.** Upstream `:116-124` charged
  `(callGasLimit + verificationGasLimit * (paymasterAndData.length > 0 ? 3 : 1) + preVerificationGas) * maxFeePerGas`,
  i.e. EntryPoint v0.6's required prefund. Ported `:127-131` charges `_getMaxGasCost(userOp)`, the **new** helper at
  `:158-177`, which reproduces EntryPoint v0.7 `_getRequiredPrefund` (`lib/account-abstraction/contracts/core/EntryPoint.sol:402-414`):
  `(verificationGasLimit + callGasLimit + paymasterVerificationGasLimit + paymasterPostOpGasLimit + preVerificationGas) * maxFeePerGas`,
  unpacked with `UserOperationLib.unpackVerificationGasLimit / unpackCallGasLimit / unpackMaxFeePerGas /
  unpackPaymasterStaticFields` (never hand-rolled shifts). Paymaster gas limits are `0` when `paymasterAndData` is empty,
  exactly as in `_copyUserOpToMemory`. A non-empty `paymasterAndData` shorter than 52 bytes is rejected by the EntryPoint
  (`AA93`) before validation; if the helper is ever reached with such data the calldata slice reverts (fail-closed).
  Checked arithmetic cannot overflow for EntryPoint-validated ops (`AA94` caps every gas value at uint120).
  Tests: `test_sessionKeyGasLimits_*` (amounts recomputed for v0.7) and `test_sessionKeyGasLimits_paymasterGasIsCharged`
  (paymaster gas counts against the budget — new in v0.7).
- Nonce-key rule (`:123`) unchanged: v0.7 keeps the `key(192) ‖ seq(64)` nonce layout.
- Required-paymaster rule (`:149`) unchanged: `address(bytes20(userOp.paymasterAndData))` is still the paymaster the
  EntryPoint charges (v0.7 layout is `paymaster(20) ‖ verificationGas(16) ‖ postOpGas(16) ‖ data`); comment extended.
- Everything else — `updateKeyPermissions`, `resetSessionKeyGasLimitTimestamp`, `_checkCallPermissions`,
  `_updateLimitsPreExec`, `_checkSpendLimitUsage`, `_checkAndUpdateGasLimitUsage`, `_runtimeUpdateSpendLimitUsage`,
  `_getTokenSpendAmount`, `_performSessionKeyPermissionsUpdate` and all `_set*` / `_update*` helpers,
  `isAllowedERC20Function`, the validation-data packing at `:154-155` — is byte-for-byte upstream.

### D7 — `BufiSessionKeyPlugin.sol` ← `SessionKeyPlugin.sol` (+ `BasePlugin.sol`)
- **Base class:** Circle `BasePlugin` (`@circle/msca/6900/v0.7/plugins/BasePlugin.sol`) replaces Alchemy's. Circle's
  provides the same `isNotInitialized` / `isInitialized` modifiers, the same default-revert virtuals, and `supportsInterface`
  for Circle's `IPlugin`. `NotImplemented(bytes4,uint8)` is a free error from `@circle/msca/6900/shared/common/Errors.sol`
  (same signature as Alchemy's) — `:32`, `:265`.
- **`onInstall`** (`:184`; upstream `_onInstall` `:331` behind `BasePlugin.onInstall` `:68`): Circle's BasePlugin has no
  `_onInstall` indirection, so the audited body is under `onInstall` directly, with Circle's `isNotInitialized(msg.sender)`.
  Alchemy's `BasePlugin.onInstall` also rejected callers with no code (`NotContractCaller`, `BasePlugin.sol:69-71`);
  **dropped** for parity with Circle's BasePlugin and production plugins, none of which carry it: Circle's PluginManager
  runs under delegatecall (so `onInstall` is always called from the account's own context) and Circle's factory installs
  init-time plugins from inside the ERC1967 proxy constructor, where the account has no code yet. A codeless caller can
  only initialise state keyed by its own address. The decode / calldata-slicing assembly / `LengthMismatch` / loop are
  unchanged (`test_install_lengthMismatchReverts`, `test_initialSessionKeysWithPermissions`).
- **`userOpValidationFunction(uint8, PackedUserOperation calldata, bytes32)`** (`:240`): v0.7 struct. Body unchanged except
  OpenZeppelin 5: `toEthSignedMessageHash` comes from `MessageHashUtils` (`:25`, `:71`, `:247`; upstream used
  `using ECDSA for bytes32`, `:184`) and `ECDSA.tryRecover` returns a third `bytes32` error argument that is ignored
  (`:249`; upstream `:186`). Error semantics are identical: malformed signature → `InvalidSignature`; unregistered key →
  `PermissionsCheckFailed`; permission failure → `PermissionsCheckFailed`; wrong signer → `SIG_VALIDATION_FAILED` bit.
- **`pluginManifest`** (`:271`): same layout, expressed with Circle's ERC-6900 v0.7 manifest structs (spec-identical to
  Alchemy's). `dependencyInterfaceIds` reference **Circle's** `type(IPlugin).interfaceId`, so the manifest hash differs
  from Alchemy's. `permitAnyExternalAddress = true`, `canSpendNativeToken = true`, the SELF/DEPENDENCY wiring and the
  `PRE_HOOK_ALWAYS_DENY` pre-runtime hook on `executeWithSessionKey` are unchanged.
- **`pluginMetadata`** (`:354`): `_NAME = "BUFI Session Key Plugin"`, `_AUTHOR = "BUFI (ported from Alchemy Modular
  Account v1.0.1)"` (`:75-77`; upstream `:57-59`). `_VERSION` stays `"1.0.1"`. Permission descriptors unchanged.
- `_isInitialized` (`:383`) overrides Circle's virtual; body unchanged. `supportsInterface` (`:392`) reports
  `IBufiSessionKeyPlugin` (same id as Alchemy's) and defers to Circle's BasePlugin.
- `executeWithSessionKey`, `addSessionKey`, `removeSessionKey`, `rotateSessionKey`, `onUninstall`, `sessionKeysOf`,
  `isSessionKeyOf`, `findPredecessor`: unchanged. `IPluginExecutor.executeFromPluginExternal(address,uint256,bytes)` has the
  same signature on Circle.
- **Storage layout** is identical to upstream (same C3 linearization: `_keyIdCounter` slot 0, `_sessionKeys` slot 1 —
  confirmed with `forge inspect … storage-layout`). All per-account data is ERC-4337 address-associated storage, as before.

### D10 — `permissions/SessionKeyPermissions.sol`: the nonce-lane rule applies to EVERY session key

Upstream gated the "a session key must use its own address as the 192-bit nonce key" requirement behind
`if (sessionKeyData.hasGasLimit)`, because the rule was introduced to protect staked accounts from bundle-level
reputation damage caused by the gas-usage state write. BUFI applies it unconditionally.

**Why (adversarial finding F-01, `reports/ADVERSARIAL_PRE_TENDERLY.md`):** an unmetered key could legitimately sit
in nonce lane 0 — the lane owner user operations use by default. An agent that spends while a quorum-signed
`removeSessionKey` is in flight consumes that nonce, the revocation becomes stale, and the owners must re-collect
k-of-n signatures while the key they are trying to revoke stays live. Requiring the lane for every key gives each
agent its own sequential lane and makes owner operations un-frontrunnable by an agent.

**Effect on the audited semantics:** strictly narrowing. No operation that was rejected becomes accepted; only
operations submitted outside the key's own lane are newly rejected (they had no legitimate reason to be there).
The SDK (`toBufiSessionKeyAccount`) and the recovery lane already pin the lane, so no caller changes.

### D8 — `AssociatedLinkedListSetLib` / `SetValue` / `SENTINEL_VALUE` from `@modular-account-libs`
- erc6900/modular-account-libs `d64adb5` is the extracted MAv1 library: the diff against
  `lib/alchemy-modular-account/src/libraries/AssociatedLinkedListSetLib.sol` is the pragma, the internal constant's name
  (`_ASSOCIATED_STORAGE_PREFIX` → `ASSOCIATED_STORAGE_PREFIX`, same value `0xf938c976`), and `assembly ("memory-safe")` vs
  `/// @solidity memory-safe-assembly`. `Constants.sol` differs only in pragma. Circle's own plugins use this same library
  and address-associated derivation.

### D9 — `CastLib` from `@circle/libs/CastLib.sol`
- `toSetValue(address)` and `toAddressArray(SetValue[])` have the same bodies as Alchemy's `helpers/CastLib.sol`; Circle's
  omits the `FunctionReference` overloads this plugin never used.

---

## Behavioural differences that come from the ACCOUNT, not the plugin

These are observable in tests and worth knowing for the SDK; none required a plugin change.

- **Runtime call to `executeWithSessionKey`** reverts `InvalidValidationFunctionId(0)` from `BaseMSCA
  ._processPreRuntimeHooksAndValidation` (no runtime validation function is set) **before** the plugin's always-deny hook is
  reached; upstream reverted `AlwaysDenyRule`. Denied either way (`test_sessionKey_useSessionKey_failInRuntime`).
- **Runtime calls to the management functions** (`addSessionKey`, …) revert `RuntimeValidationFailed(weighted, 1, NotImplemented(…))`
  for every caller, because dependency slot 0 points at the weighted plugin's unimplemented function id 1. Only the
  multisig userOp path (slot 1 → `USER_OP_VALIDATION_OWNER`) works (`test_runtimePathToManagementIsFailClosed_userOpPathWorks`).
- **Validation data intersection** (`ValidationDataLib._intersectValidationData`): Circle reverts `WrongTimeBounds` when a
  key's `validAfter > validUntil` (upstream's coalescer did not), turns `validAfter >= validUntil` into `authorizer = 1`
  (the EntryPoint then reports `AA24` instead of `AA22`), and re-packs `validUntil == 0` as `0xFFFFFFFFFFFF`. Ops are
  rejected in every such case; only the error code differs.
- **AA23 shape:** EntryPoint v0.7 wraps account-validation reverts as `FailedOpWithRevert(idx, "AA23 reverted", inner)`;
  upstream tests matched `FailedOp(idx, "AA23 reverted (or OOG)")`. Every rejection here is asserted with the exact inner
  error (`PermissionsCheckFailed()`).
- **Cannot be installed at account creation.** Circle's `initializeUpgradableMSCA` installs with an empty dependency
  list; this plugin (like `ColdStorageAddressBookPlugin`) declares two dependency slots, so init-time install reverts
  `InvalidPluginDependency`. Install post-creation through `installPlugin` (`test_cannotBeInstalledAtAccountCreation`).
- **`executeFromPluginExternal` refuses `target == account` and any target that reports Circle's `IPlugin` interface**,
  so a session key cannot reach management functions "from the inside" (upstream refused plugin targets too).

---

## Unchanged invariants (audited semantics preserved)

- Signature: 65-byte ECDSA over `toEthSignedMessageHash(userOpHash)`; wrong signer → `SIG_VALIDATION_FAILED`, all other
  failures revert; the key named in calldata must be registered (`_sessionKeys.contains`).
- Calldata contract: `executeWithSessionKey(Call[] calls, address sessionKey)`; empty `calls` fails validation.
- Access lists (ALLOWLIST default / DENYLIST / ALLOW_ALL_ACCESS) on target + optional selector; ERC-20-limited targets
  additionally restricted to `transfer` / `approve`.
- Native-token limit enforced in validation (with `validAfter = lastUsed + interval` when it only fits the next window)
  and re-checked in execution; ERC-20 limit enforced in execution; gas limit checked **and updated** in validation,
  guarded by the "nonce key == session key" rule and the `gasLimitResetThisBundle` recovery flag.
- Refresh-interval semantics, overflow handling (graceful `SIG_FAIL` in validation, revert in execution), spend-limit
  disable via `type(uint256).max`, required-paymaster rule, time range, key rotation carrying permissions, key ids never
  reused across reinstalls (`_keyIdCounter` not reset in `onUninstall`).
- Storage: `PluginStorageLib` address-associated keys with the same prefixes and widths; `AssociatedLinkedListSet` for
  the key set; identical slot assignment.
- Manifest: 5 execution functions, `executeWithSessionKey` validated by SELF id 0, four management functions validated
  by dependency slot 1 (userOp) / slot 0 (runtime), always-deny pre-runtime hook, `permitAnyExternalAddress`,
  `canSpendNativeToken`.

---

## Upstream behaviours kept verbatim that BUFI should design around

- **ERC-20 budgets are execution-phase.** Validation only checks target/selector; the amount is enforced in
  `_updateLimitsPreExec`. A bundler will include an over-budget op and it reverts on-chain (the account still pays gas).
  A native limit, by contrast, rejects in validation. (`test_erc20OverLimit_revertsInExecution`,
  `test_nativeOverLimit_rejectedInValidation`.)
- **Reconfiguring a limit does not clear `limitUsed`.** `_updateSpendLimits` only clears it when disabling
  (`type(uint256).max`); a new limit + interval restarts the window with the old usage carried over. The
  `ISessionKeyPermissionsUpdates` NatSpec ("existing interval spend data will be cleared") overstates this.
  (`test_owner_shrinks_budget_mid_grant`.)
- **ERC-20 recipient is invisible to the access list** — see Composition findings.
- **`resetSessionKeyGasLimitTimestamp` is callable by anyone** (by design, documented upstream).
- **Gas-limited keys must use their address as the 192-bit nonce key**; the harness does so for every session-key op.

---

## Test map

| Upstream test file | Ported into |
| --- | --- |
| `test/plugin/session/SessionKeyPluginWithMultiOwner.t.sol` | `BufiSessionKeyPlugin.t.sol` "Key management" |
| `…/permissions/SessionKeyPermissions.t.sol` | `BufiSessionKeyPlugin.t.sol` "Permissions" (+ live paymaster flow) |
| `…/permissions/SessionKeyERC20SpendLimits.t.sol` | `BufiSessionKeyPlugin.t.sol` "ERC-20 spend limits" |
| `…/permissions/SessionKeyNativeTokenSpendLimits.t.sol` | `BufiSessionKeyPlugin.t.sol` "Native token spend limits" |
| `…/permissions/SessionKeyGasLimits.t.sol` | `BufiSessionKeyPlugin.t.sol` "Gas spend limits" (v0.7 amounts, + paymaster gas) |
| — | `SessionKeyOnCircleMsca.t.sol` (install, manifest, ABI equality, lifecycle, confinement, isolation) |
| — | `SessionKeyWithAddressBook.t.sol` (composition findings) |
| — | `AgenticWalletPolicy.t.sol` (grant / escalate / revoke scenarios) |

Systematic translations: every `vm.prank(owner)` upstream is a multisig-signed userOp here; `FailedOp(…, "AA23 reverted
(or OOG)")` is `FailedOpWithRevert(…, "AA23 reverted", PermissionsCheckFailed())`; `vm.expectCall` counts are balance
assertions.

```
cd contracts && FOUNDRY_OUT=out-session FOUNDRY_CACHE_PATH=cache-session forge test --match-path 'test/bufi/v0.7/session/**' -vv
```
