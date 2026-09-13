# @bufi6900/ens

**ENSv2 workspace naming.** During workspace setup BUFI distinguishes a collective
workspace wallet from a personal wallet by name as well as by colour, so an operator can
never mistake one for the other. Names are **face-first**:

```
agent.<workspace>.bufi.eth                     the agent FACE
mcp|webmcp|x402.agent.<workspace>.bufi.eth     discovery faces beneath it
```

### Honest limits, stated up front

ENSv2 is **Sepolia beta only**. `bufi.eth` is registered there and that confers **zero
mainnet rights**; on mainnet the name is expired and available. The Sepolia ENSv2 registry
is wiped roughly monthly, so the name is a lease with a re-registration race, never an
anchor. Names are therefore stored as **preview** rows and a product string is only shown
once minted. A name is never rendered unless the server resolved it itself.

## Contents

| Path | Canonical home in desk-v1 | What it does |
| --- | --- | --- |
| `src/types/ens-name.ts` | `packages/api-types/src/ens-name.ts` | the face-first name shapes |
| `src/types/wallet-tags.ts` | `packages/api-types/src/wallet-tags.ts` | wallet tag wire types |
| `src/ens-display.ts` | `packages/utils/src/ens-display.ts` | display/truncation rules |
| `src/db/queries-ensv2-preview.ts` | `packages/supabase/src/queries/ensv2-preview.ts` | preview registry reads |
| `src/db/mutations-ensv2-preview.ts` | `packages/supabase/src/mutations/ensv2-preview.ts` | preview registry writes (service-role only, globally unique name) |
| `src/ui/bufi-name.tsx` | `apps/app/src/components/wallets/bufi-name.tsx` | the name chip |
| `src/ui/bufi-handle-row.tsx` | `apps/app/src/components/wallets/bufi-handle-row.tsx` | the handle row |

## Provenance

Extracted verbatim from the BUFI product monorepo (`BuFi007/desk-v1`) for the ETHGlobal
ETHOnline 2026 submission, so the hackathon work can be read as a standalone package.

**These sources are lifted, not re-authored.** They still import from the product
monorepo workspace (`@bu/*`, `@bufinance/*`), so this package does not build in isolation
here — it is published for review and portability. The per-file paths below are the
canonical homes; treat `desk-v1` as the source of truth.

