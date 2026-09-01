# BufiEarnModule on Circle's real ERC-6900 v0.7 account — notes

Findings from `contracts/test/bufi/v0.7/earn/BufiEarnModuleOnMsca.t.sol`, which installs
the plugin on Circle's canonical `UpgradableMSCA` (canonical bytecode and addresses, weighted
2-of-3 multisig, userOps through EntryPoint v0.7) instead of the `MockMsca` the unit suite
uses. Everything below is proved by a passing test; the test name is given each time.

## What the manifest actually declares

| Field | Value | Consequence |
| --- | --- | --- |
| `executionFunctions` | `[autoEarn]` only | `changeConfigHash` is NOT routed through the account (see below). |
| `runtimeValidationFunctions` | `autoEarn -> SELF, id 0` | The relayer / module-owner check runs inside the account's fallback before the plugin is called. |
| `userOpValidationFunctions` | none | `autoEarn` cannot be reached by a userOp, even fully signed by the quorum. The EntryPoint rejects it at validation (`InvalidValidationFunctionId`). |
| `dependencyInterfaceIds` | none | Install with an EMPTY `dependencies` array. Passing the AddressBook-style owner slots reverts `InvalidPluginDependency`. |
| `permitAnyExternalAddress` | `true` | Vault targets are config-driven, so the plugin may call any external address via `executeFromPluginExternal`. |
| `canSpendNativeToken` | `false` | |
| `interfaceIds`, hooks, `permittedExecutionSelectors`, `permittedExternalCalls` | all empty | The plugin adds nothing to the account's ERC-165 surface and installs no hooks anywhere. |

`test_manifest_declaresOneRuntimeOnlyExecutionFunctionAndNoDependencies`,
`test_install_rejectsDependenciesTheManifestDoesNotDeclare`,
`test_autoEarn_isNotReachableThroughAUserOp_evenWithQuorum`.

Install data is `abi.encode(uint256 configHash)`; a zero hash surfaces as
`FailToCallOnInstall(plugin, InvalidConfigHash())` in the userOp's execution phase
(`test_install_rejectsZeroConfigHash_surfacedAsFailToCallOnInstall`).

## `changeConfigHash` is unreachable on a real account

The plugin expects the account to call `changeConfigHash(newHash)` on the plugin with
`msg.sender == account`. `MockMsca.callPlugin` provides exactly that door. Circle's account
has none:

- `execute(plugin, 0, changeConfigHash(...))` and `executeBatch` revert
  `StandardExecutor.TargetIsPlugin(plugin)` — the executor refuses any target whose
  ERC-165 `supportsInterface(IPlugin)` is true, which the plugin's is.
- A userOp whose calldata is `changeConfigHash(...)` has no userOp validation function
  (it is not an execution function) and is rejected at the EntryPoint.
- A runtime call to the account with that selector hits an empty runtime validation slot
  (`InvalidValidationFunctionId(0)`).
- `executeFromPlugin` / `executeFromPluginExternal` are for plugins calling out, not for the
  account calling a plugin, and the latter refuses plugin targets too.

`test_changeConfigHash_isUnreachableOnARealMsca` exercises every path; the adopted hash never
changes. **On a Circle MSCA, adopting a new config set is `uninstallPlugin` followed by
`installPlugin` with the new hash — two multisig userOps**
(`test_adoptingANewConfig_isUninstallThenReinstallWithTheNewHash`). `changeConfigHash` is
dead code for this account type; the unit test `test_accountCanChangeConfigHash` passes only
because of the mock.

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

What mitigates it — content-addressed config adoption by the multisig:

- The plugin can only ever call `approve` on a token and `deposit` on a vault, and the vault
  is looked up as `config[accountConfig[account]][chainid][token]`.
- `accountConfig[account]` is set exactly once, at install, from the multisig's own
  `installPlugin` userOp, and cannot be changed by anyone afterwards (see previous section).
  The module owner re-registering a different vault produces a DIFFERENT hash; the account's
  adopted hash still resolves to the old vault
  (`test_ownerReregisteringADifferentVault_yieldsANewHash_theAccountKeepsItsAdoptedOne`).
- Vault shares always mint to the account (`deposit(amt, account)`); redemption remains a
  multisig `execute`, which AddressBook DOES gate.

So the effective allowlist for earn deposits is the set of vaults inside the config hash the
multisig installed, not the AddressBook allowlist. Anyone reasoning about "what can leave this
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
  `autoEarn` (a relayer call now fails with `InvalidValidationFunctionId(0)`), clears the
  adopted hash, and leaves the account able to reinstall. Install and uninstall both require
  the quorum; a single owner is rejected at validation.
