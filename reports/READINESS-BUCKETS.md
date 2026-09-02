# BUFI-6900 — audit + launch readiness buckets

Assessed 2026-09-02 against `main`. Every claim below is anchored on a file, a
command, or an RPC response. Where evidence is missing the row says so rather
than guessing.

**Verdict: not ready to submit.** Buckets 1–3 block the audit package. Bucket 4
blocks the launch claim and is gated on an external party, so it starts now.

| # | Bucket | Score | Blocks | Owner action |
|---|---|---|---|---|
| 1 | Scope definition & provenance | **100%** ✅ | — | closed 2026-09-02 |
| 2 | Test evidence (coverage + gas) | **100%** ✅ | — | closed 2026-09-02 |
| 3 | Deployment & explorer verification | **100%** ✅ | — | closed 2026-09-02 |
| 4 | **Arc private mainnet validation** | **10%** | **launch claim** | **unblock dRPC entitlement** |

---

## 1. Scope definition & provenance — 100% ✅ closed 2026-09-02

- ✓ `BufiSessionRecipientHookPlugin` (321 + 34 lines) is now a row in the in-scope table of
  `docs/AUDIT-SCOPE.md`, marked "new, unaudited, no upstream to diff against — read it first", with claim 7
  mapping it to its 19 tests.
- ✓ New **"Where to spend the review"** section ranks auditor attention: the hook's `_getTargetOrRecipient`
  divergence first (with the reason it exists and the F-02/F-03 consequence), then D10, then F-06/F-08.
- ✓ Every count re-measured today rather than carried forward. `forge test` 197 → **264** (16 suites),
  jest 441 → **461**, SDK coverage 99.4% → **98.93%**.
- ⚠️ **Measure the tracked tree, not the working tree.** A first pass published 269 / 17 suites. That was wrong:
  the working tree held an untracked `contracts/test/bufi/v0.7/ghost/GhostShieldAddressBook.t.sol` (5 tests,
  created 2026-09-02 14:00 by another session), so 5 of those tests do not exist in a clean clone. The tracked
  number is 264 and it is what the docs now carry. Use
  `forge test --no-match-contract GhostShieldAddressBookTest` while that file is uncommitted. A count an auditor
  cannot reproduce is worse than a stale one — this is the same failure mode bucket 1 exists to fix, reached from
  the opposite direction.
- ✓ Stale counts also corrected in `README.md`, `docs/CIRCLE-SUBMISSION.md`, `docs/AGENTIC-WALLET.md`,
  `reports/AUDIT_REPORT.md`, `tasks/todo.md`. Repo-wide grep for `197|441|264|99.4%` outside vendored libs
  returns nothing.
- ✓ Corrected a second false claim: "fork suites need a Sepolia RPC" — they need **three** networks
  (Arc testnet, Base mainnet, Sepolia), now tabulated per suite.
- ✓ `docs/THREAT-MODEL.md` gains invariants 7 (one allowlist, both paths) and 8 (the hook only narrows), four
  new attack-surface rows, and four residual risks — including the one that matters most: an allowlisted
  contract is trusted for whatever its own calldata does.
- ✓ The absent Solidity coverage figure is now stated as absent, with the exact Yul error, instead of omitted.

### Superseded assessment (kept for the record) — 70%

- ✗ `BufiSessionRecipientHookPlugin` (321 lines) appears nowhere in
  `docs/AUDIT-SCOPE.md` — `grep -nE "recipient-hook|RecipientHook"` returns zero
  hits. An auditor working from that document will not read the plugin.
- ✗ `docs/AUDIT-SCOPE.md:43` claims `forge test`: 197 passed. Actual default-tree
  count is 264, plus 52 fork tests. The SDK line says 441 jest; actual is 461.
- ✓ Deviations from Circle's upstream are enumerated (D1–D10) with rationale.
- ✓ CREATE2 salt and manifest hashes pinned per chain in
  `contracts/deployments/*.json`.

**To 100%:** rewrite `AUDIT-SCOPE.md` and `THREAT-MODEL.md` to cover the hook —
including the rule change that made agentic work possible at all
(`_getTargetOrRecipient` returns `recipient == address(0) ? target : recipient`
instead of reverting) — and refresh every count from a real run.

## 2. Test evidence — 100% ✅ closed 2026-09-02

| | before | after |
| --- | --- | --- |
| `forge test` (tracked) | 264 | **283** |
| Lines | 91.35% | **94.54%** |
| Branches | 90.83% | **97.25%** |
| Functions | 93.62% | **100.00%** |
| `BufiEarnModule` branches | 56.25% | **100.00%** |
| Invariant tests | 0 | **3** |

- ✓ **`forge coverage` runs** via `[profile.coverage]` + `--ir-minimum`. Full table: `reports/COVERAGE.md`.
- ✓ **`.gas-snapshot` committed**, 282 entries, tracked tree only.
- ✓ **`BufiEarnModuleGuards.t.sol` (13 tests)** closes the earn module. The two F-06 deposit guards are each
  driven by a purpose-built hostile vault: one reporting a different `asset()`, one that mints shares but debits
  half — the exact shape the pre-F-06 module reported as a clean success. Plus the config guards
  (`EmptyConfigList`, `TooManyTokens` at exactly the 101st token, `ModuleNotInitialized`) and the five ERC-6900
  entry points the module deliberately leaves unimplemented.
- ✓ **`AgentEnvelope.invariant.t.sol` — 3 invariants, 1920 calls each, 0 reverts.** Over arbitrary sequences of
  session-key ops (handlers deliberately request amounts past the budget and recipients off the allowlist):
  the agent never spends beyond its grant; no token ever reaches an unlisted address; and USDC is conserved
  between the account and the allowlist. Both properties are BUFI code — the session-key spend accounting and
  the recipient hook — not Circle's.
- ✓ Two deterministic tests guard against a **vacuous** invariant run, proving the handlers move state in both
  directions (one accepted op, one rejected). They are plain tests, not a fourth invariant, because foundry
  evaluates invariants against the initial state too, where nothing has run.
- ✓ **A fuzz counterexample found and resolved.** `testFuzz_sessionKeyTimeRange` failed at
  `validAfter = type(uint48).max, validUntil = 0`. Traced to Circle's *vendored* `ValidationDataLib:71`: it
  repacks `validUntil == 0` as indefinite (`type(uint48).max`) and then forces `SIG_VALIDATION_FAILED` whenever
  `validAfter >= validUntil`. The BUFI plugin returned success; the account correctly closed an **empty**
  window. Not a defect — the test's blanket `authorizer == 0` was wrong. It now asserts both branches, and
  `test_sessionKeyTimeRange_emptyWindowFailsClosed` pins the corner deterministically so it no longer depends
  on the fuzzer rediscovering it.
- ⚠️ `src/bufi/v0.8/gateway/**` still has NO coverage figure, stated as such. Two compiler walls meet there —
  legacy codegen cannot copy the harnesses' struct arrays to storage, and `--ir-minimum` hits a Yul
  stack-too-deep in Circle's *vendored* v0.8 `BaseMSCA`. Rewriting our harnesses was tried and rejected: ~15
  files, and the first attempt broke the `fork-arc` profile with a different Yul error.
- ⚠️ `PluginStorageLib.sol` reports 0% statements. Vendored, reached through assembly, invisible to the
  instrumenter. It is the only reason the totals are not higher; do not close it with tests that assert nothing.

### Superseded assessment (85%, coverage + gas only)

- ✓ **`forge coverage` runs.** `[profile.coverage]` in `contracts/foundry.toml` skips the v0.8 tree, its harness
  and the fork suites; `FOUNDRY_PROFILE=coverage forge coverage --ir-minimum` then reports **91.35% lines /
  92.17% statements / 90.83% branches / 93.62% functions** over the v0.7 tree (214 of 264 tests). Full table and
  the method note: `reports/COVERAGE.md`.
- ✓ **`.gas-snapshot` committed**, 263 entries, tracked tree only.
- ✓ The hook — newest, least audited — is the best-covered contract: 96.25% lines, 100% branches, 100% functions.
- ✗ **`BufiEarnModule` is 56.25% branches / 80% lines**, the weakest in-scope contract. The F-06 / F-08 failure
  paths are under-exercised. Close this before submission.
- ✗ **0 invariant tests.** 12 fuzz tests exist. Candidates: session-key budget accounting never exceeds the
  granted envelope; multisig weight total equals the sum of owner weights.
- ⚠️ `src/bufi/v0.8/gateway/**` has NO coverage figure, stated as such rather than omitted. Two compiler walls
  meet there — legacy codegen cannot copy the harnesses' struct arrays to storage, and `--ir-minimum` hits a Yul
  stack-too-deep in Circle's *vendored* v0.8 `BaseMSCA`. Rewriting our harnesses to satisfy legacy codegen was
  tried and rejected: ~15 files, and the first attempt broke the `fork-arc` profile with a different Yul error.

### Superseded assessment (kept for the record) — 65%

- ✗ `forge coverage` fails repo-wide, even with `--ir-minimum`:
  `Yul exception: Variable var_hookUninstallData_24747_offset is 6 too deep in
  the stack`, raised from Circle's vendored v0.8 `BaseMSCA`. Coverage compiles
  the whole tree regardless of `--no-match-path`, so the v0.8 subtree poisons a
  run that never intended to include it.
- ✗ 0 invariant tests (`grep -c "function invariant_"` → 0). 12 fuzz tests exist.
- ✗ No committed gas snapshot.
- ✓ 264 default + 52 fork tests, all passing at last full run.
- ✓ Fork suites prove the real thing: Circle's production stack recreated
  bit-for-bit, a Morpho Vault V2 round trip on a Base fork, and an ERC-8183 job
  run end to end by an agent MSCA on an Arc **testnet** fork.

**To 100%:** give the v0.8 tree its own compile profile so `forge coverage` can
skip it, then commit coverage + `.gas-snapshot`. Add invariants for the session
key budget accounting and the multisig weight total.

## 3. Deployment & explorer verification — 100% ✅ closed 2026-09-02

`BufiSessionRecipientHookPlugin` is deployed at **`0xAa8B4fb76e8Eb712435E2b948B3A35c4C069d98A`** on both Avalanche
Fuji (43113) and Arc testnet (5042002) — same address, same 11054-byte runtime, from the shared CREATE2 salt
`keccak256("bufi-6900-plugins-v0.2.0")`. Manifest hash
`0x0870010f2468b943064a0d1273050e7e37bd40ca26c70138156e850a57e999da`. It takes no constructor args, so unlike the
earn module there is nothing to rotate before shared use.

The dry run was the check that the salt was right: it re-predicted the two existing plugins at exactly their
recorded addresses (`0xBd607dBA…`, `0xeb94A8b7…`) before anything was broadcast.

All three BUFI plugins are explorer-verified on both chains — six verifications:

| | Fuji (Routescan) | Arc testnet (arcscan / Blockscout v11.2.8) |
| --- | --- | --- |
| `BufiSessionKeyPlugin` | ✓ | ✓ |
| `BufiEarnModule` | ✓ | ✓ |
| `BufiSessionRecipientHookPlugin` | ✓ | ✓ |

**Confirmed by reading `getsourcecode` back from each explorer**, not from `forge verify-contract`'s own success
message — every one returned the right `ContractName` with real source attached. A tool reporting its own success
is not evidence.

The two Circle plugins in those files (`weightedWebauthnMultisig`, `coldStorageAddressBook`) are Circle's own
deployments and are not ours to verify; they carry no `verified` flag for that reason.

`script/DeployBufiPlugins.s.sol` now deploys all three and stays idempotent — a re-run reports "already at" and
broadcasts nothing.

### Superseded assessment (kept for the record) — 45%

- ✗ The recipient hook is not deployed anywhere. `contracts/deployments/arc-testnet.json`
  and `avax-fuji.json` list only `weightedWebauthnMultisig`, `coldStorageAddressBook`,
  `bufiSessionKey`, `bufiEarnModule`.
- ✗ Both files end with "Not verified on explorers."
- ✓ Superseded pre-fix bytecode is recorded and marked "never install", so a
  reviewer cannot pick up the wrong address by accident.

**To 100%:** deploy the hook to Fuji + Arc testnet at the same CREATE2 salt, then
`forge verify-contract` all three BUFI plugins on both chains.

---

## 4. Arc private mainnet validation — 10%

The first three buckets are about the audit package. This one is about whether
the claim "BUFI runs on Arc" survives contact with the real network.

Everything proven so far is on **Arc testnet, chainId 5042002**. Arc private
mainnet is a different chain — **chainId 5042** — with a different economic
model: USDC is the native gas token, so every gas payment is real money.

### Access status — VALID KEY, ENTITLEMENT NOT GRANTED

Provisioned 2026-08-17 by the Arc admin against dRPC team
`a39c3294-5485-433a-9abc-43d6f33987bc`. Credentials live in `.env.local`
(gitignored, mode 600). Probed 2026-09-02:

| Request | Response |
|---|---|
| `eth_chainId` @ `lb.drpc.live/arc/<key>` | `code 35 — chain is not available on free plan` |
| `eth_chainId` @ `lb.drpc.org/arc/<key>` | `code 35` (same) |
| `eth_chainId` @ `.../arc-mainnet/<key>` | `code 35` (same) |
| `eth_chainId` @ `lb.drpc.org/ethereum/<key>` | `0x1` — **key authenticates** |
| `eth_chainId` @ `arc/<bogus key>` | `code 4 — token is invalid or expired` |
| `Drpc-Key` **header** auth, no key in path | `code 35` — header accepted, same gate |
| `Drpc-Key` + `Drpc-Team` headers | `code 35` |
| no key at all | `Invalid request` |

The two control probes settle it. The key is valid and the `arc` slug resolves;
what is missing is the **Arc chain entitlement on the dRPC plan for this team**.
Arc's own whitelist may well have been applied — dRPC's plan gate is a separate
door and it is the one that is shut. Nobody needs to re-verify the whitelist.

### The same key DOES reach Arc testnet

`arc-testnet` on the same key returns `0x4cef52` (5042002) on both `lb.drpc.live`
and `lb.drpc.org`. So the free plan carries Arc testnet and withholds Arc private
mainnet — which is the plan gate showing its shape, and a third confirmation that
the credential itself is fine.

Measured against the public `rpc.testnet.arc.network`:

| | dRPC | public |
|---|---|---|
| `eth_chainId` | `0x4cef52` | `0x4cef52` |
| archive `eth_getCode` @ block 60099079 | identical bytes | identical bytes |
| archive `eth_getBalance` @ 60099079 | `0x10e0591f9bf738840` | `0x10e0591f9bf738840` |
| `eth_blockNumber` latency ×3 | 0.48 / 0.49 / 0.47 s | 0.23 / 0.23 / 0.27 s |
| `FOUNDRY_PROFILE=fork-arc forge test --match-path 'test/fork/agentic/**'` | **3 passed, 0 failed** (25.8 s) | 3 passed (baseline) |

Both serve archive state at the block `AgentFaceErc8183.t.sol` pins, so dRPC is a
verified drop-in for `ARC_TESTNET_RPC_URL` — useful as a fallback if the public
endpoint throttles under fork-test load. It is not an upgrade: it is ~2× slower
through the load balancer and returns the same data. **The only thing the dRPC
grant buys that we do not already have is `arc` (5042), and that is the gated
one.** Do not let the working testnet slug be mistaken for working access.

### What Circle's docs pin down (and the one thing they do not)

From the private-mainnet and contract-address pages, 2026-09-02. Genesis was
2026-05-15, so 5042 has been live ~3.5 months; the published timeline targeted
public mainnet "late June 2026" and is now stale — confirm the current phase
rather than quoting it.

| | Arc mainnet (5042) | note |
|---|---|---|
| USDC ERC-20 | `0x3600000000000000000000000000000000000000` | same address as testnet |
| EURC | `0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1` | differs from testnet |
| CCTP TokenMessengerV2 | `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d` | domain 26 |
| CCTP MessageTransmitterV2 | `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64` | domain 26 |
| CCTP TokenMinterV2 | `0xfd78EE919681417d192449715b2594ab58f5D002` | domain 26 |
| CCTP MessageV2 | `0xec546b6B005471ECf012e5aF77FBeC07e0FD8f78` | domain 26 |
| **GatewayWallet** | `0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE` | domain 26 |
| **GatewayMinter** | `0x2222222d7164433c4C09B0b0D809a9b52C04C205` | domain 26 |
| StableFX FxEscrow | `0xe2E5F173576B513d994073CCbDaCBE027d43DFe6` | needs Permit2 allowance |

Gateway being live on 5042 is the piece that matters most beyond this bucket: it
is the chain where `docs/GATEWAY-1271-EVALUATION.md`'s two-face agent design
would actually be exercised with real USDC.

**Do not treat these as verified.** They are transcribed from Circle's docs, not
read off the chain. Every one gets an `eth_getCode` before it enters a
deployments file. Two tables in those docs — "Transaction extensions" (`Memo`,
`Multicall3From`) and "Common Ethereum contracts" (CREATE2 factory, Multicall3,
Permit2) — link only to `testnet.arcscan.app` and are **not** presented per-network,
so their mainnet presence is unestablished. The Arachnid CREATE2 factory in
particular is load-bearing: BUFI's plugins deploy at a shared salt and without it
on 5042 the whole same-address property is gone.

### The unknown that decides this bucket

**Circle's docs list no ERC-4337 EntryPoint and no MSCA stack for Arc mainnet.**
Not the factory, not the PluginManager, not `WeightedWebauthnMultisigPlugin`.
Every fixture in this repo assumes Circle's production stack exists at its
canonical addresses; on Arc testnet it does (`contracts/deployments/arc-testnet.json`).
On 5042 that is simply unverified, and it is not the kind of thing to assume.

First four calls once the RPC answers, in this order:

```
eth_getCode 0x0000000071727De22E5E9d8BAf0edAc6f37da032   # EntryPoint v0.7
eth_getCode 0x0000000DF7E6c9Dc387cAFc5eCBfa6c3a6179AdD   # UpgradableMSCAFactory
eth_getCode 0x00000005e69188224e4dEeF607801916DC0936d5   # PluginManager
eth_getCode 0x4e59b44847b379578588920cA78FbF26c0B4956C   # Arachnid CREATE2
```

If EntryPoint or the factory returns `0x`, bucket 4 is not a deployment task —
it is a conversation with Circle about when the MSCA stack lands on 5042, and
nothing else in this bucket can proceed.

### Decimals trap, same as testnet

Native USDC carries 18 decimals; the ERC-20 interface at `0x3600…` carries 6,
over **one shared balance**. This already bit the Arc testnet fork suite: `vm.deal`
moved the native balance while `balanceOf` did not follow, and funding had to be
written as `amount * 1e12`. Expect it again on 5042 and note that ERC-20
`Transfer` logs alone under-report movement — native transfers emit EIP-7708
`Transfer` events separately.

### Criteria for 100%

- ✗ A `eth_chainId` from the Arc private mainnet RPC returns `0x13b2` (5042).
- ✗ `contracts/deployments/arc-private-mainnet.json` exists with Circle's stack
  addresses **read from that chain**, not copied from testnet. Deliberately not
  pre-written: chain 5042 is a mainnet and inventing an address there is worse
  than having none.
- ✗ A fork test pinned to a real 5042 block, mirroring
  `test/fork/agentic/AgentFaceErc8183.t.sol` (which today asserts
  `block.chainid == 5042002`).
- ✗ BUFI's four plugins deployed at the shared CREATE2 salt and explorer-verified.
- ✗ One MSCA deployed and one session-key userOp landed, with the gas cost
  recorded in USDC — the number that does not exist on any testnet.
- ✗ ERC-8183 job round trip against whatever Circle has deployed on 5042
  (its presence there is unverified; do not assume the testnet address).
- ✓ `contracts/foundry.toml` has an `arc-private-mainnet` endpoint reading
  `${ARC_PRIVATE_MAINNET_RPC_URL}`, so every command works the moment the
  entitlement lands.

### Two things to settle before anything is deployed

1. **The deployer key must be rotated.** `0x09Ce8E2B3Fede2727dA4392Ea8Fe618305ba0474`
   is the shared testnet deployer whose private key sits in a local JSON file and
   is documented "Sepolia only — NEVER fund with real ETH". It must not hold real
   USDC on a mainnet. Mint a fresh key for 5042, or deploy from a Circle DCW.
2. **Deploying to a mainnet is a founder decision.** The desk-v1 ERC-8004 work is
   fail-closed to `ARC-TESTNET` on purpose, and its own doctrine says a launched
   Arc mainnet does not lift that guard without a decision in writing. Adding
   5042 to BUFI-6900 does not change desk-v1's guard, and this bucket does not
   propose changing it.

### Next action

The entitlement is the whole bucket. Ask the Arc admin to have dRPC enable Arc
for team `a39c3294-5485-433a-9abc-43d6f33987bc`, quoting the `code 35` response
above so it is not mistaken for a whitelist question. Everything else here is a
day's work once `eth_chainId` answers.
