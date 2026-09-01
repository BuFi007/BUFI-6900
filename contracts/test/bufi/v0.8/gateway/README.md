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
