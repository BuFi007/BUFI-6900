# Ultimate Treasury: one weighted multisig over one Gateway balance, EVM and Solana

**From:** BUFI (Business Finance; Circle Alliance member). **Repo:** `BuFi007/BUFI-6900`.
**To:** Circle Gateway team, Circle Modular Wallets team, Squads (Stefan), Altitude.
**Date of evidence:** 2026-10-04 (Squads policies) and 2026-10-05 (Gateway legs). All runs are testnet or devnet.

## 1. Thesis

A team should think in assets, not chains. It holds USDC, sees one balance, and moves it under one rule set: a
weighted multisig (the CFO's key counts double) and a recipient allowlist. Circle Gateway already gives one USDC
balance across chains. We made that balance governed by one weighted quorum and one allowlist on both EVM and
Solana, written once as a spec and compiled to each chain. On EVM the treasury contract is its own Gateway signer
through ERC-1271 and checks the policy inside `isValidSignature`. On Solana a Squads smart account holds the
balance and its Gateway delegate is a FROST threshold key held by the same owners with the same weights. Both legs
are proven live. The Solana leg's allowlist is enforced off-chain today, and closing that gap is our main ask.

## 2. What is proven

Hashes are quoted as recorded in `docs/GATEWAY-TREASURY-CANARY.md`. The Base Sepolia mint hash is given in full
(read back from Base Sepolia Blockscout, token transfer of 1,000,000 base units to R).

### 2.1 EVM: ERC-1271 Gateway transfer from a weighted treasury contract, Arc testnet → Base Sepolia

Contract `contracts/src/bufi/gateway-treasury/GatewayTreasury.sol`, forge suite 42/42
(`contracts/test/bufi/gateway-treasury/GatewayTreasury.t.sol`). Script `scripts/gateway-treasury/canary.ts`.

Configuration of the deployed treasury `0x692Db08885870fA99ADA4Acdee02633947669daF` (Arc testnet, 5042002):

| Parameter | Value |
| --- | --- |
| Owners and weights | A=2, B=1, C=1 |
| Threshold weight | 3 |
| Recipient allowlist | R `0xF7D0520C36717e25c5b77F977A89741d2974589C` only |
| Destination domains | 6 (Base Sepolia) only |
| Tokens | Arc USDC `0x3600000000000000000000000000000000000000` → Base Sepolia USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| Per-intent cap | 2 USDC |
| Fee cap | 2.01 USDC |
| Expiry window | 1,250,000 blocks |
| Admin timelock | 600 s |
| Deployer | `0x09Ce8E2B3Fede2727dA4392Ea8Fe618305ba0474` |

Gateway contracts used: GatewayWallet `0x0077777d7EBA4688BDeF3E311b846F25870A19B9`, GatewayMinter
`0x0022222ABE238Cc2C7Bb1f21003F0a260052475B`, API `https://gateway-api-testnet.circle.com`.

| Step | Result | Evidence |
| --- | --- | --- |
| Deposit A: USDC transfer to the treasury, then permissionless `sweepToGateway` (3 USDC) | credited | `0xd990c619…8cab`, `0x9d236e64…7a0d` |
| Deposit B: owners A+B sign an ERC-3009 `ReceiveWithAuthorization`; `GatewayWallet.depositWithAuthorization` pulls 1 USDC. USDC asks the treasury's `isValidSignature` (kind 1). | credited, no user operation | `0xb9d5bc6e…f4a2` |
| `GatewayWallet.availableBalance` | 4 USDC | on-chain read |
| Burn intent to S (not allowlisted), signed A+B | refused by Gateway: 400 "contract signature verification request failed". Local `isValidSignature` returns `0xffffffff`. | canary log |
| Burn intent to R signed B+C (weight 2 < 3) | refused by Gateway, same message | canary log |
| Burn intent to R, 1 USDC, signed A+B (weight 3), `contractSigner: true` | 201, attestation issued | canary log |
| `gatewayMint` on Base Sepolia | R 0 → 1 USDC. `GatewayMinter` event: source domain 26, depositor = signer = the treasury. | `0x9c5b49d49dbef4e58667356035e3295c5585cf59feaee3616fd0ea8e96e49277` |

Expiry on the accepted intent was head + 1,211,599 blocks: above Gateway's measured Arc floor of 1,209,599 and under
the treasury's 1,250,000 ceiling.

What this shows: Gateway's enclave simulation ran our policy-checked `isValidSignature` and enforced both the weighted
quorum and the recipient allowlist. As far as we know this is the first ERC-1271 Gateway burn minted from a
weighted-multisig treasury contract. It is also the first ERC-1271 burn we have ever minted: our earlier Circle MSCA
work only showed that `contractSigner: true` routed.

### 2.2 Solana: Squads treasury with a FROST threshold Gateway delegate, Solana devnet → Arc testnet

Script `packages/weighted-treasury/scripts/gateway-solana-delegate.ts`. Key tool `tools/frost-delegate`
(FROST(Ed25519, SHA-512), RFC 9591, Zcash Foundation `frost-ed25519` 3.0, shares from a DKG, no dealer).

| Item | Value |
| --- | --- |
| Owners and weights | A=2, B=1, C=1, threshold 3 |
| FROST shares | A:[1,2], B:[3], C:[4], threshold 3 shares |
| Delegate (FROST group key) | `EBjX3U8y1S1weZBNGooB7Ab3YmsFLNGK5W6EVYKhL3c2` |
| Squads smart account (settings) | `AVfkRovDYbmb3Nf7nUGdrubYWykeoY4vtphPusjnMshz` (all 3 owners) |
| Vault (Gateway depositor) | `AtBgen532MGQmGjhmKcXRHxaBpSDz1ML6WXuUYw1yy9B` |
| Solana GatewayWallet (devnet) | `GATEwdfmYNELfp5wDmmR6noSr2vHnAfBPMm2PvCzX5vu` |
| Devnet USDC | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` |
| Domains | Solana 5 → Arc 26 |

| Step | Result | Evidence |
| --- | --- | --- |
| `deposit_for` the vault, 3 USDC (any wallet can fund it, no vault transaction) | Gateway balance 3 USDC | `qbsyMA5Z…dCDg` |
| `add_delegate(group key)`: the vault signs through a synchronous Squads transaction co-signed by all 3 owners | delegate account status Authorized | `26rFMVSc…JwKJ1` |
| B+C (2 of 4 shares, threshold 3) | cannot produce a signature | FROST refuses below threshold |
| Burn intent signed with owner A's own key (not the delegate) | refused by Gateway: "Signer is not authorized to spend funds from sourceDepositor" | script log |
| Burn intent Solana → Arc, 1 USDC to R, FROST-signed by A+B (one Ed25519 signature) | 201, attestation | script log |
| `gatewayMint` on Arc testnet | R 0 → 1 USDC | `0x24f28de3…7163` |

Measured on Gateway testnet the same day:

- Solana `maxBlockHeight` floor: 3,024,000 slots above head (14 days at 400 ms). The EVM floor is about 7 days.
- A new delegate is indexed with a lag. The first submits returned "Signer is not authorized" while the on-chain
  delegate account already read Authorized. A refused intent is not consumed, so resubmitting the same signed
  intent is safe.
- The Solana burn intent is Circle's binary layout (magic `0x070afbc2` / `0xca85def7`, big-endian), signed with the
  16-byte `0xff00…` signing domain prefix, as `gateway/references/solana` specifies.

### 2.3 Solana: Squads weighted policies with an allowlist, devnet (no Gateway)

Code `packages/weighted-treasury` (Apache-2.0). Run of 2026-10-04 against the Smart Account Program
`SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG`, settings account `C5QBLUm2XzJx9pzhmttoiJtqnz1VFQxJgQZJBx6m4oeS`.
Owners A=2, B=1, C=1, threshold 3; one allowlisted wallet R, one stranger S.

| Step | Result |
| --- | --- |
| Rule change approved by A+B (weight 3, enough on EVM) | rejected, `InvalidProposalStatus`: Squads admin needs all owners |
| All 3 approve, execute immediately | rejected, `TimeLockNotReleased` |
| All 3 approve, after the timelock | policies {A,B} and {A,C} created |
| {A,B} pays R 100 | one co-signed transaction |
| {A,C} pays R 50 | accepted |
| {A,B} pays S | rejected, `InvalidDestination` |
| {B,C} tries (weight 2) | rejected, `NotASigner` |
| A alone (weight 2) | rejected, `InvalidSignerCount` |
| Final balances | R = 150, S = 0 |

Weights are exact, not approximated: "the approvers' weights reach the threshold" is monotone, so it equals "the
approvers include a minimal winning group", and each group becomes one all-of-k SpendingLimit policy. A parity test
checks every owner subset of 200 random configurations plus fixed edge cases (3,240 assertions): the EVM rule and
the Squads policies accept exactly the same sets.

## 3. Architecture

### 3.1 One spec, two compilers

```ts
{
  owners: [{ id: 'cfo', weight: 2, evm: '0x…', solana: '…' }, { id: 'ops1', weight: 1, … }, { id: 'ops2', weight: 1, … }],
  thresholdWeight: 3,
  allowlist: [{ label: 'payroll', evm: '0x…', solana: '…' }],
  assets: [{ symbol: 'USDC', solanaMint: 'EPjF…', solanaDecimals: 6 }],
  adminTimelockSeconds: 86400,
}
```

- `compileEvm(spec)` → Circle MSCA inputs (WeightedWebauthnMultisigPlugin owners, weights, threshold;
  ColdStorageAddressBookPlugin seed), or the same values as `GatewayTreasury` constructor arguments.
- `compileSquads(spec)` → Squads settings (all owners, admin timelock) plus one SpendingLimit policy per minimal
  winning group per asset, `destinations` = the allowlist.
- Both compilers refuse a spec they cannot express exactly. An empty allowlist means "nobody" in the spec but
  "anybody" in Squads `destinations`, so it is refused. A per-period budget has no enforcement point on Circle's
  weighted multisig, so `compileEvm` refuses it. A layout that needs more than 64 policies fails instead of
  dropping groups.

### 3.2 EVM leg: policy-checked ERC-1271

The treasury contract is the Gateway depositor and the burn intent's `sourceSigner`. Its signature format is
`abi.encode(uint8 kind, bytes payload, bytes ownerSigs)`. Owner signatures are 65-byte ECDSA, ascending by address.

- **kind 0, BurnIntent.** The contract decodes the full `BurnIntent` from `payload`, re-derives the EIP-712 digest
  under domain `{name:"GatewayWallet", version:"1"}` and requires it to equal `hash`. Nothing is signed blind. Then,
  all view-only: version 1; `sourceContract` = GatewayWallet; `sourceDepositor` and `sourceSigner` = this contract;
  `maxBlockHeight` ≤ head + expiry window; source token, destination token, destination domain and recipient each
  on their allowlist; `destinationCaller` zero or allowlisted; `hookData` empty; `0 < value ≤ per-intent cap`;
  `maxFee` ≤ fee cap; then the weighted signature check.
- **kind 1, USDC `ReceiveWithAuthorization`.** The caller must be a listed token. The digest is rebuilt under that
  token's EIP-712 domain (Arc testnet USDC: name "USDC", version "2"). `from` must be this contract and `to` must be
  GatewayWallet. This is how the quorum deposits by signature, with no user operation and no AddressBook in the path.
- Admin changes (owners, allowlist, domains, tokens, caps, expiry window, timelock, Gateway withdrawals) are queued
  with quorum signatures and executed after the timelock.

Gateway simulates `isValidSignature` read-only, so the contract keeps no counters. v1 enforces a per-intent cap, not
a period budget.

We call the reusable piece of this logic the GatewayIntentGuard: a view-only validator that binds a signature to the
exact burn intent it approves and checks it against the treasury's policy before the weighted check. It ships
today inside the standalone `GatewayTreasury`. The same checks can be packaged as an ERC-6900 validation plugin or
module for Circle MSCAs, reading the allowlist from Circle's AddressBook. The design note is
`docs/GATEWAY-INTENT-GUARD.md` (in progress at the time of writing).

### 3.3 Solana leg: threshold delegate

Gateway on Solana accepts only an Ed25519 signature from the depositor or a registered delegate. A Squads vault is a
PDA and has no key. So the Squads quorum deposits and registers one delegate whose key is a FROST group key. The same
owners hold its shares, with weights as share counts. Below threshold there is no valid signature to produce. The
aggregate is a plain RFC 8032 signature, so Gateway verifies it like any key. Squads can remove the delegate by
quorum.

### 3.4 One balance

A Gateway balance is keyed by depositor per domain. The EVM treasury has one address per EVM chain, so its EVM
positions are unified. The Solana position belongs to the Squads vault. The app shows one number (the sum) and spends
from either side. A budget set on both chains authorises up to 2× globally unless it is split, so budgets are split
per chain, never duplicated.

## 4. Asks

### 4.1 Circle Gateway

**A. A Solana program-signer path, equivalent to ERC-1271.**
Why: on EVM the quorum and the allowlist are enforced at validation time by our contract, inside your enclave. On
Solana the same policy is enforced by the coordinator that runs the FROST rounds: `frost-delegate sign` decodes the
burn intent and checks its `policy.json` (recipient per destination domain, caps, expiry, depositor, minter) before
any share signs. That is off-chain, it stops blind signing but not a share majority that signs without the
coordinator, and it is the weakest point of the design.
Smallest change: accept a Solana burn intent when a program-owned approval for that intent exists, validated
read-only the way the enclave validates `isValidSignature`. For example, a Squads-executed `approve_intent(hash)`
creates a PDA derived from (depositor, intent hash). The enclave reads that account at a recent slot against an RPC
quorum and checks that it is owned by an allowlisted approval program, binds the exact intent hash, and has not been
revoked. Gateway already attributes the balance to the vault, so no new deposit path is needed. This is the Solana
equivalent of Safe's approved hashes and keeps your existing TEE and RPC quorum model.

**B. EURC and cirBTC on Gateway.**
Why: the product is asset first. Our app and spec already model multiple assets, and the treasury contract has a
per-token allowlist. Today we show EURC and cirBTC as "not on Gateway yet" rather than fake a balance.
Smallest change: list EURC on the chains where USDC is listed, with the same `depositWithAuthorization` path. We
would run the same canary for it.

**C. Bounded-expiry guidance.**
Why: signed intents live long. We measured a floor of about 7 days on Arc (1,209,599 blocks) and 14 days on Solana
(3,024,000 slots). A treasury needs a published floor per chain to set its own ceiling (ours is 1,250,000 blocks).
Smallest change: publish the per-chain minimum `maxBlockHeight` delta and whether it can change, and say whether an
intent can be cancelled before expiry other than by draining the balance.

### 4.2 Circle Modular Wallets

**A. Allowlist the GatewayIntentGuard as an installable plugin or module.**
Why: on a Circle MSCA, `isValidSignature` is routed to the ownership plugin over the bare digest, so no per-intent
policy (recipient, amount, domain) can be enforced at validation time (`docs/GATEWAY-1271-EVALUATION.md`, rows 3
and 4). The AddressBook also rejects `deposit` and `addDelegate` (row 6). The guard fixes both: the account signs
only intents that match its allowlist, and deposits happen by signature.
Smallest change: either let a validation plugin or module see the decoded intent on the ERC-1271 route, or allowlist
a guard that wraps the ownership check the way `GatewayTreasury` does. We will adapt it to whichever account
generation you prefer.

**B. The plugins already submitted** (`docs/CIRCLE-SUBMISSION.md`): `BufiSessionKeyPlugin`
(`0x28504B34871Aa5a00269a960A9390187cbB5c070`) and `BufiEarnModule` (`0x57D446a9A9c23d939035a924F7D3643B6eedE4Cf`),
same addresses on Avalanche Fuji and Arc testnet. Why: they let the EVM side carry the same policies Squads policies
already express on Solana (scoped agent spend, automated Earn).

### 4.3 Squads

1. **A published `@sqds/smart-account`.** It is not on npm. We build it from source at commit `80bf1f7`. Its
   `package.json` says MIT but the repo's only LICENSE file is AGPL-3.0, so we vendor nothing from it. A published,
   clearly licensed package is the smallest change.
2. **An upgrade timelock on the Smart Account Program.** It is upgradeable on mainnet by a 3-of-5 Squads multisig
   with `time_lock = 0`. A treasury that holds a Gateway balance through it inherits that. A timelock on the upgrade
   authority's multisig is the smallest change.
3. **Weighted approvals or a weighted-approver program.** Policies give exact weights for spending, but rule changes
   go through the main signer set, which has no weights. v1 requires all owners plus a timelock, stricter than EVM.
   Either native weights, or a small weighted-approver program accepted as `settings_authority`, closes this. We
   would co-design and build the program with you.
4. **Threshold-delegate co-design.** Until Gateway has a program-signer path, a Squads vault can only move a Gateway
   balance through a delegate key. Squads holding or coordinating the FROST shares (or exposing an approved-intent
   PDA that Gateway can read, ask 4.1.A) would make this a first-class Squads feature.

### 4.4 Altitude

Adopt the spec in §3.1 as the shared source of truth for treasuries that span EVM and Solana. Each chain enforces it
with its own local quorum, and the bridge is never in the approval path. The compilers and the parity test are
Apache-2.0.

## 5. Known limits

- **Key rotation and revocation take up to 5 minutes on EVM.** Gateway validates against blocks up to 5 minutes old
  (`gateway/references/erc-1271`). A removed owner can still sign for that window.
- **Minimum expiry is about 7 days on EVM and 14 days on Solana.** Policy is checked when the intent is signed and
  validated, not when it expires.
- **Removing a delegate does not cancel intents it already signed** (Gateway technical guide). On Solana an intent
  signed by the FROST delegate stays valid until expiry even if Squads removes the delegate.
- **The Solana allowlist is enforced by the signing coordinator, not on-chain.** `frost-delegate sign` refuses any
  message that is not one burn intent satisfying its `policy.json`; a threshold of share holders who bypass the
  binary is not bound by it. In the sandbox all FROST participants run in one process (DKG included, so that
  process is effectively a dealer). In production each owner holds only its own shares.
- **Nested ERC-1271 owners are unproven live.** The canary used EOA owners. We have not shown that Gateway's
  simulation resolves a smart-account owner signing through its own ERC-1271.
- **Passkey owners cannot hold an Ed25519 FROST share.** They would need a second key type on Solana.
- **Squads rule changes need all owners**, not the weighted quorum. Stricter than EVM, never looser.
- **Per-intent cap only.** A period budget would need state, and Gateway's validation is read-only.
- **RPC trust.** Per Circle's own doc, the RPC quorum mitigates but cannot guarantee correct validation.
- **Mainnet not attempted.** Everything above is Arc testnet, Base Sepolia and Solana devnet. Gateway supports USDC
  only today.

## 6. How to reproduce

Repo root is `BUFI-6900`. Owner and recipient keys live in `.sandbox/ultimate-treasury/` (gitignored: `keys.json`
for EVM A, B, C, R, S; `solana-owners.json`; `frost/` shares; `solana-leg.json`). The EVM fee payer needs Arc testnet
USDC and Base Sepolia ETH. The Solana fee payer is `~/.config/solana/id.json` with devnet SOL and at least 3 devnet
USDC.

Contracts:

```bash
cd contracts && forge test --match-path 'test/bufi/gateway-treasury/*'   # 42 tests
```

Deploy a treasury (all values from environment: `OWNERS`, `WEIGHTS`, `THRESHOLD`, `GATEWAY_WALLET`, `RECIPIENTS`,
`DESTINATION_DOMAINS`, `TOKEN_ADDRESSES`, `TOKEN_NAMES`, `TOKEN_VERSIONS`, `DESTINATION_TOKENS`, `PER_INTENT_CAP`,
`MAX_FEE_CAP`, `MAX_EXPIRY_BLOCKS`, `ADMIN_TIMELOCK`):

```bash
cd contracts && forge script script/gateway-treasury/DeployGatewayTreasury.s.sol \
  --rpc-url https://rpc.testnet.arc.network --broadcast --private-key "$DEPLOYER_PK"
```

EVM canary (deposits, two refusals, accepted burn, mint on Base Sepolia):

```bash
DEPLOYER_PK=… TREASURY=0x692Db08885870fA99ADA4Acdee02633947669daF bun scripts/gateway-treasury/canary.ts
# add --skip-deposit to reuse the existing Gateway balance
```

Solana leg (Squads account, `deposit_for`, FROST delegate, refusals, burn, mint on Arc):

```bash
cd tools/frost-delegate && cargo build --release
./target/release/frost-delegate dkg --dir ../../.sandbox/ultimate-treasury/frost --owners A:2,B:1,C:1 --threshold 3
cd ../../packages/weighted-treasury && bun run squads:sdk
DEPLOYER_PK=… bun scripts/gateway-solana-delegate.ts            # new Squads account
DEPLOYER_PK=… bun scripts/gateway-solana-delegate.ts --reuse    # reuse the account in solana-leg.json
```

Squads weighted policies and parity:

```bash
cd packages/weighted-treasury && bun test test                       # EVM rule ⇔ Squads policies, every owner subset
bun run squads:sdk && bun run devnet:proof                           # live devnet proof, ~0.2 devnet SOL
```

Related documents: `docs/GATEWAY-TREASURY-CANARY.md` (evidence), `docs/ULTIMATE-TREASURY-PLAN.md` (design),
`docs/WEIGHTED-TREASURY-SQUADS.md` (Squads compiler), `docs/GATEWAY-1271-EVALUATION.md` (why not an execution
plugin), `docs/CIRCLE-SUBMISSION.md` (plugins), `tools/frost-delegate/README.md` (threshold key).
