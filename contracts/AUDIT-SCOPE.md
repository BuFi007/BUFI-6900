# Audit scope — plan 398 production freeze

Frozen code: branch `freeze/plan-398-production-grade`, commit
`73305571f32cc9adedc6b1315ad740aa7ac767fc`. Any later commit that touches a file below
re-opens the freeze. Audit fixes ship as new deployments: every in-scope contract is
immutable, with no proxy and no upgrade path.

## Toolchain

| Setting   | Value                                                      |
| --------- | ---------------------------------------------------------- |
| Compiler  | solc **0.8.24**, pragma pinned exactly in every file below |
| EVM       | `paris`                                                    |
| Optimizer | on, 200 runs, `via_ir = true`                              |
| OZ        | `lib/openzeppelin-contracts` @ `dbb6104c` (v5.0.0+12)      |
| Build     | `forge build`, `forge test` (default profile, 479 tests)   |

## In-scope files

| File (under `contracts/`)                           | git blob   |
| --------------------------------------------------- | ---------- |
| `src/bufi/conduit/TreasuryConduit.sol`              | `93ee8393` |
| `src/bufi/conduit/TreasuryRedeemConduit.sol`        | `2efd62e7` |
| `src/bufi/conduit/TreasurySwapAndDeposit.sol`       | `770136d0` |
| `src/bufi/conduit/interfaces/IFiatTokenV2.sol`      | `898caa28` |
| `src/bufi/v0.7/earn/BufiEarnModule.sol`             | `11cb0237` |
| `script/config/BufiDeployConfig.sol` (+ `BufiDeployBase.sol`, `BufiInitCodes.sol`) | deploy config |
| `script/DeployTreasuryConduit.s.sol`, `DeployTreasuryEarn.s.sol`, `DeployTreasurySwapAndDeposit.s.sol`, `DeployBufiPlugins.s.sol` | deploy procedure |

The scripts are in scope because they decide the owner. A contract is only as safe as
the address that ends up owning it.

## Ownership model

Every privileged contract uses OpenZeppelin `Ownable2Step`. The final owner is the
chain's Safe, taken from `BufiDeployConfig` and from nowhere else:

| Chain             | Chain id | Safe                                         |
| ----------------- | -------- | -------------------------------------------- |
| Arc mainnet       | 5042     | `0x47Dc7D18A6E3a79F696714E7D47456a49B430D09` |
| Avalanche C-Chain | 43114    | `0xA3a40fa2d82C0224c40b1Ed7E07cb474B7D1468B` |
| Arc testnet       | 5042002  | `0xA3a40fa2d82C0224c40b1Ed7E07cb474B7D1468B` |

CREATE2 init code always carries the same **bootstrap owner**, the shared deployer
`0x09Ce8E2B3Fede2727dA4392Ea8Fe618305ba0474`. Identical init code yields an identical
address on every chain (Arachnid proxy `0x4e59…956C`). The bootstrap key is a
transient owner. It holds no role once the Safe accepts.

### Privileged functions

| Contract               | Owner-only (Safe)                                                                | Other entry points                                                                                                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TreasuryConduit        | `setTarget(target, allowed)` (refuses 0), `rescue(token, to)` (refuses 0, emits `Rescued`), `transferOwnership` | `execute` is permissionless. Funds move only on the treasury quorum's ERC-3009 signature, whose nonce commits to the whole intent. The target must be registered. |
| TreasuryRedeemConduit  | `setVault(vault, allowed)` (refuses 0), ownership                                | `redeem` is permissionless. It needs the treasury's ERC-1271 quorum signature over the EIP-712 `Redeem`, and each per-treasury nonce works once.                                    |
| TreasurySwapAndDeposit | `setVenue`, `setDest` (both refuse 0), ownership                                 | `run` is permissionless. It pulls only from `msg.sender`, which is the conduit in production.                                                                                        |
| BufiEarnModule         | `addAuthorizedRelayer` (refuses 0), `removeAuthorizedRelayer`, `setConfig`, ownership | `autoEarn` passes the account's runtime validation only for **explicitly authorized relayers**. The owner is no longer an implicit relayer. `changeConfigHash` passes only through the account's multisig userOp validation. |

`renounceOwnership` is **disabled** on all four contracts (founder, 2026-10-08). It is
overridden to always revert `RenounceDisabled()`, for the owner and for anyone else, and
it does not clear a pending handover. Ownership only moves through
`transferOwnership` + `acceptOwnership`. Tests:
`test/bufi/v0.7/conduit/ConduitGovernanceGuards.t.sol` (`test_renounceOwnership_*`).

## CREATE2 salts and planned addresses

Salts are explicit constants in `BufiDeployConfig.sol` (founder, 2026-10-08):

| Contract               | Salt label                       | Planned address (every chain)                 |
| ---------------------- | -------------------------------- | --------------------------------------------- |
| TreasuryConduit        | `bufi.treasury-conduit.v3`       | `0x11dd7b556252511c41A757dF9Ed07b91C55ba6Fa`  |
| TreasuryRedeemConduit  | `bufi.treasury-redeem-conduit.v3`| `0xd3b10924c960F422D440a8b1Da2c29B53E5AD3BA`  |
| TreasurySwapAndDeposit | `bufi.treasury-swap-deposit.v3`  | `0x7D1fEE47b5A471372019AB3461d5f73DC46b5e8a` on both Arc chains (USDC `0x3600…` is immutable in the init code; another chain's USDC gives another address) |
| BufiEarnModule         | `bufi.earn-module.v3`            | depends on the relayer (init-code argument); `0xfdD32587bA9F47aF98cb1e901a82C8eC53345A73` is the DRY-RUN address for placeholder relayer `0x…5EED01` only |

The whole conduit family moved to `.v3` together, so no frozen contract can be confused
with a pre-freeze deployment (live v2 conduit `0xA981…15e7`, v1 redeem `0x3613…D06A`).
BufiEarnModule got its own label instead of sharing `PLUGIN_SALT`
(`bufi-6900-plugins-v0.2.0`), so the two unchanged stateless plugins
(`BufiSessionKeyPlugin` `0xBd60…5339`, `BufiSessionRecipientHookPlugin` `0xfc02…f381`)
keep their addresses.

## Earn relayer

`EARN_MODULE_RELAYER` is required and has no default; the script refuses zero, the
bootstrap deployer and the Safe. **The production relayer is one Circle
developer-controlled wallet (DCW) EOA**, created in the live Circle entity by the
founder or ops, and the SAME address is used on every chain. The relayer is part of the
module's init code, so one relayer everywhere is what makes the module's address
identical across chains. It is never the deployer and never the Safe. The Safe can
rotate it later (`addAuthorizedRelayer` / `removeAuthorizedRelayer`) without moving the
module. The DCW does not exist yet; until it does, the module's production address is
not known.

## Arc mainnet (5042) swap venues — evidence, 2026-10-08

Registered only when a real quote targets the address and it has code on
`https://rpc.mainnet.arc.io`:

| Venue          | Address                                      | Code     | Evidence | Registered |
| -------------- | -------------------------------------------- | -------- | -------- | ---------- |
| LI.FI LiFiDiamond | `0xA4072583658Fae592A3506A42431cb6316a8d40b` | 254 B (EIP-2535 proxy) | live `li.quest/v1/quote` 10 USDC → EURC (`0x3600…` → `0xbEf5…21c1`) on 5042: `transactionRequest.to` = `approvalAddress` = this address, tool `kyberswap`, selector `0x5fd9ae2e`; `li.quest/v1/chains` lists it as Arc's `diamondAddress` | yes — conduit target + SwapAndDeposit venue |
| Uniswap Universal Router | `0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1` | 24546 B | listed in Uniswap's v4 deployments page ("Arc: 5042"). No quote: the Trading API needs a key (`401` keyless) | **no** — unconfirmed |
| Uniswap Universal Router 2.1.2 | `0x8702463e73f74d0b6765aBceb314Ef07aCb92650` | 24380 B | same page; same caveat | **no** — unconfirmed |
| Circle App Kit | — | — | not a mainnet swap venue: desk routes same-chain Arc mainnet swaps Uniswap first, LI.FI second. `0x7FB8…a845` (813 B) is Circle's Earn+Borrow adapter | no (the old placeholder is removed) |

Permit2 `0x0000…78BA3` has code (9152 B) on 5042. A Uniswap router is added later by a
Safe `setTarget` / `setVenue` once a keyed Trading API quote (desk sends
`x-universal-router-version: 2.0`) names it. Until a second venue exists, desk keeps
Arc-mainnet treasury SWAPS off (`hasRegisteredUniswapAndLifiTargets` needs two); Earn is
unaffected.

## Deploy procedure

1. **Simulate.** Run each script with `--fork-url <rpc> --sender 0x09Ce…0474` and
   without `--broadcast`. `script/SimulateFreezeWave.s.sol` rehearses the whole wave
   in one process, plays the Safe's accept, and refuses `--broadcast`.
2. **Bootstrap.** Broadcast as the bootstrap deployer, in this order:
   `DeployTreasuryConduit`, then `DeployTreasuryEarn`, then
   `DeployTreasurySwapAndDeposit`, then `DeployBufiPlugins`. The plugins script needs
   `EARN_MODULE_RELAYER`, the production Circle DCW relayer (see "Earn relayer"), which
   must be neither the deployer nor the Safe. Each script:
   1. CREATE2-deploys the contract with the bootstrap owner. This step is idempotent.
   2. Registers the chain's targets, venues, dests and vaults while the bootstrap key
      still owns it.
   3. Calls `transferOwnership(SAFE[chainid])` and **asserts
      `pendingOwner() == SAFE[chainid]`**.
   4. Prints the Safe transaction that finishes the handover: `to = <contract>`,
      `value = 0`, `data = 0x79ba5097` (`acceptOwnership()`).

   A chain id that is missing from the config reverts with `UnsupportedChain`. A Safe
   with no code reverts with `SafeHasNoCode`. A contract owned by anyone else reverts
   with `UnexpectedOwner`.
3. **Accept.** The Safe executes `acceptOwnership()` on each contract.
4. **Done** only when `owner()` reads back as the Safe and the row in desk-v1
   `contracts/deployments.json` records the tx hash, the owner and the audit status.
   After this, a re-run prints any owner call as a Safe transaction instead of sending
   it.

## Known non-goals

- Not in scope: `TreasuryEarnVault`, the testnet-only, ownerless 1:1 canary vault;
  `BufiSessionKeyPlugin`; `BufiSessionRecipientHookPlugin`; `GatewayTreasury` and the
  gateway guard; everything under `src/bufi/v0.8/`; vendored Circle, OZ and ERC-6900
  code in `lib/`.
- Out of this repo: the desk claim vault and MemoConduit.
- The conduit's target registry is defense in depth. It is not the authorization. The
  quorum signs the exact calldata, and a registered target is trusted with the
  `amountIn` approval for the length of the call.
- Safe threshold and signer hygiene. The Safes are 1-of-1 today, and the founder is
  moving them to 2-of-3.
- Relayer key custody for `BufiEarnModule` beyond the decision above: the Circle DCW is
  custodied by Circle's entity secret, outside this repo.
