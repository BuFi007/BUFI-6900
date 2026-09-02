# Solidity coverage — BUFI-6900

Generated 2026-09-02.

```
FOUNDRY_PROFILE=coverage forge coverage --ir-minimum --report summary
```

## What this covers, and what it does not

**v0.7 only.** `src/bufi/v0.8/gateway/**` is excluded and has **no coverage figure**; none is claimed.

`forge coverage` disables the optimizer and via-IR to keep source mapping accurate. Under solc 0.8.24's legacy
codegen that immediately fails here, because every harness copies a struct array from memory to storage
(`Signer[]`, `Vm.Log[]`) and legacy codegen cannot: *"Unimplemented feature (ArrayUtils.cpp): Copying of type
struct … memory[] memory to storage not yet supported."*

`--ir-minimum` restores via-IR and clears all of those at once, but then hits a Yul stack-too-deep inside
Circle's **vendored** v0.8 `BaseMSCA` — `Variable var_hookUninstallData_24747_offset is 6 too deep in the stack`
— in out-of-scope code we do not control. So `[profile.coverage]` skips the v0.8 tree, its harness, and the fork
suites (which need RPCs). 214 of the 264 tracked tests run under it.

Rewriting the harnesses to satisfy legacy codegen was tried and rejected: it is a refactor across ~15 test files,
and a first attempt at the `Vm.Log[]` copy alone compiled under coverage but then broke the `fork-arc` profile
with a *different* Yul stack error. The vendored-code limit is real; working around it in our own test code buys
nothing.

## Results

╭------------------------------------------------------------------+------------------+------------------+-----------------+-----------------╮
| File                                                             | % Lines          | % Statements     | % Branches      | % Funcs         |
+============================================================================================================================================+
| src/bufi/v0.7/earn/BufiEarnModule.sol                            | 80.00% (96/120)  | 83.21% (114/137) | 56.25% (9/16)   | 72.73% (16/22)  |
|------------------------------------------------------------------+------------------+------------------+-----------------+-----------------|
| src/bufi/v0.7/recipient-hook/BufiSessionRecipientHookPlugin.sol  | 96.25% (77/80)   | 96.47% (82/85)   | 100.00% (14/14) | 100.00% (13/13) |
|------------------------------------------------------------------+------------------+------------------+-----------------+-----------------|
| src/bufi/v0.7/session/BufiSessionKeyPlugin.sol                   | 93.55% (116/124) | 94.12% (128/136) | 90.91% (10/11)  | 100.00% (14/14) |
|------------------------------------------------------------------+------------------+------------------+-----------------+-----------------|
| src/bufi/v0.7/session/libraries/PluginStorageLib.sol             | 18.75% (3/16)    | 0.00% (0/13)     | 100.00% (0/0)   | 100.00% (3/3)   |
|------------------------------------------------------------------+------------------+------------------+-----------------+-----------------|
| src/bufi/v0.7/session/permissions/SessionKeyPermissions.sol      | 98.25% (225/229) | 98.42% (249/253) | 96.92% (63/65)  | 100.00% (22/22) |
|------------------------------------------------------------------+------------------+------------------+-----------------+-----------------|
| src/bufi/v0.7/session/permissions/SessionKeyPermissionsBase.sol  | 89.58% (43/48)   | 89.58% (43/48)   | 100.00% (1/1)   | 100.00% (10/10) |
|------------------------------------------------------------------+------------------+------------------+-----------------+-----------------|
| src/bufi/v0.7/session/permissions/SessionKeyPermissionsLoupe.sol | 100.00% (38/38)  | 100.00% (41/41)  | 100.00% (2/2)   | 100.00% (8/8)   |
|------------------------------------------------------------------+------------------+------------------+-----------------+-----------------|
| src/sandbox/SandboxUSDC.sol                                      | 100.00% (4/4)    | 100.00% (2/2)    | 100.00% (0/0)   | 100.00% (2/2)   |
|------------------------------------------------------------------+------------------+------------------+-----------------+-----------------|
| Total                                                            | 91.35% (602/659) | 92.17% (659/715) | 90.83% (99/109) | 93.62% (88/94)  |
╰------------------------------------------------------------------+------------------+------------------+-----------------+-----------------╯

## Where the gaps are

- **`BufiEarnModule.sol` — 56.25% branches (9/16), 80% lines.** The weakest in-scope contract and the one worth
  closing first. Adversarial findings F-06 and F-08 added checks to `autoEarn` and `setConfig`; their failure
  branches are under-exercised.
- **`BufiSessionRecipientHookPlugin.sol` — 96.25% lines, 100% branches, 100% functions.** The newest and least
  audited contract is the best covered, which is the right way round.
- **`PluginStorageLib.sol` — 0% statements.** Vendored from Alchemy's audited v1.0.1 and reached through assembly,
  so the instrumenter cannot see it. Not a real gap; do not "fix" it with tests that assert nothing.
- **0 invariant tests.** 12 fuzz tests exist. Tracked separately in `reports/READINESS-BUCKETS.md` bucket 2.

## Gas

`.gas-snapshot` is committed, generated with
`forge snapshot --no-match-contract GhostShieldAddressBookTest` (263 entries, tracked tree only).
