# @bufi6900/cre

**Chainlink CRE** integration surface: the workflow catalog, the gateway client, and the
attestation/evidence types. CRE is how BUFI turns an off-chain financial action into a
DON-verified, attested on-chain fact.

In this submission CRE does two jobs:

1. **Payment scoring on ERC-8004 identities** — Confidential CRE extends a workspace
   identity into a reputation/scoring signal, which is what makes a workspace discoverable
   and hireable in the agentic marketplace.
2. **Dispute and settlement for ERC-8183 job escrow** — AI reviews deliverables and a
   multi-model juror panel resolves disputes, with the outcome settled on-chain.

The DON's only write primitive is `EVMClient.writeReport()` (threshold-ECDSA consensus,
broadcast through the Chainlink forwarder). Circle SDK calls need API keys and stay
server-side; CRE verifies and attests rather than replacing execution.

## Contents

| Path | What it does |
| --- | --- |
| `src/catalog.ts` | workflow catalog (action → workflow id) |
| `src/client.ts` | gateway client |
| `src/evidence.ts` | evidence shaping |
| `src/constants.ts` | chain selectors and ids |
| `src/types/attestation.ts`, `src/types/verification.ts` | attestation + verification types |

Canonical home in desk-v1: `packages/cre`. The workflow engine itself lives in the
standalone `BuFi007/chainlink-cre` repo.

## Provenance

Extracted verbatim from the BUFI product monorepo (`BuFi007/desk-v1`) for the ETHGlobal
ETHOnline 2026 submission, so the hackathon work can be read as a standalone package.

**These sources are lifted, not re-authored.** They still import from the product
monorepo workspace (`@bu/*`, `@bufinance/*`), so this package does not build in isolation
here — it is published for review and portability. The per-file paths below are the
canonical homes; treat `desk-v1` as the source of truth.

