# Gateway module — local (fork-free) suites

`GatewayExecutionModuleLocal.t.sol` and `GatewayHelperLocal.t.sol` reproduce the behavioural
assertions of the Sepolia fork suites in `test/fork/gateway/` against
`test/mocks/MockGatewayWallet.sol`, and add the deposit / withdrawal paths the fork suites
skipped for lack of testnet USDC. They run in the default profile:

```bash
cd contracts && forge test --match-path 'test/bufi/v0.8/gateway/**' -vv
```

What the mock is faithful to, and what it models, is spelled out in its natspec. Short
version: the fork suites verified the ABI (`addDelegate(address,address)`,
`removeDelegate`, `isAuthorizedForBalance(address,address,address)`, `deposit`,
`totalBalance`, `availableBalance`, `withdrawalDelay`) and that delegation is keyed by
`msg.sender`; deposit accounting, self-authorization, and the two-step block-delayed
withdrawal are modelled from Circle's published Gateway semantics and were never exercised
on Sepolia.

## Findings these suites pin down

1. **`msg.sender` is the depositor.** Through the module, every Gateway effect lands on the
   MODULE address: delegations (`test_authorizeDelegate_isAttributedToTheModule_notTheCallingAccount`),
   deposits, and withdrawals. Through helper-encoded calldata executed by the account
   itself, they land on the account (`test_DirectExecution_PreservesMsgSender`, and
   `GatewayHelperOnCircleMscaTest` drives it through a real Circle v0.7 MSCA with
   multisig-signed userOps).
2. **`depositToGateway` deposits the module's own tokens.** It calls
   `safeIncreaseAllowance` and `deposit` from the module, so an account that holds the
   USDC and approved Gateway gets `ERC20InsufficientBalance(module, 0, amount)`; a module
   that does hold USDC deposits it under the module's name. The fork test
   `test_DepositToGateway` would have failed had USDC been available
   (`test_depositToGateway_pullsFromTheModule_notTheCallingAccount`).
3. **`completeWithdrawal` pays the module and mis-reports the amount.** Gateway pays
   `msg.sender` (the module); the emitted `WithdrawalCompleted` reads
   `withdrawableBalance(token, msg.sender)` for the CALLER, so it reports `0` for a
   withdrawal that moved the full amount
   (`test_withdrawal_throughTheModule_actsOnTheModulesBalanceAndPaysTheModule`).
4. **One module = one Gateway depositor for every installing account.** Any account that
   installed the module can revoke a delegate another account authorized
   (`test_twoAccountsSharingOneModule_shareOneDelegateSet`).
5. **ERC-165 surface.** The module advertises `IERC6900Module` (identical interface id to
   Circle's v0.8 `IModule`, which Circle's `BaseMSCA._installExecution` checks when install
   data is non-empty) and `IGatewayExecutionModule`, but NOT `IERC6900ExecutionModule`.
   Neither Circle's v0.8 account nor the ERC-6900 v0.8.1 reference checks for the latter,
   so installs succeed; do not add such a check.
6. **ColdStorageAddressBookPlugin fails closed on every Gateway-targeted call.** With
   Gateway on the allowlist, `approve(gateway, amt)` executes, but `addDelegate`,
   `deposit`, `initiateWithdrawal` and `withdraw` are all rejected at validation because
   the address book cannot decode a recipient from those selectors. An AddressBook-gated
   treasury cannot use Gateway through `execute` at all
   (`test_addressBook_failsClosedOnEveryGatewayTargetedCall`).
7. **Interface comment vs. getter.** `IGatewayWallet.withdrawalDelay()` is documented as
   seconds, while `withdrawalBlock()` returns a block number. The mock follows the getter
   (delay in blocks). Confirm on Sepolia before relying on either.

## v0.8 account harness

`GatewayModuleOnCircleV08.t.sol` runs the module on a REAL Circle ERC-6900 v0.8 account
(`UpgradableMSCA`, `circle.msca.2.0.0`) through owner-signed userOps on EntryPoint v0.7, on top
of `test/harness/CircleV08Harness.sol`. The harness deploys the v0.8 stack with plain `new`
(there is no canonical v0.8 deployment to recreate: Circle's own README says the contracts are
"not deployed on any mainnets yet"), creates single-signer and weighted-multisig accounts via
`createAccountWithValidation`, installs further validation entities and hooks, and signs in
Circle's v0.8 envelope `[ModuleEntity][flag][…][0xff][sig]`. Always run it in its own build
directory so it never contends with the default profile:

```bash
cd contracts && FOUNDRY_OUT=out-v08 FOUNDRY_CACHE_PATH=cache-v08 \
  forge test --match-path 'test/bufi/v0.8/**' -vv
```

### v0.8.0 (Circle) vs v0.8.1 (module): ABI-identical, nominally different

Circle's account is typed against `@erc6900/reference-implementation` v0.8.0 (`IModule`,
`IExecutionModule`, `IModularAccount`); the module against v0.8.1 (`IERC6900Module`,
`IERC6900ExecutionModule`, `IERC6900Account`). The rename is the entire difference — no function
signature and no `ExecutionManifest` field changed — so `test_compat_*` pins:

- `type(IERC6900Module).interfaceId == type(IModule).interfaceId`, and the same for the
  execution-module pair;
- identical selectors for `installExecution`, `uninstallExecution`, `installValidation`,
  `uninstallValidation`, `execute`, `executeBatch`;
- `abi.encode(manifestV081) == abi.encode(manifestV080)`, and byte-identical `installExecution`
  calldata whichever version encodes it.

Solidity still treats the two `ExecutionManifest` structs as distinct nominal types, so the only
"cast" a test needs is a re-encode:
`abi.decode(abi.encode(module.executionManifest()), (ExecutionManifest))` (`_circleManifest`).
No shim, no incompatibility, nothing to change in the module.

### Module vs account as Gateway depositor, on a real account

8. **Through the account, Gateway still sees the module.** The account's fallback forwards a
   manifest selector with `msg.sender == account` (the module's `DelegateAuthorized(account, …)`
   event proves it); the module then calls Gateway with `msg.sender == module`, and that is the
   key Gateway stores under. `authorizeDelegate` lands on the module's position;
   `depositToGateway` reverts `ERC20InsufficientBalance(module, 0, amount)` while the account
   holds and has approved the USDC; once the module itself holds USDC the deposit and the
   eventual `withdraw` credit and pay the module. The account that signed every userOp never
   touches its own Gateway position. The sound pattern (`execute` + `GatewayHelper` calldata) keys
   everything by the account — shown on a single-signer and on a 2-of-3 weighted account, with
   the module installed alongside, so the two Gateway positions are visibly unrelated keys.
9. **`allowGlobalValidation: false` is a real gate on v0.8.** `authorizeDelegate`,
   `depositToGateway` and `initiateWithdrawal` are refused with `InvalidValidationFunction` under
   the owner's global flag, and under the per-selector flag until the owner validation is
   re-installed listing those selectors (`_grantSelectorsToOwner`). Selectors are append-only:
   they survive `uninstallExecution`, after which the call passes validation and dies in
   execution with `InvalidExecutionFunction`.
10. **Empty install data skips Circle's ERC-165 gate entirely.** `_onInstall` only runs — and only
    checks `IModule` — when install data is non-empty. With data, the module passes because
    `IERC6900Module == IModule`; a contract with no ERC-165 (the helper) is refused
    `InterfaceNotSupported`. The account never advertises `IModule`; it advertises
    `IGatewayExecutionModule` from `manifest.interfaceIds` and drops it on uninstall. Gateway
    delegations made through the module outlive the uninstall, as `onUninstall` warns.

### Circle's v0.8 ColdStorageAddressBookModule (WIP, undeployed)

11. **It is a validation hook, not a per-selector hook.** In v0.7 the plugin hooked `execute` and
    `executeBatch` through its manifest; in v0.8 it attaches to ONE validation function
    (`installValidation(..., hooks)`) and runs on every userOp that validation admits, decoding
    the calldata as `execute(target, value, data)` (entity 0) or `executeBatch` (entity 1). On a
    dedicated cold validation (a second `SingleSignerValidationModule` entity, per-selector for
    `execute`) it behaves like finding #6: `approve(gateway, …)` passes, every Gateway-targeted
    selector fails closed with `UnauthorizedRecipient(account, 0)`, and the ungated global owner
    validation walks straight past it — the hook gates only the validation it hangs off. Attached
    to the account's ONLY global validation it bricks administration: `revokeDelegate`,
    `uninstallExecution`, `installValidation` and `uninstallValidation` itself all die in the hook
    (`uninstallExecution(module, …)` decodes as "send 96 wei to the module" and fails
    `UnauthorizedRecipient(account, module)`).
12. **It cannot be seeded through hook install data.** `_installValidation` ERC-165-checks a hook
    module for `IValidationHookModule` whenever hook data is non-empty, and Circle's module only
    advertises `IAddressBookModule` + `IModule` (its `TestAddressBookModule` advertises
    `IValidationHookModule`, which is why Circle's own hook test passes). Seed the allowlist via
    `installExecution(addressBook, manifest, abi.encode(recipients))` and attach the hook with
    empty data.
13. **`addAllowedRecipients` skips runtime validation — anyone can extend an account's
    allowlist.** The manifest marks it `skipRuntimeValidation: true` (next to a
    `// TODO: allow global validation`), so the fallback forwards it with no validation of any
    kind and the module records recipients under `msg.sender == account`. A stranger allowlists
    itself in one call; `removeAllowedRecipients` is validated normally. Do not install this
    manifest on a treasury as-is.
