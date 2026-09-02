# Security policy

## Status

**This code is unaudited and is not deployed on any production network.** It runs on Avalanche Fuji (43113) and
Arc Testnet (5042002) only. Do not put value you cannot lose behind it.

An external audit is being arranged. `docs/AUDIT-SCOPE.md` defines what is in scope and where to spend review
time; `docs/THREAT-MODEL.md` states the invariants each plugin must hold.

## Reporting a vulnerability

Email **security@bu.finance** with `BUFI-6900` in the subject. Please include the affected contract and commit,
the invariant you believe is broken, and a reproduction — a failing Foundry test against this repo is ideal.

Please do not open a public issue for anything that could move funds, and please give us 90 days before public
disclosure. We will acknowledge within 3 working days and keep you updated at least every 10 days until it is
resolved or we agree it is not a defect.

There is no bug bounty today. If a report leads to a fix we will credit you in the release notes unless you ask us
not to.

## What we already know

Do not spend time on these — they are documented, not undiscovered:

- **`reports/ADVERSARIAL_PRE_TENDERLY.md`** — an adversarial pass with per-finding dispositions. F-01, F-06 and
  F-08 were fixed; the pre-fix bytecode is recorded in `contracts/deployments/*.json` under `supersededPlugins`
  and must never be installed.
- **`reports/STATIC-ANALYSIS.md`** — all 37 slither findings, each dispositioned, with the raw output committed
  alongside so you can re-derive rather than trust it.
- **`reports/COVERAGE.md`** — `src/bufi/v0.8/gateway/**` has **no coverage figure**. `forge coverage` cannot
  compile Circle's vendored v0.8 `BaseMSCA`. That subtree is the least-tested code in the repo and we would rather
  say so.
- **`BufiSessionRecipientHookPlugin` is new code with no audited ancestor.** Its `_getTargetOrRecipient`
  deliberately diverges from Circle's `ColdStorageAddressBookPlugin`: where Circle reverts on a zero-value call
  with no decodable token recipient, this returns the call target, so the target must itself be allowlisted.
  The trade-off is written up in `docs/AUDIT-SCOPE.md` under "Where to spend the review" — an allowlisted contract
  is trusted for whatever its own calldata does.

## Scope

In scope: `contracts/src/bufi/**`.

Out of scope: everything under `contracts/lib/**` (Circle's `buidl-wallet-contracts`, eth-infinitism EntryPoint,
OpenZeppelin, solady, FreshCryptoLib, the ERC-6900 reference implementations) — report those upstream. The
TypeScript packages hold no funds and are not part of the on-chain trust boundary, but reports about calldata they
encode incorrectly are welcome.
