# Licensing

This repository is **not uniformly licensed**, because three of the four in-scope contracts are ports and each
carries its upstream's terms. That is deliberate and required — but it has a consequence for integrators that is
easy to miss, so it is stated here rather than left to be discovered.

## Per-component

| Path | License | Why |
| --- | --- | --- |
| `contracts/src/bufi/v0.7/session/**` | **GPL-3.0-or-later** | Port of alchemyplatform/modular-account v1.0.1 (GPL-3.0). |
| `contracts/src/bufi/v0.7/session/libraries/PluginStorageLib.sol` | **MIT** | Carried verbatim from upstream, which licenses it MIT. |
| `contracts/src/bufi/v0.7/recipient-hook/**` | **GPL-3.0-or-later** | New BUFI code. |
| `contracts/src/bufi/v0.8/gateway/**` | **GPL-3.0-or-later** | New BUFI code. |
| `contracts/src/bufi/v0.7/earn/BufiEarnModule.sol` | **AGPL-3.0-only** | Port of fluidkey/fluidkey-earn-module, which is AGPL-3.0-only. |
| `packages/modular-wallets-core`, `packages/msca-recovery` | **Apache-2.0** | Forks of Circle's SDKs, which are Apache-2.0. |
| `packages/mock-circle`, repo root | **GPL-3.0-or-later** | New BUFI code. |
| `packages/subgraph-arc` (`src/bufi/**`, `src/commerce/**`, `scripts/**`, BUFI schema additions) | **GPL-3.0-or-later** | New BUFI code. |
| `packages/subgraph-arc` (`src/identity/**`, `src/shared/**`, document parsers) | **Used with permission** | Adapted from Space Object's ETHGlobal hackathon subgraphs, which ship no license file; permission granted to BUFI's founder 2026-09-13. Not redistributable under this repo's GPL on their own — treat as permissioned third-party code. |

Root `LICENSE` is GPL-3.0-or-later. The Apache-2.0 packages carry their own `LICENSE`. Per-file `SPDX-License-Identifier`
headers are authoritative where they differ.

## The consequence worth knowing before you integrate

**`BufiEarnModule` is AGPL-3.0-only, and the other two v0.7 plugins are not.**

AGPL-3.0 §13 adds an obligation the GPL does not have: if you modify the module and let users interact with it
over a network, you must offer those users the corresponding source. GPL-3.0-or-later carries no such clause.

Practically, for anyone building on these:

- Installing `BufiSessionKeyPlugin` or `BufiSessionRecipientHookPlugin` carries **no network-source obligation**.
- Installing `BufiEarnModule` — or linking it into a combined work — pulls the whole combined work under AGPL,
  because AGPL-3.0 is the stronger term and a combined work takes it.

This is inherited from Fluidkey and cannot be relicensed by us. It is called out because the three plugins are
otherwise presented as a set, and an integrator could reasonably assume one license covers all of them. If a
distributor needs the session-key and recipient-hook plugins without AGPL exposure, they are separately deployable
contracts with no dependency on the earn module — installing one does not require the others.

## Third-party

Vendored dependencies keep their own licenses under `contracts/lib/**`, unmodified. `docs/AUDIT-SCOPE.md` lists
which of them are in scope for review and which are out.
