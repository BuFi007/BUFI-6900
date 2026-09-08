# Spending from yield — how FluidKey does it, and what BUFI needs

## 1. FluidKey's earn module does not withdraw. At all.

Checked against `fluidkey/fluidkey-earn-module` @ `122cde1`, `src/FluidkeyEarnModule.sol` (483 lines).

- `grep -n "withdraw\|redeem"` over the whole file: **zero hits.** The only `deposit` calls are
  `IWrappedNative.deposit` (native wrapping) and `IERC4626.deposit`.
- The module's entire value-moving surface is three hardcoded `execTransactionFromModule` calls in `_autoEarn`
  (`:445` wrap native, `:460` `IERC20.approve(vault, amt)`, `:471` `IERC4626.deposit(amt, safe)`). There is no
  path that constructs any other calldata.
- FluidKey's own docs state the same guarantee: *"the scope of the module is extremely limited, such that
  Fluidkey cannot move funds anywhere else than the pools listed above."*
- Ackee's audit (March 2025, revisions 1.0 / 1.1) scoped exactly `src/FluidkeyEarnModule.sol`. 9 findings —
  1 High (H1 cross-chain replay), 1 Medium (M1 `MAX_TOKENS` bypass via `setConfig`), 3 Warning, 4 Info, all
  fixed. Nothing about withdrawal, because there is no withdrawal to audit.

So `BufiEarnModule` being deposit-only is **inherited, not an omission in the port**. The upstream is deposit-only
by design.

## 2. Where FluidKey's "automatic" withdrawal actually happens

The docs promise: *"when you want to send USDC on Base, you can just send USDC from your balance as usual and
funds will be automatically taken from the lending pool in the same transaction."*

That is not module code. FluidKey's Safes are user-controlled; the withdrawal is bundled into the **user-signed
Safe transaction** that the FluidKey app constructs — redeem from the vault and transfer, in one transaction.

**Not verified:** I have not found published source for that transaction builder. The repo above is the module
only, and the docs describe the behaviour without the mechanism. What IS established is the negative: the
audited module cannot do it, so it happens in the layer that builds and signs the transaction.

This is exactly the status quo ERC-8187's own post describes and criticises — *"Smart accounts can bundle
several operations (de-invest and spend in one transaction), but there's no standardized way to source funds
through a predefined strategy."* FluidKey is on the bundling side of that sentence.

## 3. BUFI already has the bundling primitive. No new Solidity needed.

`executeWithSessionKey(Call[] calls, address sessionKey)` takes an **array**. The FluidKey-equivalent agent op is:

```
executeWithSessionKey([
  { target: vault, value: 0, data: IERC4626.withdraw(shortfall, account, account) },
  { target: usdc,  value: 0, data: IERC20.transfer(payee, amount) }
], sessionKey)
```

One userOp, atomic, all existing policy applies. Every gate it must clear, and why it clears:

| Gate | Call 1 (`vault.withdraw`) | Call 2 (`usdc.transfer`) |
| --- | --- | --- |
| `PluginExecutor.sol:80` (no self, no plugin target) | vault is an external non-plugin contract → passes | passes |
| Session-key access list (target + selector) | needs `vault` + `withdraw` granted | already granted |
| Recipient hook | not a decodable token transfer → **the target itself must be on the AddressBook**, so the vault must be listed (`BufiSessionRecipientHookPlugin.sol:306`) | decodable → payee must be on the AddressBook, as today |
| ERC-20 spend budget | see the config rule below | counted as today |
| Share approval | none needed: `msg.sender` at the vault is the account and `owner == account` | — |

Setup, one time, both owner-quorum ops you already have SDK paths for:

1. `addAllowedRecipients([vault])` on the AddressBook.
2. Grant the session key `vault` + `IERC4626.withdraw` in its access list.

**Config rule — do not flag the vault as an ERC-20 spend-limited contract in the key's access list.**
`isAllowedERC20Function` is `transfer || approve` only (`SessionKeyPermissions.sol:642`, byte-for-byte upstream),
so a vault registered with `isERC20WithSpendLimit` rejects `withdraw` at `:217`. Register it as a plain permitted
contract. Vault shares are ERC-20, so this is an easy mistake to make in a grant preset.

**Where the shortfall math goes: the SDK, not a contract.** `packages/modular-wallets-core/src/cascade/` already
builds agent calls (`buildAgentFaceCalls.ts`, `agentGrantPresets.ts`). Reading `balanceOf` and prepending a
withdraw `Call` when it is short is TypeScript against the same account — the same layer FluidKey does it in, and
zero new unaudited Solidity on a treasury.

## 4. Option B: an on-chain pre-execution hook

Worth building only if the agent runtime cannot be trusted to construct the withdraw call — a third-party agent,
or an op path where BUFI does not build the calldata. It buys automation and costs a new unaudited plugin.

Shape, if it is built: a `preExecutionHook` on `executeWithSessionKey` (**not** a validation hook — a withdrawal
writes state and calls out, both banned in `validateUserOp` under ERC-4337/7562). Circle runs pre-exec hooks
before the execution function on both paths (`BaseMSCA.sol:161`). It decodes the `Call[]`, sums what the account
is about to pay per token, and sources the shortfall via
`executeFromPluginExternal(vault, 0, IERC4626.withdraw(...))` — targeting the vault directly, never the earn
module, for the same `PluginExecutor.sol:80` reason. Vault resolution is free: `BufiEarnModule.accountConfig` and
`.config` are **public**, so the hook reads `config(accountConfig(account), block.chainid, token)` and inherits
the multisig-adopted config hash as its trust anchor — no second adoption surface.

Guards it would need, mirroring F-06 in `autoEarn`: `vault.asset() == token`, and a before/after balance delta
equal to the shortfall. **Not** a `maxWithdraw` preflight — see the Vault V2 finding below; that guard would
reject every withdrawal from the vault this stack actually uses.

Known costs and open questions if you go this way:

1. The hook fires **before** the ERC-20 budget check (`_updateLimitsPreExec`, `BufiSessionKeyPlugin.sol:96`), so
   an over-budget op de-invests, then reverts. Funds are not lost — they sit in the account until the next
   `autoEarn` — but the gas is spent and the position leaves yield.
2. Circle's v0.7 account has no re-entrancy lock (none in `BaseMSCA` or `PluginExecutor`). A malicious vault
   re-entering `executeWithSessionKey` must pass that selector's runtime validation, which requires `msg.sender`
   to be a registered session key; a vault is not. That is the argument for skipping a storage guard, and it is
   the first thing to attack in review.
3. Gas: ~4–6k when liquidity is already sufficient, ~90–140k when it fires. The recipient hook is +18.4k for
   comparison.

## 5. Correction to the first draft of this document

The first draft recommended Option B as the answer and did not check upstream. Two things were wrong:

- It implied the missing withdraw leg was a gap BUFI should close in Solidity. FluidKey — the audited origin of
  this module — closes it in the transaction builder, and BUFI's `Call[]` already supports the same shape.
- It did not check whether the recipient hook admits a non-transfer call. It does, by the deliberate divergence
  at `BufiSessionRecipientHookPlugin.sol:306`: an undecodable zero-value call is judged by its **target**. That
  divergence, written for the ERC-8183 rails, is what makes the no-new-code path work.

## 6. Proven, not planned

`contracts/test/bufi/v0.7/session/SpendFromVault.t.sol` — 4 tests, on the canonical Circle stack (production
bytecode at production addresses, weighted 2-of-3, userOps through EntryPoint v0.7), with
AddressBook + `BufiSessionKeyPlugin` + `BufiSessionRecipientHookPlugin` composed on one account.

| Test | Pins |
| --- | --- |
| `test_agentSpendsFromVault_withZeroLiquidUsdc` | account holds **0 liquid USDC** and 1000 in the vault; one agent op `[vault.withdraw(250), usdc.transfer(payee, 250)]` pays the payee, leaves 0 idle, and the remaining 750 keeps earning |
| `test_bareTransfer_failsWithoutTheWithdrawLeg` | the bundle is required — the same key and budget, single transfer call, reverts in execution and moves nothing |
| `test_vaultMustBeOnTheAddressBook` | an account whose AddressBook omits the vault is rejected at **validation** with `UnauthorizedRecipient(account, vault)`; the whole path rests on the divergence at `BufiSessionRecipientHookPlugin.sol:306` |
| `test_vaultAsErc20SpendLimited_rejectsWithdraw` | the grant-time trap: `_permErc20Limit(vault, …)` bricks the withdraw leg at validation (`SessionKeyPermissions.sol:217`) |

No production Solidity changed. Full default profile after adding the file: **292 passed, 0 failed** (288 before).

### The SDK half

`packages/modular-wallets-core/src/cascade/buildSpendFromYieldCalls.ts` — the builder that turns a list of
payments into that call array. Pure: it takes the account's liquid balances (`readContract(erc20Abi, 'balanceOf')`)
and its adopted `(token, vault)` pairs (`getEarnConfigs`, which already existed) and returns
`{ withdrawals, transfers, calls, sourced }`. `calls` goes straight to `encodeExecuteWithSessionKey`.

Rules it enforces, one test each — 14 tests in
`src/__tests__/cascade/buildSpendFromYieldCalls.test.ts`:

- sources the shortfall only, never the whole payment, and nothing at all when the balance already covers it;
- several payments of one token aggregate into **one** withdrawal;
- each token is sourced from its own vault, in first-appearance order, and every withdrawal precedes every
  transfer;
- token addresses match case-insensitively (viem hands back checksummed addresses);
- **fails closed** when a short token has no adopted vault, rather than emitting a transfer that reverts on-chain;
- a token that is already liquid needs no vault at all;
- the emitted selectors are pinned to `0xb460af94` / `0xa9059cbb`, cross-checking the SDK against the Solidity
  proof above.

SDK suite after this: **475 passed, 0 failed** (461 before). `tsc --noEmit` clean.

### The grant preset

`spendFromYieldGrant` in `src/cascade/agentGrantPresets.ts`, role `spend-from-yield` in `AGENT_ROLE_PRESETS`.
It scopes the token to `transfer` and each vault to `withdraw` (plus `redeem` behind `includeRedeem`), and puts
the ERC-20 budget on the **token only**. The trap is closed by construction, not by convention: the vault is
never a budgeted token, and the preset throws if a caller passes the budgeted token as a vault.

The budget still bounds the agent exactly as before — sourcing more from the vault does not raise the ceiling;
an over-budget transfer is rejected whatever the balance is.

6 tests, including one that compiles the grant through `buildBufiGrant` and asserts the vault appears in exactly
two updates (an access-list address entry and a function entry) and in no spend-limit update at all.

SDK suite after the preset: **481 passed, 0 failed**. `tsc --noEmit` and `eslint .` both clean.

### On live infrastructure

`contracts/test/fork/earn/BufiSpendFromMorphoVaultV2.t.sol` — 2 tests, Base mainnet fork at block 50769826,
against Circle's production contracts and the live **Gauntlet USDC Prime** Morpho Vault V2
(`0x050cE30b927Da55177A4914EC73480238BAD56f0`). Only the BUFI plugins are deployed.

```
FOUNDRY_PROFILE=fork forge test --fork-url https://mainnet.base.org \
  --fork-block-number 50769826 --match-path 'test/fork/earn/**' -vv
```

`test_agentPaysOutOfALiveMorphoPosition_withZeroLiquidUsdc` runs the whole round trip on one account carrying
AddressBook + session key + recipient hook + earn module: the relayer sweeps the treasury's entire 100,000 USDC
into the vault, the account is left with **zero liquid USDC**, and the agent then pays a third party 25,000 USDC
in one `executeWithSessionKey` operation. Payee paid, nothing left idle, remainder still earning.
`test_vaultAsErc20SpendLimited_rejectsWithdraw_onLiveVault` reproduces the grant-time trap against the same live
vault. Both pass; the pre-existing Morpho deposit test still passes alongside them.

**Finding — Morpho Vault V2 reports `maxWithdraw == 0` for a holder that can demonstrably withdraw.** This is the
counterpart of the `maxDeposit == 0` quirk already recorded for deposits, and it is now pinned by an assertion in
the same test. Consequence, and a correction to Option B above: a sourcing guard shaped as
`require(maxWithdraw(account) >= shortfall)` — which the first draft of this document proposed — would reject
**every** withdrawal from the vault this stack actually uses. Do not preflight capacity with it anywhere, SDK
included. Let the vault's own revert surface, or read `convertToAssets(balanceOf(account))`.

Note: the README test-matrix row still reads 264 for the default profile. That number predates the
`spike/ghost-shield-addressbook` work, not just this change.

## 7. Relation to ERC-8187

Option A is the bundling the ERC's post calls insufficient; Option B is its sourcing hook without its allowance
model. Neither exposes a spender-callable `pullFrom` on a treasury face — see the enforcement map in
`docs/AGENTIC-WALLET.md`.
