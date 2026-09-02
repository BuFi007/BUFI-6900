# Licensing — `contracts/`

`LICENSE` here is GPL-3.0-or-later, which covers most of this tree. **It is not uniform.** Two files carry a
different license, inherited from the upstream they were ported from, and the per-file `SPDX-License-Identifier`
header is authoritative:

| File | License |
| --- | --- |
| `src/bufi/v0.7/earn/BufiEarnModule.sol` | **AGPL-3.0-only** (port of fluidkey/fluidkey-earn-module) |
| `src/bufi/v0.7/session/libraries/PluginStorageLib.sol` | **MIT** (verbatim from alchemyplatform/modular-account) |

AGPL-3.0 adds a network-source obligation that GPL-3.0 does not. If you are integrating, read `../LICENSING.md`
before assuming one license covers all three plugins — it does not, and the two non-AGPL plugins are separately
deployable.

Everything under `lib/` keeps its own upstream license, unmodified.
