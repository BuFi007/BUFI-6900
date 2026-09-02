# Static analysis — BUFI-6900

```
slither . --filter-paths "lib/|test/|script/" --exclude-dependencies --checklist
```

slither 0.11.x, run 2026-09-02 against `contracts/`. **37 findings, 0 accepted as defects.** Raw output is
committed verbatim as `reports/slither-raw.md` so a reviewer can re-derive this table rather than trust it.

Every finding is dispositioned below. The point of this document is that an auditor should not spend billed hours
re-deriving what a free tool already reports — and, more importantly, should be able to see immediately which of
these we actually thought about versus waved away.

| detector | n | tree | disposition |
| --- | --- | --- | --- |
| `reentrancy-balance` | 4 | v0.7 earn | **Not exploitable — see below.** Mitigated by the runtime relayer gate. |
| `uninitialized-local` | 10 | v0.7 | Intentional zero defaults. |
| `assembly` | 10 | v0.7 session | Inherited verbatim from the audited Alchemy original. |
| `reentrancy-events` | 6 | 5×v0.7, 1×v0.8 gateway | Event-after-call ordering. Informational. |
| `unused-return` | 4 | v0.7 earn + session | Deliberate; the effect is checked instead of the return. |
| `incorrect-equality` | 1 | v0.7 earn | The strict equality is the point. |
| `calls-loop` | 1 | v0.7 session | Inherent to batch execution. |
| `timestamp` | 1 | v0.7 session | Inherent to time-bounded grants. |

---

## `reentrancy-balance` (4) — the one worth reading

`BufiEarnModule.autoEarn` reads `tokenBefore` / `sharesBefore`, makes two external calls through
`executeFromPluginExternal` (approve, then deposit), and compares balances afterwards. Slither correctly observes
that a re-entrant call would make the outer frame's `tokenBefore` stale.

**It is not reachable.** Re-entry would require the vault to call back into `account.autoEarn(...)`, and that path
runs the module's `runtimeValidationFunction`, which requires
`authorizedRelayers[sender] || sender == owner()`. During the external call `msg.sender` is the vault, which is
neither. The account rejects it before the module is reached.

Two things follow that an auditor should test rather than take on faith:

1. **The relayer allowlist is load-bearing for more than authorization** — it is also what makes the F-06
   before/after accounting sound. Any future change that widens who may call `autoEarn` re-opens this. That
   coupling is not obvious from either function in isolation, and it is the single most useful thing to attack
   in this contract.
2. The balance comparison *is* the F-06 fix (adversarial findings, `reports/ADVERSARIAL_PRE_TENDERLY.md`). The
   pattern slither flags is the mitigation, not the bug — but it is a mitigation with a precondition.

## `uninitialized-local` (10)

Two shapes, both intentional:

- `pluginMetadata().metadata` (earn, session key) — a memory struct declared then fully populated before return.
- `validAfter`, `paymasterPostOpGasLimit`, `newNativeTokenUsage` — conditionally assigned, where the zero default
  is the correct value. `_getMaxGasCost` is the clearest case: `paymasterPostOpGasLimit` stays 0 exactly when
  `paymasterAndData` is empty, which is the correct EntryPoint v0.7 prefund for an unsponsored op.

## `assembly` (10)

All in `SessionKeyPermissionsBase` / `SessionKeyPermissions`, all inherited **verbatim** from
alchemyplatform/modular-account v1.0.1 (Spearbit 2024-01-31, Quantstamp 2024-02-20). The associated-storage
pointer arithmetic is what keeps validation reads inside ERC-7562 `[STO-021]`. `PORT-NOTES.md` enumerates every
deviation from the audited original with line references; none of them are in these blocks.

## `reentrancy-events` (6)

Events emitted after an external call, so a re-entrant frame could observe out-of-order logs. No state depends on
the ordering. Informational.

**One caveat we are not hiding:** 1 of the 6 is in `GatewayExecutionModule` (v0.8), which is the one contract in
scope with **no coverage figure at all** — `forge coverage` cannot compile the v0.8 tree (see
`reports/COVERAGE.md`). Untested code plus a static-analysis hit is a worse combination than either alone, and we
would rather flag it than let it pass as "informational, 6 of 6".

## `unused-return` (4)

- `executeFromPluginExternal` returns raw returndata that `autoEarn` ignores **on purpose**: F-06 replaced
  trusting a return value with measuring the balance delta on both sides. Checking the return would be weaker.
- `tryRecover` — the `err` element **is** checked (`BufiSessionKeyPlugin.sol:250` reverts `InvalidSignature` on
  any error). Slither is flagging the third, unused tuple member. False positive.
- `unpackPaymasterStaticFields` — first tuple member (the paymaster address) is deliberately unused there.

## `incorrect-equality` (1)

`sharesMinted == 0`. The strict equality is the intent: reject exactly the zero-shares case (F-06). A `<=`
comparison would be meaningless on an unsigned delta.

## `calls-loop` (1)

`executeWithSessionKey` dispatches a batch, so external calls in a loop are the function's purpose. Inherited from
the audited original; gas exhaustion is bounded by the op's own gas limit and by the key's gas budget.

## `timestamp` (1)

`_runtimeUpdateSpendLimitUsage` compares against `block.timestamp` to apply refresh windows. Time-bounded grants
cannot be built without it. Note the validation-phase path deliberately does **not** read `block.timestamp` — it
returns a `validAfter` for the EntryPoint to enforce, which is what keeps the op bundler-compatible.

---

---

# solhint

```
bun run contracts:lint        # src, Circle's .solhint-src.json
bun run contracts:lint:test   # test, Circle's .solhint-test.json
```

Circle's three configs (`.solhint-src.json`, `.solhint-test.json`, `.solhint-script.json`) and `.solhintignore`
are copied **verbatim** from `buidl-wallet-contracts` rather than invented here, so the plugins are linted against
the same bar as the account they install on.

**0 errors, 207 warnings** on `src/`. Circle sets exactly two rules to error level — `compiler-version` pinned to
0.8.24, and `func-visibility` — and both pass.

The warnings break down into three groups, and only one of them was worth acting on:

| group | n | action |
| --- | --- | --- |
| `import-path-check` on remapped imports (`@circle/…`, `@account-abstraction/…`) | many | **False positives.** solhint does not read `foundry.toml` remappings. Not fixable, not real. |
| `use-natspec` / `gas-*` in **ported** files | most of the rest | **Deliberately not fixed** — see below. |
| `use-natspec` in the **new** recipient hook | 11 | **Fixed.** |

## Why the ported files keep their warnings

`docs/AUDIT-SCOPE.md` asks reviewers to *diff the session-key and earn plugins against their upstreams rather than
read them from scratch*, because both are ports of audited code and the deviations are what matter. Adding natspec
those upstreams do not have would inflate that diff with noise and make the one thing we want an auditor to do
harder. `BufiEarnModule` alone accounts for 83 warnings and is a near-verbatim AGPL port.

So: cosmetic warnings in ported files are left alone on purpose. If a future maintainer "cleans" them, the
diff-against-upstream instruction stops being practical.

## What was fixed

`BufiSessionRecipientHookPlugin` and its interface are **new BUFI code with no upstream**, so an auditor reads them
cold and natspec is load-bearing rather than noise. All 11 real gaps closed: `@author` on both the contract and the
interface, `@param` on the two events, and `@param`/`@return`/`@notice` on `addressBookOf` and `_isInitialized`.

The hook now reports 11 warnings, all of them either the remapping false positive (10) or
`gas-small-strings` on the plugin's own `_NAME` constant (1) — a string ERC-6900 requires in the metadata, where
exceeding 32 bytes is the cost of a readable plugin name.
