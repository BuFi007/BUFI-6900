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
bun run deploy -- arc-testnet=<studio-slug> --version v0.1.0
```

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
