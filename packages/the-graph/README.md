# @bufi6900/the-graph

Arc and EVM subgraph access for the agentic workspace marketplace: **ERC-8004** workspace
identity and reputation, and **ERC-8183** job escrow. This is the read side that keeps the
"Behance meets Fiverr" agentic workspace directory in sync, and the source the MCP surface
and the reputation scoring read from.

## Contents

| Path | Canonical home in desk-v1 | What it does |
| --- | --- | --- |
| `src/thegraph/client.ts` | `packages/blockchain-data/src/thegraph/client.ts` | The Graph gateway client |
| `src/thegraph/erc8004.ts` | `packages/blockchain-data/src/thegraph/erc8004.ts` | identity + reputation reads |
| `src/thegraph/erc8183.ts` | `packages/blockchain-data/src/thegraph/erc8183.ts` | job-escrow reads |
| `src/thegraph/ids.ts` | `packages/blockchain-data/src/thegraph/ids.ts` | subgraph id helpers |
| `src/env/thegraph.ts` | `packages/env/src/thegraph.ts` | endpoint + key resolution |
| `src/erc8004-registration.ts` | `packages/utils/src/erc8004-registration.ts` | the inline `data:` registration document every BUFI identity carries |
| `src/base64.ts` | `packages/utils/src/base64.ts` | portable base64 used by the document builder |
| `src/reputation.ts` | `packages/api-types/src/reputation.ts` | reputation wire types |

Tests ship alongside each module (`bun test packages/the-graph/src` — 59 pass). The graph
these read is `packages/subgraph-arc` in this repo — BUFI's own Arc subgraph (identity +
reputation + commerce on one graph, with the workspace joins, verified ratings,
`Job.settled` and the `bufi.score.v1` attestation).

## Verified against the live index, 2026-09-14

Read from the deployed subgraph at the Arc testnet chain head, with **no gateway key set**:

- job `182422` — `COMPLETED`, `settled: true`, and its six indexed events carry exactly the
  transaction hashes the product recorded when it ran the job
- agent `888210` ("Nice Team") — serving its inline `data:` registration document
- a resolved `Engagement` between two workspaces, with job count and settled volume

## Two things worth copying, not just reading

**The key is for the gateway, not for every read.** `queryTheGraph` asks for
`GRAPH_GATEWAY_API_KEY` only when the URL is the decentralised gateway
(`subgraphQueryUrlNeedsApiKey`). A Subgraph Studio endpoint serves without one, and
demanding it everywhere threw before the request in the one environment that deliberately
holds no key.

**Never select `registration { … }` without `registration_not: null`** or an inline fragment
on `AgentRegistration`. The interface field errors at the store when null and the gateway
reports it as "bad indexers", which sends you looking for an infrastructure fault that is
really a query shape.

## Provenance

Extracted verbatim from the BUFI product monorepo (`BuFi007/desk-v1`) for the ETHGlobal
ETHOnline 2026 submission, so the hackathon work can be read as a standalone package.

**These sources are lifted, not re-authored.** They still import from the product
monorepo workspace (`@bu/*`, `@bufinance/*`), so this package does not build in isolation
here — it is published for review and portability. The per-file paths below are the
canonical homes; treat `desk-v1` as the source of truth.

