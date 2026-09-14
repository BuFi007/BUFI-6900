# @bufi6900/subgraph-arc

BUFI's own subgraph on Arc: the ERC-8004 identity and reputation registries and
Circle's ERC-8183 agentic-commerce escrow indexed on ONE graph, so a workspace,
the jobs it settled and the ratings it earned join without a second query.

What is BUFI logic on top of the standard entities (plan 342, §1b):

- `WalletBinding` — agent wallet address → `Agent`, from the `agentWallet`
  metadata key. It is the join between an ERC-8183 party address and a
  workspace identity.
- `Job.clientAgent` / `Job.providerAgent`, `Job.settled` — a job counts as a
  settlement only when it completed AND the provider was paid; a refund never
  does.
- `Feedback.verified` / `Feedback.evidence` — a rating is verified when the
  rater's wallet had already settled a job with the rated workspace; the
  evidence is that job. Unverified ratings stay visible, flagged.
- `Engagement` — the reputation-graph edge between two workspaces: jobs,
  settled volume, refunds, ratings.
- `Agent.bufiScore*` — the `bufi.score.v1` payment-score attestation
  (`{v,d,s,h}`) written by the workspace's own wallet, decoded.
- `AgentMetricPoint` / `AgentDailyMetric` — settled and refunded volume per
  workspace per day.

Everything else (registration document parsing, feedback documents,
timeseries feedback stats) is adapted from Space Object's hackathon
`erc-8004-subgraph` and `erc-8183-subgraph`, used with their permission, with
the ERC-8183 side re-cut to the events Circle's Arc implementation actually
emits (verified ABIs in `abis/`).

## Commands

```sh
bun run chain-config   # regenerate chain.config.json from @bu/contracts + @bu/env
bun run build          # codegen + build for arc-testnet
bun run test           # matchstick
bun run deploy -- arc-testnet=<studio-slug> --version v0.1.0

# Resume a fixed index instead of re-syncing from the start blocks:
bun run deploy -- arc-testnet=<studio-slug> --version v0.1.1 \
  --graft QmBaseDeployment…:<last good block>
```

`--graft` copies the base deployment's state up to that block — hours saved when a
handler fix only has to reprocess what came after it. Use it for Studio; a version
published to the network should be a clean sync.

## Two things that will bite

**Clamp every timestamp that comes from an event param.** `BigInt.toI64()` checks
only bytes 8 and up for sign padding, so a `uint256` of uint64 max returns **-1**,
and graph-node refuses a negative `Timestamp` deterministically — the index stops
and never restarts. Our first deployment halted exactly this way on a stranger's
job on Circle's shared escrow (`expiredAt` = 18446744073709551615, an idiom for
"never expires"). `src/shared/timestamp.ts` is the clamp; block timestamps are
never suspect.

**Subgraph Studio does not expose `indexingStatuses`.** When an index halts there
is no error text to read (404 on every documented host). Diagnose by decoding the
first logs after the frozen `_meta.block.number` with these ABIs.

## Consumers must not pin a version url

Read `.../<slug>/version/latest`, not `.../<slug>/v0.1.0`. A pinned consumer stays
on a halted index even after the fix ships.

`graph auth <deploy key>` once per machine (Subgraph Studio → the subgraph →
Deploy key). The typed client that reads this graph is `packages/the-graph` in
this repo (canonical home: `@bu/blockchain-data/thegraph` in desk-v1). This
package builds standalone here: `bun install` at the repo root, then the
commands above.

## License

BUFI additions (`src/bufi/`, `src/commerce/`, schema additions marked "BUFI:",
scripts) are GPL-3.0-or-later like the rest of this repository. The identity
and reputation mappings, the registration/feedback document parsers and the
shared utils are adapted from Space Object's ETHGlobal hackathon subgraphs,
which carry no license file; they are included with the authors' permission,
granted to BUFI's founder on 2026-09-13.
