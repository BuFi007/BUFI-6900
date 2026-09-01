# BufiEarnModule on Circle's real ERC-6900 v0.7 account — notes

Findings from `contracts/test/bufi/v0.7/earn/BufiEarnModuleOnMsca.t.sol`, which installs
the plugin on Circle's canonical `UpgradableMSCA` (canonical bytecode and addresses, weighted
2-of-3 multisig, userOps through EntryPoint v0.7) instead of the `MockMsca` the unit suite
uses. Everything below is proved by a passing test; the test name is given each time.

## What the manifest actually declares

| Field | Value | Consequence |
| --- | --- | --- |
| `executionFunctions` | `[autoEarn, changeConfigHash]` | Both are routed through the account's fallback; the plugin sees `msg.sender == account`. |
| `dependencyInterfaceIds` | `[IPlugin, IPlugin]` | Install with exactly TWO `FunctionReference`s. On a weighted account: `[FunctionReference(weighted, 1), FunctionReference(weighted, 0)]` — the same pair `ColdStorageAddressBookPlugin` takes (`_addressBookDependencies()` in the harness). Empty, short, or pointing at a plugin not installed on the account → `InvalidPluginDependency`. |
| `runtimeValidationFunctions` | `autoEarn -> SELF id 0`; `changeConfigHash -> DEPENDENCY slot 0` | Relayer / module-owner check for `autoEarn` runs inside the account before the plugin is called. `changeConfigHash` at runtime resolves to Weighted id 1, which is unimplemented: fail-closed for every runtime caller, owners included. |
| `userOpValidationFunctions` | `changeConfigHash -> DEPENDENCY slot 1` | Only `changeConfigHash` has a userOp path, validated by the Weighted owner set (threshold). `autoEarn` cannot be reached by a userOp even fully signed by the quorum (`InvalidValidationFunctionId` at the EntryPoint). |
| `permitAnyExternalAddress` | `true` | Vault targets are config-driven, so the plugin may call any external address via `executeFromPluginExternal`. |
| `canSpendNativeToken` | `false` | |
| `interfaceIds`, hooks, `permittedExecutionSelectors`, `permittedExternalCalls` | all empty | The plugin adds nothing to the account's ERC-165 surface and installs no hooks anywhere. |

`test_manifest_declaresTwoExecutionFunctionsAndTwoOwnerDependencySlots`,
`test_install_throughMultisigUserOp_withOwnerDependencies_bindsBothFunctions`,
`test_install_rejectsAnEmptyOrShortDependencyArray`,
`test_install_rejectsADependencyPluginThatIsNotInstalledOnTheAccount`,
`test_autoEarn_isNotReachableThroughAUserOp_evenWithQuorum`.

Install data is `abi.encode(uint256 configHash)`; a zero hash surfaces as
`FailToCallOnInstall(plugin, InvalidConfigHash())` in the userOp's execution phase
(`test_install_rejectsZeroConfigHash_surfacedAsFailToCallOnInstall`). Because the plugin
records two dependencies on the Weighted plugin, the Weighted plugin cannot be uninstalled
while the earn plugin is installed (`PluginUsedByOthers`) — the normal ERC-6900 rule.

## `changeConfigHash`: was unreachable in the 2026-08-02 build; fixed here

The port originally kept FluidKey's shape — the account calls `changeConfigHash(newHash)`
on the module with `msg.sender == account` — and the selector was not in the manifest. That
door exists on a Safe (`execTransactionFromModule` and friends) and on `MockMsca.callPlugin`,
but not on Circle's account: `execute` and `executeBatch` revert
`StandardExecutor.TargetIsPlugin` for any target whose ERC-165 reports `IPlugin`; a userOp
with that calldata had no validation function; a runtime call hit an empty runtime slot; and
`executeFromPlugin*` is for plugins calling out, not the account calling a plugin. The
adopted hash could not change at all; the only way to switch vaults was uninstall +
reinstall.

Fixed (see "Deviation (BUFI-6900)" in the contract natspec): `changeConfigHash` is now an
execution function routed through the account, with exactly the owner-gated shape
`ColdStorageAddressBookPlugin` uses for `addAllowedRecipients`: userOp validation from
dependency slot 1 (Weighted owner validation, id 0), runtime validation from dependency
slot 0 (Weighted id 1, unimplemented → fail-closed). `test_quorumAdoptsNewConfigHash_viaUserOp`
proves the whole surface on the real account:

- a threshold-signed userOp `changeConfigHash(newHash)` on the ACCOUNT succeeds, emits
  `ConfigHashChanged(account, old, new)`, and the relayer's next deposit lands in vault B;
- a single owner below threshold is rejected at the EntryPoint;
- runtime calls from an owner EOA, the relayer, or a stranger all revert
  `RuntimeValidationFailed(weighted, 1, NotImplemented(runtimeValidationFunction.selector, 1))`;
- `execute(plugin, 0, changeConfigHash(...))` is still refused (`TargetIsPlugin`) — the
  routed function is the one door;
- a zero hash reverts `InvalidConfigHash` in the execution phase
  (`test_changeConfigHash_viaUserOp_rejectsAZeroHash`).

Uninstall + reinstall with the new hash remains a valid alternative
(`test_adoptingANewConfig_alsoWorksAsUninstallThenReinstallWithTheNewHash`). The unit
suite's `MockMsca` now enforces the two-slot dependency count and models a
DEPENDENCY-backed runtime slot as fail-closed; its `callPlugin` stands in for the
owner-validated userOp path.

## Composition findings

**ColdStorageAddressBookPlugin does not gate the earn deposit.** A vault that is NOT on the
allowlist still receives the plugin-initiated deposit, while the multisig itself could not
have moved a single unit to that vault.

Mechanism, exactly:

1. AddressBook's manifest registers `preUserOpValidationHooks` and
   `preRuntimeValidationHooks` on two selectors only: `IStandardExecutor.execute` and
   `IStandardExecutor.executeBatch`. It registers no execution hooks and nothing on any
   other selector.
2. `BufiEarnModule.autoEarn` moves funds by calling
   `IPluginExecutor(account).executeFromPluginExternal(token, 0, approve(vault, amt))` and
   then `executeFromPluginExternal(vault, 0, deposit(amt, account))`.
3. `BaseMSCA.executeFromPluginExternal` has no `validateNativeFunction` modifier. It goes
   straight into `PluginExecutor.executeFromPluginToExternal`, which checks only
   (a) target is not the account or a plugin, (b) native-token permission, (c) the calling
   plugin's `anyExternalAddressPermitted` / per-target permission, and then runs the
   execution hooks registered on `executeFromPluginExternal.selector` — of which there are
   none. `permitAnyExternalAddress = true` satisfies (c) for every vault.
4. The account's loupe confirms it: `getPreValidationHooks(execute)` returns one AddressBook
   hook each for userOp and runtime; `getPreValidationHooks(executeFromPluginExternal)` and
   `getExecutionHooks(executeFromPluginExternal)` return nothing.

Proof (`test_addressBook_doesNotGateThePluginInitiatedDeposit_vaultOutsideAllowlistStillReceives`,
`test_addressBook_installedFirst_stillDoesNotGateTheDeposit`): with the allowlist set to a
single unrelated payee, the quorum's `execute(usdc, 0, transfer(vault, ...))`,
`execute(usdc, 0, approve(vault, ...))` and `execute(vault, 0, deposit(...))` are all rejected
at validation (the last because AddressBook cannot decode a recipient from
`deposit(uint256,address)` and fails closed), yet the relayer's `autoEarn` deposits 100,000
USDC into that same vault and the allowlist is untouched. Install order does not matter.

The same holds for `changeConfigHash`: it is not `execute`, so the address book never sees
it, and the quorum can re-point deposits at a vault the allowlist does not mention
(`test_addressBook_doesNotGateChangeConfigHash`).

What mitigates it — content-addressed config adoption by the multisig:

- The plugin can only ever call `approve` on a token and `deposit` on a vault, and the vault
  is looked up as `config[accountConfig[account]][chainid][token]`.
- `accountConfig[account]` is written by exactly two paths, both threshold-signed multisig
  userOps: `installPlugin` (via `onInstall`) and the routed `changeConfigHash`. No relayer,
  module owner, single owner, or runtime caller can write it. The module owner
  re-registering a different vault produces a DIFFERENT hash; the account's adopted hash
  still resolves to the old vault
  (`test_ownerReregisteringADifferentVault_yieldsANewHash_theAccountKeepsItsAdoptedOne`).
- Vault shares always mint to the account (`deposit(amt, account)`); redemption remains a
  multisig `execute`, which AddressBook DOES gate.

So the effective allowlist for earn deposits is the set of vaults inside the config hash the
multisig adopted, not the AddressBook allowlist. Anyone reasoning about "what can leave this
treasury" must read both. A compromised relayer can still choose the timing and the amount of
a deposit into an adopted vault; it cannot choose the destination.

Related: the AddressBook's fail-closed decoding also means a treasury WITH AddressBook can
never deposit into a vault by hand through `execute` — the plugin path is the only deposit
path such an account has.

## Other behaviours pinned

- Relayer runtime path: the account's fallback runs `runtimeValidationFunction(0, sender, ...)`
  and a stranger gets `RuntimeValidationFailed(plugin, 0, NotAuthorized(sender))`; a removed
  relayer is rejected the same way; the module owner may call
  (`test_unauthorizedCaller_isRejectedByTheAccountsRuntimeValidation`,
  `test_removedRelayer_isRejected_andANewRelayerIsAccepted`, `test_moduleOwner_canAlsoTriggerAutoEarn`).
- `ConfigNotFound(token)` bubbles unchanged for a token outside the adopted set.
- Approval is exactly consumed by the deposit (allowance returns to 0).
- `executeFromPluginExternal` refuses any caller that is not an installed plugin, including a
  second, uninstalled deployment of the same module
  (`ExecFromPluginToSelectorNotPermitted`).
- Uninstall through a multisig userOp removes the plugin from `getInstalledPlugins`, unbinds
  both selectors and releases the owner validation slots (a relayer `autoEarn` now fails with
  `InvalidValidationFunctionId(0)`; a `changeConfigHash` userOp is rejected at validation),
  clears the adopted hash, and leaves the account able to reinstall. Install and uninstall
  both require the quorum; a single owner is rejected at validation.
