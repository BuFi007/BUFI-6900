# The agentic wallet — an "agentic-ready" Circle MSCA

**Decision (founder, 2026-09-02):** the per-agent Circle MSCA becomes the party for BUFI's agentic rails
(ERC-8183 jobs, ERC-8004 identity/reputation, x402 and card float funding). The agent runtime (Bu) holds only a
`BufiSessionKeyPlugin` session key; owners are the workspace's treasury/ops multisig (nested ERC-1271). Policy is
enforced on-chain by the EntryPoint through the plugins below; the app layer only *shapes* grants.

## Two faces per agent, not one

| Face | Owner set | Agent's power | Policy | Why separate |
| --- | --- | --- | --- | --- |
| **Policy face** (default) | treasury/ops multisig (nested 1271) | a **session key** only | `BufiSessionKeyPlugin` (scope, ERC-20/native/gas budgets per window, expiry, required paymaster) + `BufiSessionRecipientHookPlugin` × AddressBook (recipients) | the key can never `execute`, install plugins, or sign ERC-1271 |
| **Gateway float face** (only if the agent must move USDC cross-chain) | agent EOA key **weight 1**, treasury multisig weight ≥ threshold — threshold 1 | signs Gateway burn intents via ERC-1271 (`isValidSignature` → Weighted plugin → agent key is an owner) | **allocation is the cap**: the treasury `depositFor(floatFace, amount)`; Gateway's `isValidSignature` sees a bare digest, so no per-intent policy exists on-chain (desk plan 212 V1); revoke = `removeOwners` with Gateway's ≤5-min staleness | making the agent key an owner of the policy face would let it bypass every scope |

Circle's ERC-1271 announcement ("define who can move funds, when, where, and under what conditions … policy stays
inside the smart wallet") is exactly the split above: *who* = the owner set of the depositor account, *how much* =
what the treasury allocated, *conditions on individual burn intents* = not expressible, because the digest handed to
`isValidSignature` is hash-only. A session key is not an owner, so it cannot sign burn intents — by design.

## Rails → session-key scope (presets in `@bufi/modular-wallets-core` `src/cascade/agentGrantPresets.ts`)

| Rail | Preset | Targets / selectors the key may call | Budget | Must be in the AddressBook |
| --- | --- | --- | --- | --- |
| ERC-8183 buyer (Arc native jobs `0x0747EEf0…`) | `erc8183BuyerGrant` | USDC `approve`, `transfer`; jobs `createJob`, `setBudget`, `fund`, `reject` (`complete` = owners, opt-in) | ERC-20 per window | jobs contract (spender), provider MSCA |
| ERC-8183 provider | `erc8183ProviderGrant` | jobs `setBudget`, `submit` | gas only | — |
| ERC-8004 reputation | `erc8004RaterGrant` | reputation registry `giveFeedback` | gas only | — (identity `register()` is an owner op at birth) |
| x402 / scoped cards | `floatFunderGrant` | USDC `transfer` | ERC-20 per window | the x402 signer / card funding wallet |
| Gateway funding | `gatewayDepositorGrant` | USDC `approve`; GatewayWallet `deposit`/`depositFor` | ERC-20 per window | GatewayWallet |
| Earn (treasury) | n/a — relayer path, not a key | — | adopted config hash | — |

x402's EIP-3009 authorizations and Gateway burn intents are ERC-1271 signatures → owner-level; the key funds the
hot wallet, the hot wallet signs. Reputation is an **input** to grant sizing (raise budgets for high-rep
counterparties), never something the plugins enforce.

## Enforcement map

| Rule | Where | Cost of a violation |
| --- | --- | --- |
| key registered on this account, nonce lane = key | validation | rejected by bundler, no gas |
| target + selector scope, expiry, gas budget, native budget, required paymaster | validation | rejected, no gas |
| recipient ∈ AddressBook (ERC-20 `transfer/approve/transferFrom`, native target) | validation (hook) | rejected, no gas |
| ERC-20 budget per window | **execution** (audited upstream semantics) | included, reverts, gas paid (bounded by gas budget), no funds move |
| owner revoke / rotate | quorum userOp | immediate |
| paymaster kill switch | `requiredPaymaster` = Circle's paymaster (`0x03dF76C8…` on Fuji, proven live) | stop sponsoring → every agent op fails validation |

## Ops band → grant

auto band = key's ERC-20 limit + 24 h window + gas budget; approval band = anything above → owner quorum.
Stop re-implementing the band in Shiva for agent ops; Shiva pre-flights and shapes grants (`buildBufiGrant`).

## Proof status

| Claim | Where |
| --- | --- |
| session key + hook + AddressBook composition on Circle's production bytecode | `contracts/test/bufi/v0.7/**` (229 tests) |
| agent spend through Circle's real bundler on Fuji, incl. Circle paymaster sponsorship | `scripts/live/install-on-fuji.ts`, `contracts/deployments/avax-fuji.canary.json` |
| agent buyer funds an ERC-8183 job on Circle's native Arc contract via a session key | `contracts/test/fork/agentic/AgentFaceErc8183.t.sol` (Arc testnet fork) |
| Gateway float face | design; desk plan 212 canary provisioned the passkey ops MSCA on the 1271 rail — the float face is the same account shape with the agent key as a weight-1 owner |

## What still lives in the app layer

Grant issuance policy (which role gets what), counterparty semantics (which bill, KYC), per-agent recipient sets
(use one MSCA per role rather than per-key lists), Solana leg (EOA), reputation-driven budget sizing.
