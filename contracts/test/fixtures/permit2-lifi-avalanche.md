# Permit2 + real LI.FI on Avalanche

Captured with Desk's existing `createLifiSwapProvider`: `POST /advanced/routes`
and `POST /advanced/stepTransaction` with the original route. No broadcast.

| Fixture | Block | Route ID | Recipient |
| --- | --- | --- | --- |
| `permit2-lifi-avalanche-swap.json` | 98627439 | `c1fc0a65-fc4f-4b9e-af8c-aa82ea4e8876` | Local test Treasury |
| `permit2-lifi-avalanche-document.json` | 98627441 | `19c4a88e-83e9-4346-94cd-7e1204fbe29b` | Local document test recipient |

Both are one-step, zero-native-value quotes: 1 USDC to 0.892468 EURC, minimum
0.888005 EURC. The captured router/spender is
`0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE`; neither its identity nor its price is
assumed for another quote. This does not register the router on a deployed conduit.

`TreasuryConduitPermit2LifiAvalanche.t.sol` exercises the real token, router and
Permit2 bytecode on a pinned local fork with test-only balances and a local
60/40 weighted Circle Treasury. It checks the exact Paris release runtime;
success/replay, insufficient quorum and below-floor rollback for swaps, invoices
and reimbursements: nine cases passed on 2026-10-26. Unlike Arc's native-USDC
export test, these Avalanche success cases actually execute the router in Forge.

Reproduce from `contracts/` using the pinned fixtures and existing release artifact:

```sh
AVAX_PERMIT2_FORK_RPC=https://api.avax.network/ext/bc/C/rpc \
  FOUNDRY_PROFILE=fork-arc forge test --offline \
  --match-path test/fork/agentic/TreasuryConduitPermit2LifiAvalanche.t.sol -vv
```

The historical `fork-arc` profile supplies the Cancun interpreter and separately
compiles Circle's vendored tree for Paris. The contract under test is loaded from
`out-permit2-release` to avoid mistaking a test-profile compilation for the release.

The prepared inactive Avalanche deployment is
`0xAeBB9c395AB6D627Eb0deFc3b16E7f49dc30C19F`, owned by Avalanche's Safe
`0xA3a40fa2d82C0224c40b1Ed7E07cb474B7D1468B`. Its CREATE2 initializer differs
from Arc's because the Safe differs. The wrapper runtime remains the same;
the underlying Permit2 runtime hash is chain-specific. This fixture is not proof
that deployment, a real payment or canonical document finalization has occurred.
