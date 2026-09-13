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

Tests ship alongside each module. The graph these read is `packages/subgraph-arc` in this
repo — BUFI's own Arc subgraph (identity + reputation + commerce on one graph, with the
workspace joins, verified ratings, `Job.settled` and the `bufi.score.v1` attestation).
Refreshed 2026-09-13 to the BUFI schema.

## Provenance

Extracted verbatim from the BUFI product monorepo (`BuFi007/desk-v1`) for the ETHGlobal
ETHOnline 2026 submission, so the hackathon work can be read as a standalone package.

**These sources are lifted, not re-authored.** They still import from the product
monorepo workspace (`@bu/*`, `@bufinance/*`), so this package does not build in isolation
here — it is published for review and portability. The per-file paths below are the
canonical homes; treat `desk-v1` as the source of truth.

