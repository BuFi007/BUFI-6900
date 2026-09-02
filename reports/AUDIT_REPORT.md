# BUFI-6900 — defensive audit on a Tenderly Virtual TestNet (Avalanche Fuji)

**Date:** 2026-09-02
**Reviewed commit:** `bd8d033` (post-fix plugin builds)
**Scope:** BUFI's custom ERC-6900 v0.7 plugins only — `BufiSessionKeyPlugin`, `BufiEarnModule`,
`BufiSessionRecipientHookPlugin`. Circle's `UpgradableMSCA`, factory, `PluginManager`, weighted multisig and
`ColdStorageAddressBookPlugin` are the trusted substrate and were exercised, never audited.
**Adversarial pre-pass:** `reports/ADVERSARIAL_PRE_TENDERLY.md` (Codex, F-01…F-09). The fixes for F-01 / F-06 /
F-08 are in the bytecode audited here.

## Environment

| | |
| --- | --- |
| Network | Avalanche Fuji (43113) — **testnet only**, per the skill's safety gate |
| Virtual TestNet | `0607e56e-b577-46ad-85be-232b16703fe5` ("BUFI-6900 Fuji audit v2 (post-fix plugins)") |
| Fork block | `0x3771546` (58,135,878) |
| Account under test | `0x8da065C76cec7eE5e408D0e25F88a0F7EaEEa6f7` — 2-of-3 weighted MSCA created through Circle's PRODUCTION factory |
| Owners | `0x3C44CdDd…`, `0x70997970…`, `0x90F79bf6…` (anvil test keys — throwaway by construction) |
| Agent session key | `0x15d34AAf…` |
| Driver | `reports/audit/driver.ts` (bun + viem; builds and submits owner and session-key user operations directly to the EntryPoint — there is no bundler on a vnet). Transaction log: `reports/audit/txlog.jsonl`; addresses: `reports/audit/state.json`. |

Admin and public RPC URLs carry the vnet UUID and are deliberately **not** recorded here; they are read from
`VNET_RPC` in the environment.

## Inventory — the fork carries the real production stack

Read from chain state at the fork block, not assumed:

| Contract | Address | Code | Manifest hash | Matches the pinned constant |
| --- | --- | --- | --- | --- |
| EntryPoint v0.7 | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` | 16,035 B | — | — |
| PluginManager | `0x00000005e69188224e4dEeF607801916DC0936d5` | 12,275 B | — | — |
| UpgradableMSCAFactory | `0x0000000DF7E6c9Dc387cAFc5eCBfa6c3a6179AdD` | 4,514 B | — | owner `0xb413194c…` (Circle transferred it; not the constructor owner) |
| WeightedWebauthnMultisigPlugin | `0x0000000C984AFf541D6cE86Bb697e68ec57873C8` | 19,580 B | `0xa043327d…ba0fd91` | ✅ |
| ColdStorageAddressBookPlugin | `0x0000000d81083B16EA76dfab46B0315B0eDBF3d0` | 7,254 B | `0x9d177c1c…be349d8` | ✅ |
| **BufiSessionKeyPlugin** | `0xBd607dBAC82CF1351C352FB65fC29dE9D0095339` | 13,538 B | `0xa32b3449…cb11ff5d` | ✅ post-fix build |
| **BufiEarnModule** | `0xeb94A8b7412418B506b24dBeD4Aed0E9ba5453c2` | 7,832 B | `0x5adab689…a96652e53` | ✅ post-fix build |
| **BufiSessionRecipientHookPlugin** | `0x2183C59d1B4f7480A006D970Ea7261FBbc447c1F` | 5,519 B | `0x0870010f…a57e999da` | deployed by this audit (CREATE2) |

Storage-layout pins used for slot reasoning: `reports/storage-layouts/*.txt` (`forge inspect`).

## Summary

| Case | What it proves | Result |
| --- | --- | --- |
| S1 | The post-fix `BufiSessionKeyPlugin` installs on a production Circle MSCA through a 2-of-3 owner user operation, with the fail-closed dependency slots `[(weighted, 1), (weighted, 0)]`; `AccountLoupe` lists it and the execution functions route to it | **PASS** |
| S2 | Owners grant an agent key (500 USDC / 24 h, 7-day expiry, USDC `transfer` on the access list); the loupe reads the grant back; the agent spends 200 USDC through `executeWithSessionKey` | **PASS** |
| S3 | Over-budget spend is an execution-phase rejection | **BLOCKED** — Tenderly plan quota |
| S4 | Expired key rejected after `increase_time` past `validUntil` | **BLOCKED** — same |
| S5 | Off-scope target and selector rejected at validation | **BLOCKED** — same |
| S6 | AddressBook installed; agent pays a stranger (the documented gap) | **BLOCKED** — same |
| S7 | Recipient hook closes that gap; allowlisted passes, stranger and `approve(stranger)` rejected | **BLOCKED** — same |
| S8 | Earn: multisig adopts a config hash, relayer sweeps, stranger relayer rejected, quorum re-points to vault B | **BLOCKED** — same |
| S9 | Uninstall ordering, `PluginUsedByOthers` on the weighted plugin | **BLOCKED** — same |
| S10 | ERC-7562 storage-access classification from a real validation trace | **BLOCKED** — same |

### Why S3–S10 are blocked

```
{"code":-32004,"message":"You've reached the quota limit for your current plan.
 Upgrade your plan in the dashboard or contact support to continue."}
```

Returned by `eth_sendRawTransaction` on the vnet after S2. It is an account-plan limit, not a fault in the
contracts: the same request succeeded minutes earlier in S1 and S2, and deleting the project's other vnet did not
restore it. **No case was marked PASS on simulation alone, and nothing here was inferred.**

Every blocked case IS covered elsewhere in this repository, which is why this report does not gate the audit:

| Blocked case | Where it is proven instead |
| --- | --- |
| S3, S5 | `contracts/test/bufi/v0.7/session/SessionKeyOnCircleMsca.t.sol`, `AgenticWalletPolicy.t.sol`; and on a real chain state in `contracts/test/fork/agentic/AgentFaceErc8183.t.sol::test_policy_holds` (Arc testnet fork) |
| S4 | `SessionKeyOnCircleMsca.t.sol` time-range cases (`vm.warp`) |
| S6, S7 | `contracts/test/bufi/v0.7/recipient-hook/BufiSessionRecipientHookPlugin.t.sol` (18 tests) and `SessionKeyWithAddressBook.t.sol` |
| S8 | `contracts/test/bufi/v0.7/earn/BufiEarnModuleOnMsca.t.sol` (21 tests) and, against a LIVE Morpho Vault V2, `contracts/test/fork/earn/BufiEarnMorphoVaultV2.t.sol` (Base mainnet fork) |
| S9 | `BufiEarnModuleOnMsca.t.sol`, `BufiSessionRecipientHookPlugin.t.sol` uninstall matrices |
| S10 | Codex F-09 (`ADVERSARIAL_PRE_TENDERLY.md`) — analysis against the ERC-7562 text; a live tracer classification remains **open** |

The local suites run Circle's **production bytecode** at its canonical addresses (recreated with Circle's own
CREATE2 salts), so the difference between them and this vnet is chain state and gas accounting, not the code under
test. What Tenderly still adds, and what is therefore genuinely unproven: real Fuji state (a live USDC with a real
supply and blocklist), real gas prices, and a tracer-level storage-access classification for a strict bundler.

## Case S1 — install the session-key plugin

Owner user operation, raw `installPlugin` calldata (never wrapped in `execute`: the inner self-call would re-enter
runtime validation, which weighted owners cannot pass).

| | |
| --- | --- |
| userOpHash | `0xdb4e919aebc78ad8e425e8b51c43c5ad24f16a5200041eab78205d2f96df6e65` |
| tx | `0x81b1a875fe8d437c66c3006bc330cceb8a33d5f046d892365657a5163379031b` (block 58,135,894) |
| Validation simulation | ok |
| `actualGasUsed` | 1,207,067 |

State after: `getInstalledPlugins()` → `[0x0000000C98… (weighted), 0xBd607dBA… (session key)]`.

A first attempt reverted `AA21 didn't pay prefund` because the freshly created account held no native balance —
recorded here because it is the expected failure mode for an un-funded MSCA, not a defect.

## Case S2 — grant an agent key and spend within budget

| | |
| --- | --- |
| Grant userOpHash | `0xa011c8b23a7c99530ba4f3a563465cd003f917eb86c5eaffad6955abc4a36f5d` |
| Grant tx | `0xcaa20a4f9061ace452a7986f4b05100ea8308b124284abfcd84a43b5a62e2c58` (block 58,135,897), `actualGasUsed` 683,292 |
| Spend tx | `0x6b64ce62eaffc6a4ba55d780cbdfb7bd6bcb2481430aac84371edce3456e0f15` (block 58,135,898) |

Read back from the plugin after the grant:

| Read | Value |
| --- | --- |
| `getSessionKeys` | `[0x15d34AAf…]` |
| `getKeyTimeRange` | `validAfter 0`, `validUntil 1788962247` (7 days) |
| access-list entry for USDC | on list, selectors checked |
| `transfer` selector on list | true |
| ERC-20 limit | 500 USDC per 86,400 s |

The agent then moved 200 USDC to the allowlisted recipient through `executeWithSessionKey`, in its own nonce lane
(`uint192(nonce >> 64) == uint192(uint160(sessionKey))` — the D10 rule, now required of every key).

## Staging artefacts (reproducibility)

| # | Artefact | How |
| --- | --- | --- |
| 1 | `BufiSessionRecipientHookPlugin` at `0x2183C59d…` | CREATE2 through the Arachnid deployer, salt `0xb622d27f…`, tx `0x904989e1…` |
| 2 | `MockVault` A `0x1d2e6b7a…` and B `0xf2ae0f19…` over Fuji USDC | plain deploys from the deployer persona |
| 3 | 2-of-3 MSCA `0x8da065C7…` | `UpgradableMSCAFactory.createAccount` with the weighted plugin in `initializingData` |
| 4 | 100 native + 10,000 USDC on the MSCA | `fund_account` / `set_erc20_balance` (admin RPC) — the only state cheats used |

## Risks surfaced

| # | Severity | Finding |
| --- | --- | --- |
| R1 | Operational | A newly created MSCA with no native balance fails `AA21 didn't pay prefund` on its first owner operation. Provisioning must fund the account (or attach a paymaster) before the first install; the Fuji canary does the latter with Circle's paymaster. |
| R2 | Operational | Circle has transferred `UpgradableMSCAFactory` ownership on live chains (`0xb413194c…` on Fuji and Arc, `0x858E1055…` on Base). Any tooling that assumes the constructor owner is wrong; the local harness now reads `factory.owner()`. |
| R3 | Process | A free Tenderly plan cannot carry a full stress matrix. Budget a paid plan for audit runs, or accept that the vnet lane covers the first few cases and the forge suites carry the rest. |

## Out of scope / blocked

- Circle's own contracts (trusted substrate).
- WebAuthn (P-256) owners: the harness signs with EOA owners in the same wire format; the plugin under test does
  not branch on owner type.
- A strict-bundler tracer classification of validation-phase storage access (Codex F-09) — still open.

## Reproducer

```bash
# 1. Auth + activate (Tenderly MCP OAuth'd in the session)
#    mcp__tenderly__set_active_project  account_slug=criptopoeta project_slug=bufi
#    mcp__tenderly__create_vnet         network_id=43113 chain_id=43113
#    mcp__tenderly__fund_account        <msca> 0x56BC75E2D63100000
#    mcp__tenderly__set_erc20_balance   <msca> 0x5425890298aed601595a70AB815c96711a31Bc65 0x2540BE400
# 2. Drive it
export VNET_RPC=<admin rpc from create_vnet>     # never committed
bun run reports/audit/driver.ts inventory
bun run reports/audit/driver.ts deploy-hook
bun run reports/audit/driver.ts deploy-vault           # and: deploy-vault vaultB
bun run reports/audit/driver.ts create-msca
bun run reports/audit/driver.ts s1
bun run reports/audit/driver.ts s2
# s3 … s10 available; they need a plan with headroom (see §Why S3–S10 are blocked)
```

## Sign-off

| | |
| --- | --- |
| Defensive pass | ☑ Partial — S1, S2 PASS on post-fix bytecode; S3–S10 BLOCKED on plan quota, covered by the forge suites |
| Adversarial pass | ☑ Complete — `reports/ADVERSARIAL_PRE_TENDERLY.md` (no Critical/High; 1 Medium and 2 Informational fixed, 5 Low accepted with mitigations) |
| Local suites at this commit | forge 264/264 (16 suites) · SDK jest 461/461 · mock-circle 16/16 · Arc agentic fork 3/3 · Base earn fork 1/1 — all re-measured 2026-09-02 against the TRACKED tree |
