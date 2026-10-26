# Contract verification and release closure — 2026-10-26

This is a scoped review and acceptance plan, not an independent security audit.
Contract source: `93ce6daa1004581c4058ce2baa7911bee93f240e`.
Desk integration: `51bc22500ea6434bbec5895efdb239bbfbbceca3`.
The canonical cross-repository inventory remains Desk's `contracts/deployments.json`.

## Confirmed new deployment

| Evidence | Result |
| --- | --- |
| Network | Arc mainnet, chain 5042 |
| Contract | `TreasuryConduitPermit2`, `0xB63DA0934E2a89169F89EED0679c35cc4d5959a5` |
| Deployment transaction | `0x1cac868589ad543c55a83cc585090721c5b5ed4d268fe3dbcbb47006d16b6001` |
| Block | 28005305 |
| Safe operation | `0x0353400c3020016473787615176ece340576c32ef5550910195b42b184036c62`, `ExecutionSuccess` |
| Prepared call | Exact CREATE2 target, zero value, calldata and CALL operation match |
| Owner | Arc Safe `0x47Dc7D18A6E3a79F696714E7D47456a49B430D09` |
| Dependencies | Canonical Permit2 and Circle AddressBook getters match |
| Runtime | 10,432 bytes, keccak `0x55eb4131767006c7386b08a936071d951c1474c0016680959f8feba0a2b45b79` |
| Source verification | Sourcify creation and runtime `exact_match`, job `9b74bead-bfe7-4a71-8329-97958cf63ea4` |
| Admission | Inactive: checked LI.FI target/spender disabled; no application profile installed |

Source verification: https://sourcify.dev/#/lookup/0xB63DA0934E2a89169F89EED0679c35cc4d5959a5?chainId=5042

The Safe signed/executed deployment. The agent verified it; it did not send a
second deployment, register routers, approve tokens or move customer funds.

## What the current evidence covers

- Permit2 unit tests use canonical Permit2 bytecode and the real Circle weighted
  account/AddressBook harness, including unequal weights. Router/token test
  doubles isolate adversarial failures; they are not a live LI.FI payment.
- `TreasuryConduitPermit2LifiArc.t.sol` exports local state because generic Anvil
  does not reproduce Arc's native USDC behavior. Its expected local failure is
  not positive settlement evidence.
- `test/harness/run-permit2-arc-rpc.mjs` independently runs six non-persistent
  native `eth_call` cases: success/replay and below-floor rollback for swap,
  invoice and reimbursement. Rechecked 2026-10-26: all pass at the recorded
  fixture blocks, against the exact release runtime. Router and USDC code are
  not overridden. The artificial Treasury/probe state is overridden.
- Those simulations measure 312342280968221548 WBRL units against minimum
  310780569563380440, clear router allowance, reject replay, and preserve input,
  output, nonce and operation after a floor failure. They do not create a real
  invoice, reimbursement, ledger entry or receipt.
- Desk's latest block passed 383 backend tests / 1,683 assertions, 228 LI.FI
  Vitest cases and 341 disposable PostgreSQL checks. These prove local behavior,
  not deployment of that SHA or a signed production checkout.
- Full current Solidity suite (`forge test --json`, default profile): **539
  passed, zero failed, three skipped**, across 32 suites. The skipped cases are
  Arc/Avalanche live bridge forks requiring RPC configuration; other suites under
  `test/fork/**` are excluded by the default profile. September coverage reports
  remain historical and must not be reused as current totals.
- The six conduit suites were then rerun with `FOUNDRY_PROFILE=ci` (1,024 fuzz
  runs): 104 passed, zero failed, the same three live-fork cases skipped. This
  is a stronger rerun of those cases, not 104 additional distinct tests.

## Closure order for the whole suite

| Priority | Work | Acceptance evidence |
| --- | --- | --- |
| P0 | Reconcile every deployed contract across Desk, BUFI-6900 and fx-recibu | Chain/address, creation tx, compiler/settings, runtime hash, constructor, owner/roles, upgradeability and source match; mark inactive and superseded entries separately. |
| P0 | Independent review of financial boundaries | Review conduits, Permit2, bridge, claim/payroll and fx-recibu plus their actual signature/settlement adapters. Close exploitable findings with regression proofs. An AI review or founder waiver is not an external audit. |
| P0 | Certify one bounded same-chain pilot | Human-signed swap, invoice and reimbursement; exact recipient/token/minimum, one original operation, one finalization, ledger/outbox and downloadable Recibo; replay/reload must not pay twice. |
| P1 | Add stateful invariants for new financial contracts | Sequence execution, partial fill, donation, route/owner changes, revocation, expiry and replay. Preserve unrelated balances, never exceed approved debit, zero residual operation allowance, at most one execution. |
| P1 | Upgrade CI evidence | Explicit 1,024-run fuzz profile; separate per-network fork/native-RPC jobs with pinned block/runtime/fixture hashes. Missing RPC or skipped suite is unverified, not a pass. |
| P1 | Renew coverage without hiding exclusions | Measure the current conduit/bridge/redeem/Gateway sources; report v0.7/v0.8 and fork exclusions independently. Cover meaningful authorization and accounting branches, not merely a total percentage. |
| P1 | Certify multichain separately | Arc and Avalanche deployment/route/token evidence, real source burn, destination mint, second quorum, final delivery and interrupted-leg recovery. Source burn is never document Paid. |

The pre-addition Desk inventory held 304 entries: 155 BUFI contracts and 149
dependencies. Of 14 BUFI mainnet rows marked current, 12 say `audit: none`, two
say `founder-waived`, and eight lack full deployment hashes. These are inventory
gaps, not newly discovered vulnerabilities or proof of absent external reviews.
The new inactive Permit2 record adds one more unaudited deployed contract.

## Dynamic LI.FI routes: boundaries to retain

- Discover routes per request; only admitted target/spender/selector identities
  may be selected. Keep original route, deployment, document and operation IDs
  through setup, review, signature, submission and recovery.
- Price availability does not authorize a new router, token or destination.
  A new venue/facet needs reviewed governance admission. Never reuse a signature
  over refreshed terms; never put a Treasury on a direct aggregator transaction.
- The deployed conduit checks a Safe-governed target/spender pair, not its current
  proxy implementation/facet hash. Desk now checks the effective identity before
  execution, but an upgrade between that read and mining remains possible.
  Assess this trust assumption independently before broad admission. An atomic
  on-chain identity restriction would require a new reviewed contract version.
- A confirmed receipt for an original submitted operation must remain recoverable
  after route suspension or registry rotation. Closing initiation is not proof
  that a disclosed permit was revoked; preserve its reservation until safe release.
- Do not extend atomic same-chain rollback guarantees to a cross-chain burn.
  Existing two-quorum bridge accounting and recovery must remain authoritative.

## Static-analysis triage

The targeted Slither analysis of `TreasuryConduitPermit2.sol` and its inherited
base completed: 35 raw results, not 35 confirmed vulnerabilities. The Foundry
artifact import first failed on missing split build-info; the targeted compile
then analyzed 13 contracts with 102 detectors.

| Detector | Count | Initial disposition and remaining proof |
| --- | ---: | --- |
| `reentrancy-balance` | 28 | Reports the deliberate before/after balance reads. Both execution entry points share `nonReentrant`; `executed` is set before external calls, and final balances/allowances are checked. No public reentry exploit confirmed in this pass. Extend tests from router callbacks to token approve/reset/pull/refund/output callbacks and cross-entry reentry. Owner-only rescue remains an explicit Safe trust boundary. |
| `incorrect-equality` | 1 | The `rescue` zero-balance guard rejects a no-op; the equality is not price/accounting logic. |
| `timestamp` | 2 | Intended signature deadlines; test exact deadline boundaries and do not promise immediate revocation from expiry alone. |
| `cyclomatic-complexity` | 1 | Reviewability concern in the execution function; avoid changing verified runtime merely to reduce a metric. |
| `low-level-calls` | 2 | Intended registered-router calls with propagated failure. Review target/spender governance and proxy/facet upgrades. |
| `naming-convention` | 1 | `DOMAIN_SEPARATOR` matches the upstream interface. |

This triage is not a clean external audit. In particular, the token-callback
sequences and mutable-router assumptions still require explicit adversarial
evidence. No deployed Solidity was modified by this verification pass.

## Work intentionally not performed

No second deployment, router registration, allowance, payment, runtime rollout,
new admission flag or automatic upgrade was executed. No claim is made that all
305 registry entries have been freshly read on-chain. This plan covers the
remaining work before certifying broader usage; it is not that certificate.
