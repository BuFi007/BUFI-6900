# BUFI-6900 — audit + launch readiness buckets

Assessed 2026-09-02 against `main`. Every claim below is anchored on a file, a
command, or an RPC response. Where evidence is missing the row says so rather
than guessing.

**Verdict: not ready to submit.** Buckets 1–3 block the audit package. Bucket 4
blocks the launch claim and is gated on an external party, so it starts now.

| # | Bucket | Score | Blocks | Owner action |
|---|---|---|---|---|
| 1 | Scope definition & provenance | 70% | audit submission | rewrite two docs |
| 2 | Test evidence (coverage + gas) | 65% | audit submission | isolate v0.8 compile profile |
| 3 | Deployment & explorer verification | 45% | audit submission | deploy hook, verify 3 contracts |
| 4 | **Arc private mainnet validation** | **10%** | **launch claim** | **unblock dRPC entitlement** |

---

## 1. Scope definition & provenance — 70%

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

## 2. Test evidence — 65%

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

## 3. Deployment & explorer verification — 45%

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
