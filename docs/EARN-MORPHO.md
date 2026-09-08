# Earn for treasuries — `BufiEarnModule` × Morpho (Blue, Vault V2, Midnight)

**Answer in one line:** treasuries get Morpho Blue yield *through Morpho Vault V2* (ERC-4626 `deposit`), which
`BufiEarnModule` already does on a real Circle account — proven on a Base-mainnet fork against Circle's production
contracts and a live V2 vault. Direct Blue supply and Midnight fixed-rate positions are **not** ERC-4626 and are
deliberately not wired into a deposit-only sweeper; the reliable path for both is an adapter the curator (V2) or
BUFI (Midnight term vault) owns, adopted by the multisig like any other config hash.

## Proof (Base mainnet fork, block 50769826)

`contracts/test/fork/earn/BufiEarnMorphoVaultV2.t.sol` — run with
`FOUNDRY_PROFILE=fork forge test --fork-url https://mainnet.base.org --fork-block-number 50769826 --match-contract BufiEarnMorphoVaultV2ForkTest`.

| Step | Result |
| --- | --- |
| Circle's production stack on Base (factory `0x0000000DF7…`, owner now `0x858E1055…`) allowlists the module | ✓ (harness pranks the live `factory.owner()`) |
| 2-of-3 weighted treasury MSCA created through the production factory | ✓ |
| Module owner registers `{chainId 8453, USDC, Gauntlet USDC Prime (Vault V2) 0x050cE30b…}` → config hash; the quorum installs the module with that hash and the two owner dependency slots | ✓ |
| `IERC4626(vault).maxDeposit(account)` | **0** — Vault V2 returns zero for every `max*`; a sweeper gating on it would never deposit |
| Relayer `autoEarn(USDC, 25,000)` → `approve` + `deposit(assets, account)` via `executeFromPluginExternal` | shares minted to the MSCA, within 0.1% of `previewDeposit`; position value within 0.5% of the deposit |
| Second sweep on the same config; stranger relayer | ✓ / rejected |
| Quorum redeems half the shares via `execute(vault, redeem(...))` | ✓ (liquid at this block) |

The module needed **no change** for Vault V2. The only V2-specific rule is the `max*` one above, which the module
never relied on.

## Which Morpho product, for which treasury need

| Need | Product | Path | Status |
| --- | --- | --- | --- |
| Idle USDC/EURC earning variable yield across Morpho Blue markets, curator-managed risk, liquid exit | **Vault V2** (ERC-4626 shares; allocates into Blue markets through adapters) | `BufiEarnModule` as-is: `autoEarn` → `deposit` | **Proven** (fork test) |
| Direct exposure to ONE Blue market | Morpho Blue `supply(MarketParams, assets, shares, onBehalf, data)` — not ERC-4626 | Do not add a Blue branch to the sweeper. Use a single-market V2 vault (or a Blue-market ERC-4626 adapter the multisig adopts) | Deferred by design (earn-integration guidance: never substitute direct Blue supply for the vault flow) |
| Fixed rate / term deposit | **Midnight** — buy *credit units* (zero-coupon-like claims settling at maturity) by taking ask offers; core is BUSL-1.1, no ERC-4626 wrapper | A `MidnightTermVault` adapter: `deposit` buys credit units on a chosen market/maturity, `redeem` only at/after maturity (1:1 net of fees) or via secondary liquidity; adopted per market as a config hash | **Design only** — Midnight has no stable adapter/ABI for sweepers yet; Vault V2 Midnight adapters, if Morpho ships them, would make it a normal V2 deposit |
| Same on Avalanche | — | Morpho is not on Avalanche (43114/43113). Treasury legs there stay idle or use a different venue | n/a |
| Arc | Morpho Blue + Vault V2 are live on **Arc mainnet (chainId 5042)**; Circle's MSCA stack is on Arc testnet (5042002) and Arc mainnet is pending | Same path once Circle deploys the factory on Arc mainnet | Watch |

## Reliability model for treasuries

1. **Destination is bound by the multisig, not the relayer.** The vault comes from `config[accountConfig[account]][chainId][token]`; `accountConfig` is written only by `installPlugin` and the routed `changeConfigHash`, both threshold-signed userOps. A compromised relayer chooses timing and amount, never destination (`EARN-NOTES.md`).
2. **Amount policy lives with the relayer** (Shiva today, a CRE cron later): sweep `balance − buffer`, never below the operating float; cap per sweep; skip when `previewDeposit` deviates from the last observed share price by more than a threshold (V2 share price is continuous; a jump means accrual, a fee change or a loss event — pause and page).
3. **Idempotency:** `autoEarn(token, amount)` is safe to retry — a duplicate just deposits again; the relayer must dedupe by (account, token, period) off-chain. Circle DCW/relayer submission should carry an idempotency key.
4. **Failure modes to monitor** (all surface as the relayer tx reverting, none move funds): vault paused / gated (V2 gates), deposit cap, adapter liquidity, token blacklist, stale config (owner re-registered a vault → new hash the account has not adopted → the OLD vault keeps receiving; nothing breaks). Alert on `AutoEarnExecuted` absence for N periods and on `ConfigSet` events.
5. **Exit is a governance action — and on a composed treasury the quorum cannot do it by hand at all.** Shares sit on the MSCA, but `execute(vault, redeem(...))` is REJECTED at validation: `redeem`/`withdraw` carry no decodable ERC-20/721/1155 recipient, so `ColdStorageAddressBookPlugin` resolves `address(0)` and fails closed. **Allowlisting the vault does not help** — an earlier version of this line said to add it at ceremony, which does not work; `test/bufi/v0.7/earn/TreasuryVaultExit.t.sol` proves it. Until the vault book lands (`docs/VAULT-BOOK-PLAN.md` §5) the exits are: the agent path (`executeWithSessionKey([vault.withdraw, token.transfer])`, `docs/SPENDING-FROM-YIELD.md`), or break-glass — uninstall the AddressBook, redeem, reinstall, three quorum user operations. A V2 illiquid exit (force deallocation, in-kind) is a separate multisig decision; never automate it.
6. **AddressBook does not gate the deposit leg** (`executeFromPluginExternal`), by construction — see `docs/PLUGIN-COMPOSITION.md`. This is acceptable because of (1); document it in the treasury policy rather than "fixing" it.
7. **Yield is variable; never present a promised rate.** Show native vault APY, underlying yield, rewards and fees separately (earn-integration guidance); Midnight is the only fixed-rate option and it is a term position.

## What to build next (in order)

1. Relayer service: Shiva job (or CRE cron per `workflow-defi-execute`) with the amount policy above, per-account config, and the health checks; runbook + alerts.
2. Ceremony: seed the vault address into the AddressBook so the redeem leg works without a second allowlist ceremony.
3. Base + Arc mainnet rollout once Circle's factory is on Arc mainnet; Fuji/Arc-testnet have no Morpho, so testnet
   rehearsals use the local sandbox with `MockVault` and the Base fork test for the real vault.
4. Midnight term vault adapter — only after Morpho publishes the offer/settlement interface as a supported
   integrator surface (or ships V2 Midnight adapters); until then treasuries do not take fixed-rate exposure via
   the sweeper.
