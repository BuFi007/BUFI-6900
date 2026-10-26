# Permit2 + real LI.FI on Arc

These fixtures are **unsigned quotes for local test accounts**, not live payments.
They were obtained through Desk's existing `createLifiSwapProvider`, using
`POST /v1/advanced/routes` followed by `POST /v1/advanced/stepTransaction` with
the original reviewed route. No second LI.FI client or broadcast path was added.

| Fixture | Block | Route ID | Delivery |
| --- | --- | --- | --- |
| `permit2-lifi-arc-swap.json` | 27993844 | `b0e195b8-78ab-491d-8f88-148303ae019d` | LI.FI → conduit → local Treasury |
| `permit2-lifi-arc-document.json` | 27992457 | `881c22a2-5013-4954-9801-ea5411d97f25` | LI.FI → frozen local document recipient |

Both quote 100 WARS → 0.312342280968221548 WBRL, with a signed minimum of
0.310780569563380440 WBRL, one top-level `fly` step and zero native value.
The actual calldata internally uses USDC. Router and allowance spender are
both `0xA4072583658Fae592A3506A42431cb6316a8d40b` for these particular routes.
Do not assume that equality for a fresh quote or register another spender implicitly.

## Reproduce without a live transaction

From `contracts/`:

```sh
forge build src/bufi/conduit/TreasuryConduitPermit2.sol script/DeployTreasuryConduitPermit2.s.sol --out out-permit2-release --cache-path cache-permit2-release
ARC_PERMIT2_FORK_RPC=https://rpc.mainnet.arc.io FOUNDRY_PROFILE=fork-arc forge test --match-path 'test/fork/agentic/TreasuryConduitPermit2*Arc.t.sol' -vv
forge build test/harness/Permit2RpcProbe.sol --out out-probe --cache-path cache-probe
bun test/harness/run-permit2-arc-rpc.mjs
```

The first suite verifies setup, real Circle 60/40 quorum, changed calldata,
expiry, insufficient approval, and incomplete quorum. It exports test-only
state under ignored `deployments/local/`.

The second stage is required: generic Anvil does not implement Arc's native
USDC transfer behavior. A control transfer via `eth_call` succeeds on Arc and
reverts on Anvil at the same block. The runner therefore applies the local test
state through **non-persistent `eth_call`**, keeping the real router and native
USDC code/state. It copies only the simulated accounts and the storage cells
actually accessed; it does not override the router or USDC. The extra read
cells are necessary because a generic fork dump omits clean storage cells used
by Circle validation.

The runtime under test is the exact Paris release runtime, hash
`0x55eb4131767006c7386b08a936071d951c1474c0016680959f8feba0a2b45b79`.
For swap, invoice and reimbursement, the runner asserts:

- actual delivery ≥ the exact signed floor;
- allowance to the router is zero after execution;
- the same original operation cannot execute again;
- a quorum-signed impossible floor fails specifically with `BelowFloor`, and
  balances, Permit2 nonce and original-operation state all roll back.

The generated `*.proof.json` explicitly marks `liveTransaction: false`.
It does not prove a deployed runtime, a production Paid transition, ledger,
outbox, receipt download, or a human signature. Those remain separate pilot gates.

## Inert deployment

`script/DeployTreasuryConduitPermit2.s.sol` accepts only Arc 5042 and the recorded
Arc Safe. It pins Permit2, Address Book and CREATE2 code hashes. It does not read
keys, register routers, grant allowances or enable any checkout profile.
Run its simulation with `--sig 'run(address)'` and the Arc Safe as the argument.
A human must authorize any eventual mainnet broadcast.

Safe configuration and application scope are independent gates. Closing new
initiations must preserve recovery. Disabling a router does not consume or
cancel an unexpired Permit2 signature; re-enabling it can restore executability.
