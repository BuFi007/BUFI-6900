# Audit scope — plan 398 production freeze

Frozen code: branch `freeze/plan-398-production-grade`, commit
`2626210fd7d346a7f65ce243e30720aa55ba70de`. Any later commit that touches a file below
re-opens the freeze. Audit fixes ship as new deployments: every in-scope contract is
immutable, with no proxy and no upgrade path.

## Toolchain

| Setting   | Value                                                      |
| --------- | ---------------------------------------------------------- |
| Compiler  | solc **0.8.24**, pragma pinned exactly in every file below |
| EVM       | `paris`                                                    |
| Optimizer | on, 200 runs, `via_ir = true`                              |
| OZ        | `lib/openzeppelin-contracts` @ `dbb6104c` (v5.0.0+12)      |
| Build     | `forge build`, `forge test` (default profile, 492 tests)   |

## In-scope files

| File (under `contracts/`)                           | git blob   |
| --------------------------------------------------- | ---------- |
| `src/bufi/conduit/TreasuryConduit.sol`              | `93ee8393` |
| `src/bufi/conduit/TreasuryRedeemConduit.sol`        | `2efd62e7` |
| `src/bufi/conduit/TreasurySwapAndDeposit.sol`       | `770136d0` |
| `src/bufi/conduit/interfaces/IFiatTokenV2.sol`      | `898caa28` |
| `src/bufi/v0.7/earn/BufiEarnModule.sol`             | `e11bff48` |
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
| BufiEarnModule         | `setConfig` (publish a vault set to the global, content-addressed registry), ownership. **Nothing else**: the owner cannot name, rotate or remove any account's relayer and cannot change any account's adopted config | `autoEarn` passes the account's runtime validation only for **that account's own relayer** (`relayerOf[account]`, set by the account at install). `changeConfigHash` and `setRelayer` pass only through the account's multisig userOp validation; at runtime both are fail-closed. |

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
| BufiEarnModule         | `bufi.earn-module.v3`            | `0x42259a0414365e3B37339F8b92bf536B31BEF151` on every chain (init code = creation code ++ `BOOTSTRAP_OWNER`; no relayer argument). Manifest hash `0x2706313a050574f3dd757c020fa0dfbf5373855845818b5e640b51295b9528b2` |

The whole conduit family moved to `.v3` together, so no frozen contract can be confused
with a pre-freeze deployment (live v2 conduit `0xA981…15e7`, v1 redeem `0x3613…D06A`).
BufiEarnModule got its own label instead of sharing `PLUGIN_SALT`
(`bufi-6900-plugins-v0.2.0`), so the two unchanged stateless plugins
(`BufiSessionKeyPlugin` `0xBd60…5339`, `BufiSessionRecipientHookPlugin` `0xfc02…f381`)
keep their addresses.

## Earn relayer — per account (founder, 2026-10-08)

There is **no global BUFI relayer**. Each account's relayer is that team's **agent Circle
DCW** on that chain, set at install by the account. The module has no constructor relayer,
no `authorizedRelayers` set and no `addAuthorizedRelayer` / `removeAuthorizedRelayer`.

- **Set at install.** `pluginInstallData = abi.encode(uint256 configHash, address relayer)`.
  `onInstall` stores `relayerOf[account] = relayer` (zero refused) and emits
  `RelayerSet(account, relayer)`. Installing is a userOp under the account's own owners'
  quorum, so the treasury itself authorizes its relayer. The pre-398 one-word install data
  no longer decodes.
- **Changed only by the account.** `setRelayer(address)` is an execution function routed
  through the account's fallback (`msg.sender == account`), bound to the same owner
  dependency slots as `changeConfigHash`: userOp → weighted owner validation (threshold),
  runtime → weighted id 1, fail-closed for everyone (the current relayer, the module owner,
  any owner EOA). Zero refused. `RelayerSet` emitted.
- **Cleared on uninstall.** `onUninstall` deletes `relayerOf[account]` and emits
  `RelayerSet(account, 0)`; a reinstall must name a relayer again.
- **Confined to its account.** `runtimeValidationFunction` checks
  `sender == relayerOf[msg.sender]`, and `msg.sender` there is the account being validated.
  `autoEarn` only ever acts on `msg.sender`. There is no path where one account's relayer acts
  on another account. Tests: `test_eachRelayerActsOnlyOnTheAccountThatNamedIt`,
  `test_runtimeValidationIsKeyedOnTheCallingAccount` (mock), and
  `test_twoAccounts_eachRelayerIsConfinedToItsOwnAccount` (two real weighted MSCAs).
- **Vault and amount limits stay treasury-governed.** The vault set is still an
  owner-published (`setConfig`), account-adopted (`changeConfigHash`, quorum) config;
  `autoEarn` is still deposit-only with shares minting to the account and the F-06
  before/after checks. The relayer chooses timing and amount, nothing else.

**Custody, stated plainly.** BUFI holds the agent DCW key (Circle entity secret). This change
improves **isolation and attribution** — a leaked or misbehaving relayer reaches one
team's account, and every sweep is attributable to that team's DCW — **not custody**: BUFI
can still trigger `autoEarn` on any account it provisions a DCW for. The blast radius of that
key stays what it was: deposits into the account's own adopted vaults, never a transfer out.

**Owner powers left on BufiEarnModule:** `setConfig` (the registry is global and
content-addressed: a new vault set produces a new hash that no account uses until its quorum
adopts it) and the two-step ownership transfer. `renounceOwnership` still reverts
`RenounceDisabled()`.

**F-07 interaction (known, accepted).** A miswired owner dependency slot (session-key plugin
in slot 1) would let a session key call `setRelayer` as well as `changeConfigHash`. The
consequence stays a deposit-timing nuisance — the relayer can only `autoEarn` into the
adopted vaults — and the control stays the installer emitting the weighted validator.

### What desk must send at install

`installPlugin(plugin, manifestHash, pluginInstallData, dependencies)` as a **quorum-signed
treasury userOp**, per chain:

| Field | Value |
| ----- | ----- |
| `plugin` | `0x42259a0414365e3B37339F8b92bf536B31BEF151` (all chains) |
| `manifestHash` | `0x2706313a050574f3dd757c020fa0dfbf5373855845818b5e640b51295b9528b2` |
| `pluginInstallData` | `abi.encode(uint256 configHash, address relayer)` — `relayer` = the team's agent DCW address **on this chain** (`getTeamAgentWalletOnChain(teamId, blockchain).wallet_address`), never a shared BUFI address, never zero |
| `dependencies` | `[FunctionReference(weightedPlugin, 1), FunctionReference(weightedPlugin, 0)]` |

Desk's current helper (`packages/circle/src/modular/earn-module.ts`) is stale on three
counts and must not be used against this module as is: `buildEarnModuleInstallData` encodes
`configHash` alone, `installEarnModule` passes an empty dependency array (the module
requires two slots → `InvalidPluginDependency`), and it submits the install as a DCW
contract execution rather than a treasury quorum userOp. `getEarnModuleRelayerAddress`
(`CIRCLE_EARN_MODULE_RELAYER_ADDRESS`) is obsolete. Note:
desk-v1 `tasks/notes/2026-10-08-earn-module-per-account-relayer.md`.

## Arc mainnet (5042) swap venues — evidence, 2026-10-08

Every venue has code on `https://rpc.mainnet.arc.io` and is registered twice by the
bootstrap key before the Safe handover: `TreasuryConduit.setTarget` and
`TreasurySwapAndDeposit.setVenue`. `SimulateFreezeWave` on an Arc mainnet fork asserts both
for each and ends with `pendingOwner == Safe 0x47Dc…0D09` on all four contracts.

| Venue | Address | Code | Evidence | Registered |
| ----- | ------- | ---- | -------- | ---------- |
| LI.FI LiFiDiamond | `0xA4072583658Fae592A3506A42431cb6316a8d40b` | 254 B (EIP-2535 proxy) | live `li.quest/v1/quote` 10 USDC → EURC (`0x3600…` → `0xbEf5…21c1`) on 5042: `transactionRequest.to` = `approvalAddress` = this address, tool `kyberswap`, selector `0x5fd9ae2e`; `li.quest/v1/chains` lists it as Arc's `diamondAddress` | yes |
| Circle App Kit adapter | `0x7FB8c7260b63934d8da38aF902f87ae6e284a845` | 813 B TransparentUpgradeableProxy; EIP-1967 impl `0x3d99dd2ad6a35bc0e7d04cd14f57743a8cc82dd8` (17729 B), admin `0xb07796fe75f32d7057ade0701e4a817268076da7` | SDK source: `ADAPTER_CONTRACT_EVM_MAINNET` is Arc 5042's `kitContracts.adapter` in `@circle-fin/app-kit` 1.16.0, `adapter-viem-v2` 1.19.0, `provider-stablecoin-service-swap` 1.6.1, `swap-kit` 1.7.1. The EVM `swap.execute` action builds `execute(executeParams, tokenInputs, signature)` with `address: kitContracts.adapter`, and the provider approves that address as spender. Testnet counterpart `ADAPTER_CONTRACT_EVM_TESTNET` = `0xBBD7…d40b`, already registered. The route's hops (LiFiDiamond, Synthra, …) are called by the adapter, not by the conduit. **Correction:** 7330557 called this an Earn+Borrow adapter. It is the one multipurpose Kit adapter, and swaps go through it too. | yes (founder: "App Kit should work") |
| Uniswap Universal Router 2.1.2 | `0x8702463e73f74d0b6765aBceb314Ef07aCb92650` | 24380 B; `poolManager()` = `0x8366a39CC670B4001A1121B8F6A443A643e40951` (the docs' Arc v4 PoolManager) | Trading API "Supported Chains" lists it as Arc's Universal Router 2.1.2 address. It is the API default when no `x-universal-router-version` header is sent. The page says Arc has **no 2.0 deployment**, so a 2.0 request "returns an error". Notice "Sunset of Universal Router 2.0 and 2.1.1" (posted 2026-09-21, effective 2026-10-21): after that date, pinning 2.0 or 2.1.1 errors on every chain. No live quote yet: a keyed USDC→EURC quote returned `404 NoRouteFoundError` because no pool exists | yes (founder decision: register before a pool exists) |
| Uniswap Universal Router (older) | `0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1` | 24546 B; same `poolManager()` | listed on the v4 deployments page. Arc has no 2.0 deployment, so this is the pre-2.1.2 router, which the API stops routing to on 2026-10-21 | **no**. Registering it widens the target set for no route |

Permit2 `0x0000…78BA3` has code (9152 B) on 5042.

**Desk blocker (not a contract issue):** desk `packages/swap/src/providers/uniswap-http.ts`
sends `x-universal-router-version: 2.0`. On Arc that header is an error today. On every
chain it is an error from 2026-10-21. Desk must move to `2.1.2` (or drop the header)
before Uniswap can route on Arc at all. That move needs calldata-parsing changes per
Uniswap's sunset notice.

**Desk gate:** `hasRegisteredUniswapAndLifiTargets(5042)` counts conduit targets in desk's
`DEFAULT_TREASURY_CONDUIT_TARGETS[5042]` that are neither an Earn vault nor a swap-deposit
adapter, and requires at least two. It does not check which venues they are. This config
gives three (App Kit, LI.FI, Uniswap), so the gate is satisfied once desk lists them.
Desk must list them only after the v3 conduit is deployed and the Safe accepts it, and
desk must repoint `TREASURY_CONDUIT_ADDRESS` to the v3 address in the same change. Desk
today points at the v2 conduit `0xA981…15e7`, which has none of these targets on 5042. If
desk listed them now, a quorum would sign a call the contract rejects.

## Deploy procedure

1. **Simulate.** Run each script with `--fork-url <rpc> --sender 0x09Ce…0474` and
   without `--broadcast`. `script/SimulateFreezeWave.s.sol` rehearses the whole wave
   in one process, plays the Safe's accept, and refuses `--broadcast`.
   On 2026-10-08 (commit `2626210`) it ran on Arc testnet (blockdaemon RPC) and Arc mainnet
   (`rpc.mainnet.arc.io`) forks: `BufiEarnModule deployed 0x4225…F151`, `pendingOwner ==
   Safe` (`0xA3a4…468B` / `0x47Dc…0D09`), then `owner == Safe` after the pranked accept.
2. **Bootstrap.** Broadcast as the bootstrap deployer, in this order:
   `DeployTreasuryConduit`, then `DeployTreasuryEarn`, then
   `DeployTreasurySwapAndDeposit`, then `DeployBufiPlugins`. No script takes a relayer:
   each account names its own at install (see "Earn relayer"). Each script:
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
- Relayer key custody for `BufiEarnModule` beyond the decision above: each team's agent
  DCW is custodied by Circle's entity secret, held by BUFI, outside this repo.
