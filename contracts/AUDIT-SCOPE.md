# Audit scope — plan 398 production freeze

Frozen code: branch `freeze/plan-398-production-grade`, commit
`ba57ab4e5eee13f0badbd0318d84cac1c9467798`. Any later commit that touches a file below
re-opens the freeze. Audit fixes ship as new deployments: every in-scope contract is
immutable, with no proxy and no upgrade path.

## Toolchain

| Setting   | Value                                                      |
| --------- | ---------------------------------------------------------- |
| Compiler  | solc **0.8.24**, pragma pinned exactly in every file below |
| EVM       | `paris`                                                    |
| Optimizer | on, 200 runs, `via_ir = true`                              |
| OZ        | `lib/openzeppelin-contracts` @ `dbb6104c` (v5.0.0+12)      |
| Build     | `forge build`, `forge test` (default profile, 475 tests)   |

## In-scope files

| File (under `contracts/`)                           | git blob   |
| --------------------------------------------------- | ---------- |
| `src/bufi/conduit/TreasuryConduit.sol`              | `f1e90183` |
| `src/bufi/conduit/TreasuryRedeemConduit.sol`        | `84620f1f` |
| `src/bufi/conduit/TreasurySwapAndDeposit.sol`       | `3e36520f` |
| `src/bufi/conduit/interfaces/IFiatTokenV2.sol`      | `898caa28` |
| `src/bufi/v0.7/earn/BufiEarnModule.sol`             | `b9e4a0e1` |
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
| TreasuryConduit        | `setTarget(target, allowed)` (refuses 0), `rescue(token, to)` (refuses 0, emits `Rescued`), `transferOwnership`, `renounceOwnership` | `execute` is permissionless. Funds move only on the treasury quorum's ERC-3009 signature, whose nonce commits to the whole intent. The target must be registered. |
| TreasuryRedeemConduit  | `setVault(vault, allowed)` (refuses 0), ownership                                | `redeem` is permissionless. It needs the treasury's ERC-1271 quorum signature over the EIP-712 `Redeem`, and each per-treasury nonce works once.                                    |
| TreasurySwapAndDeposit | `setVenue`, `setDest` (both refuse 0), ownership                                 | `run` is permissionless. It pulls only from `msg.sender`, which is the conduit in production.                                                                                        |
| BufiEarnModule         | `addAuthorizedRelayer` (refuses 0), `removeAuthorizedRelayer`, `setConfig`, ownership | `autoEarn` passes the account's runtime validation only for **explicitly authorized relayers**. The owner is no longer an implicit relayer. `changeConfigHash` passes only through the account's multisig userOp validation. |

`renounceOwnership` is inherited and left in place. A Safe that calls it freezes the
registry permanently. Removing it is a founder call (see below).

## Deploy procedure

1. **Simulate.** Run each script with `--fork-url <rpc> --sender 0x09Ce…0474` and
   without `--broadcast`. `script/SimulateFreezeWave.s.sol` rehearses the whole wave
   in one process, plays the Safe's accept, and refuses `--broadcast`.
2. **Bootstrap.** Broadcast as the bootstrap deployer, in this order:
   `DeployTreasuryConduit`, then `DeployTreasuryEarn`, then
   `DeployTreasurySwapAndDeposit`, then `DeployBufiPlugins`. The plugins script needs
   `EARN_MODULE_RELAYER`, the production relayer, which must be neither the deployer
   nor the Safe. Each script:
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
- Relayer key custody for `BufiEarnModule`, meaning a Circle DCW or a KMS key.
