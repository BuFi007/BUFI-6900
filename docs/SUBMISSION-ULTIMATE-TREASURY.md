# Ultimate Treasury: one weighted multisig over one Gateway balance, EVM and Solana

**From:** BUFI (Business Finance; Circle Alliance member). **Repo:** `BuFi007/BUFI-6900`.
**To:** Circle Gateway team, Circle Modular Wallets team, Squads (Stefan), Altitude.
**Date of evidence:** 2026-10-04 (Squads policies) and 2026-10-05 (Gateway legs, app sends). All runs are testnet
or devnet.

Every address, hash and test count for the live runs below comes from
[`docs/EVIDENCE-LEDGER.md`](EVIDENCE-LEDGER.md). Where this document and the ledger disagree, the ledger is right.
Three things are not in the ledger and name their own source: the Circle Gateway contract addresses (Circle's
testnet deployment), the plugin addresses in section 4.2.B (`contracts/deployments/*.json`), and the guard
mutation counts in section 3.3 (`docs/GATEWAY-INTENT-GUARD.md`).

## 1. Thesis

A team should think in assets, not chains. It holds USDC, sees one balance, and moves it under one rule set: a
weighted multisig (the CFO's key counts double) and a recipient allowlist. Circle Gateway already gives one USDC
balance across chains. We governed that balance with one weighted quorum on both EVM and Solana, written once as
a spec and compiled to each chain. On EVM the allowlist is on-chain in the treasury contract. On Solana it is
enforced off-chain, by the app server and the FROST coordinator's `policy.json`, kept in sync by hand.

On EVM the treasury contract is its own Gateway signer through ERC-1271 and checks the policy inside
`isValidSignature`. On Solana a Squads smart account holds the balance, and its Gateway delegate is a FROST
threshold key whose shares map to the same owners and weights (in the sandbox one process holds all shares; see
section 5). Both legs are proven live: EVM on Arc testnet and Base Sepolia, Solana on devnet minting to Arc
testnet. Closing the off-chain gap on Solana is our main ask to Circle.

We also packaged the EVM policy for Circle's own accounts (the GatewayIntentGuard, section 3.3). Building it showed
a gap worth stating up front: a Circle MSCA used as a Gateway depositor answers ERC-1271 for any burn intent its
quorum signed, with no recipient, domain, cap or expiry check. We show this in forge on Circle's canonical bytecode
(section 3.3); it has not been tried against live Gateway.

## 2. What is proven live

### 2.1 EVM: ERC-1271 Gateway transfer from a weighted treasury contract (v2, current source)

Contract `contracts/src/bufi/gateway-treasury/GatewayTreasury.sol`. Script `scripts/gateway-treasury/canary.ts`.

`GatewayTreasury` v2 is deployed on Arc testnet (chainId 5042002, Gateway domain 26) at
`0xC3f4De2372167F7FFA0a1B3FbF221a8a7289e7d5` (deploy tx
`0x3650cc2d8d1d5aebac60915b3acc20e1bbdc6e8765656d8fd9906a93f10624ab`). It is the live deployment of the current
source, including nested owners and the security-review fixes (section 6).

| Parameter | Value |
| --- | --- |
| Owners and weights | A=2, B=1, C=1 (addresses in the ledger) |
| Threshold weight | 3 |
| Recipient used in the canary | R `0xF7D0520C36717e25c5b77F977A89741d2974589C` (allowlisted) |
| Stranger used in the canary | S `0xd21389825CeB0843d108F639c9C70B55caa30A28` (not allowlisted) |
| Local domain | 26 |
| Destination domain | 6 (Base Sepolia) |
| Per-intent cap | 2 USDC |
| Fee cap | 2.01 USDC |
| `maxDebitPerIntent()` (value + fee) | 4.01 USDC |
| Expiry window | 1,250,000 blocks |
| Admin timelock | 600 s |
| Deployer | `0x09Ce8E2B3Fede2727dA4392Ea8Fe618305ba0474` |

Gateway contracts used: GatewayWallet `0x0077777d7EBA4688BDeF3E311b846F25870A19B9`, GatewayMinter
`0x0022222ABE238Cc2C7Bb1f21003F0a260052475B`, API `https://gateway-api-testnet.circle.com`.

| Step | Result | Evidence |
| --- | --- | --- |
| Deposit A: USDC transfer to the treasury | credited to the contract | `0xaca91b0d44c6d740cde4fbd4cadb1106513bafb71fe11edcabca521a9a771888` |
| Deposit A: permissionless `sweepToGateway`, 3 USDC | credited on Gateway | `0xd437cc7f6860313c402770fe568bda45b937e04fedba33c2ab0f11c61832525a` |
| Deposit B: owners A+B sign an ERC-3009 `ReceiveWithAuthorization`; `GatewayWallet.depositWithAuthorization` pulls 1 USDC. USDC asks the treasury's `isValidSignature` (kind 1). | credited, no user operation | `0xd62b37c6582d27c9b8d77252d2b56d7fe9c23b4226df1097a85cd323b05086ec` |
| Burn intent to S (not allowlisted), signed A+B | Gateway 400 "Invalid signature: contract signature verification request failed" | reproducible, not on-chain |
| Burn intent to R signed B+C (weight 2 < 3) | Gateway 400, same message | reproducible, not on-chain |
| Burn intent to R, 1 USDC, signed A+B (weight 3), `contractSigner: true` | Gateway 201, attestation issued | API response |
| `gatewayMint` on Base Sepolia | R 1.25 → 2.25 USDC | `0x2811ea79eff095289d6ddce116bbf44ff27ada534d9cdc82dd5cf7c86aac4ca5` |

Gateway's enclave simulation ran our policy-checked `isValidSignature` and enforced both the weighted quorum and the
recipient allowlist.

The first deployment, v1 `0x692Db08885870fA99ADA4Acdee02633947669daF`, ran the same flow on pre-review bytecode and
is superseded. Its hashes stay in the ledger, section 2.

### 2.2 Solana: Squads treasury with a FROST threshold Gateway delegate, Solana devnet → Arc testnet

Script `packages/weighted-treasury/scripts/gateway-solana-delegate.ts`. Key tool `tools/frost-delegate`
(FROST(Ed25519, SHA-512), RFC 9591, Zcash Foundation `frost-ed25519` 3.0, shares from a single-process sandbox
DKG: one process sees every share; see section 5).

| Item | Value |
| --- | --- |
| Owners and weights | A=2, B=1, C=1, threshold 3 |
| FROST shares | A:[1,2], B:[3], C:[4], threshold 3 shares |
| Delegate (FROST group key) | `EBjX3U8y1S1weZBNGooB7Ab3YmsFLNGK5W6EVYKhL3c2` |
| Squads smart account (settings) | `AVfkRovDYbmb3Nf7nUGdrubYWykeoY4vtphPusjnMshz` (all 3 owners) |
| Vault (Gateway depositor) | `AtBgen532MGQmGjhmKcXRHxaBpSDz1ML6WXuUYw1yy9B` |
| Domains | Solana 5 → Arc 26 |

| Step | Result | Evidence |
| --- | --- | --- |
| `deposit_for` the vault, 3 USDC (any wallet can fund it, no vault transaction) | Gateway balance 3 USDC | `qbsyMA5Z7ma3ExbQkz5VDMmtvYCh7CyrEpCT2Fu5ETN9zUMkz2pDDRkEiMNUJu5zYASbRYnCJpiV5qKUxpwdCDg` |
| `add_delegate(group key)`: the vault signs through a Squads transaction co-signed by all 3 owners | delegate account Authorized | `26rFMVScZsc2sXEBo9knwPoeP7WfAdxxdCQ676Rgu8KSm6xfRbWFCX5dkHxj3Fsx9Q6DXkaqPGDRAdMGKL8JwKJ1` |
| B+C (2 of 4 shares, threshold 3) | `frost-delegate` refuses: below threshold | the sandbox process holds all shares, so this shows the protocol rule, not key separation |
| Burn intent signed with owner A's own key, not the delegate | Gateway 400 "Signer is not authorized to spend funds from sourceDepositor" | reproducible |
| Burn intent Solana → Arc, 1 USDC to R, FROST-signed by A+B (one Ed25519 signature); `gatewayMint` on Arc testnet | R 0 → 1 USDC | `0x24f28de341f43f42d5b0cf0f1fdc90f6f52697466ae4d95e806ec7f9d4427163` |

Measured on Gateway testnet the same day (ledger section 5):

- Solana `maxBlockHeight` floor: we measured 3,024,000 slots above head (about 14 days at 400 ms). Arc testnet's
  floor is 1,209,599 blocks (about 7 days), the value our desk code uses.
- A new delegate is indexed with a lag. The first submits returned "Signer is not authorized" while the on-chain
  delegate account already read Authorized. A refused intent is not consumed, so resubmitting the same signed
  intent is safe.
- The Solana burn intent uses Circle's binary layout, signed with the 16-byte `0xff00…` signing-domain prefix, as
  `gateway/references/solana` specifies.

### 2.3 The app: two live sends

`apps/ultimate-treasury` shows one USDC number (the sum of both Gateway positions) and sends from either side. Two
sends went through it on 2026-10-05:

| Send | Result | Evidence |
| --- | --- | --- |
| EVM, 0.25 USDC, A+B → R, mint on Base Sepolia | Gateway 201; minted | `0xd03bea29bcd9fd21fc170e2a1ce5417a36c7e154f2138b0a04e646e8c2e09238` |
| Solana, 0.25 USDC, A+B → R, mint on Arc testnet | Gateway 201; R 1 → 1.25 | `0xd04c6001a6c1b4e4850da81456bfc57354ffde6e34e7162f8d00db174b0d334d` |

Both app sends were made while the app read the v1 treasury, before the v2 redeploy (ledger section 2). The app
now points at v2, and no app send against v2 is recorded yet. The app also has refusal demos. Their results are
recorded in `apps/ultimate-treasury/README.md`, not in the ledger, and they also ran against v1. On the EVM source
(A+B → S, B+C → R) they returned Gateway 400, as in the canary. On the Solana source no request reaches Gateway:
the current app server refuses S before signing, and `frost-delegate` refuses B+C below threshold.

### 2.4 Solana: Squads weighted policies with an allowlist, devnet (no Gateway)

Code `packages/weighted-treasury` (Apache-2.0). Run of 2026-10-04 against the Smart Account Program on devnet,
settings account `C5QBLUm2XzJx9pzhmttoiJtqnz1VFQxJgQZJBx6m4oeS`. Owners A=2, B=1, C=1, threshold 3; one allowlisted
wallet R, one stranger S. The token is TUSD, a devnet test mint with 6 decimals; amounts below are whole TUSD.

| Step | Result |
| --- | --- |
| Rule change approved by A+B (weight 3, enough on EVM) | rejected, `InvalidProposalStatus`: Squads admin needs all owners |
| All 3 approve, execute immediately | rejected, `TimeLockNotReleased` |
| All 3 approve, after the timelock | policies {A,B} and {A,C} created |
| {A,B} pays R 100 TUSD | one co-signed transaction |
| {A,C} pays R 50 TUSD | accepted |
| {A,B} pays S | rejected, `InvalidDestination` |
| {B,C} tries (weight 2) | rejected, `NotASigner` |
| A alone (weight 2) | rejected, `InvalidSignerCount` |
| Final balances | R = 150 TUSD, S = 0 |

Step signatures are not recorded in the ledger (ledger section 4 records only the settings account). The outcomes
are assertions in `packages/weighted-treasury/scripts/devnet-proof.ts`, re-runnable with `bun run devnet:proof`.

Weights are exact. "The approvers' weights reach the threshold" is monotone, so it equals "the approvers include a
minimal winning group", and each group becomes one all-of-k SpendingLimit policy. A parity test checks every owner
subset of 200 random configurations plus fixed edge cases: the EVM rule and the Squads policies accept exactly the
same sets.

### 2.5 Proven in forge only

- **GatewayIntentGuard** v0.7 plugin and v0.8 module: 42 + 14 tests, on Circle's canonical bytecode harnesses.
- **Nested ERC-1271 owners** in `GatewayTreasury`: 28 tests with mock owners, plus 4 with a real Circle v0.7 MSCA as
  an owner.

Neither has run against live Gateway. Full counts are in the ledger, section 6.

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
`abi.encode(uint8 kind, bytes payload, bytes ownerSigs)`.

- **kind 0, BurnIntent.** The contract decodes the full `BurnIntent`, re-derives the EIP-712 digest under domain
  `{name:"GatewayWallet", version:"1"}` and requires it to equal `hash`. Nothing is signed blind. Then, all
  view-only: version 1; `sourceDomain` = the local domain; `sourceContract` = GatewayWallet; `sourceDepositor` and
  `sourceSigner` = this contract; `destinationContract` = the GatewayMinter configured for that destination domain;
  `maxBlockHeight` ≤ head + expiry window; source token, destination token, destination domain and recipient each
  on their allowlist, and shaped for the destination domain (20-byte address on EVM, 32-byte key on Solana);
  `destinationCaller` zero or on its own caller list; `hookData` empty; `0 < value ≤ per-intent cap`;
  `maxFee` ≤ fee cap; then the weighted signature check.
- **kind 1, USDC `ReceiveWithAuthorization`.** The caller must be a listed token. The digest is rebuilt under that
  token's EIP-712 domain. `from` must be this contract and `to` must be GatewayWallet. This is how the quorum
  deposits by signature, with no user operation.
- **Owners.** `ownerSigs` is a Safe-style blob. EOA owners give 65-byte ECDSA signatures. A contract owner (a
  Circle MSCA, a Safe) gives a pointer slot and its own signature, checked by a gas-capped STATICCALL to its
  `isValidSignature`. Owners are in strictly ascending address order. Every malformed case returns invalid.
- **Admin.** Changes to owners, allowlists, domains, tokens, caps, expiry window, timelock and Gateway withdrawals
  are queued with quorum signatures and run after the timelock. Queued ops expire 7 days after their eta and die
  on owner or timelock rotation.
- **Fast stop.** `revokeIntent(digest, sigs)` refuses one intent and `pause(nonce, sigs)` refuses all burns. Both
  are quorum-signed and take effect without a timelock. Unpausing is timelocked.

Gateway simulates `isValidSignature` read-only, so the contract keeps no counters and enforces a per-intent cap, not
a period budget.

### 3.3 GatewayIntentGuard: the same policy on a Circle MSCA

Code `contracts/src/bufi/gateway-guard/`. Design `docs/GATEWAY-INTENT-GUARD.md`. Status: implemented and tested in
forge, not deployed, never tried against live Gateway. New, unaudited code.

**Why it is needed.** Circle's weighted multisig answers ERC-1271 for any hash its quorum signed. The
`ColdStorageAddressBookPlugin` gates `execute` and `executeBatch` recipients only and never sees
`isValidSignature`. So a Circle MSCA used as a Gateway depositor (`contractSigner: true`) has no recipient, domain,
cap or expiry policy on burns. Two baseline tests show it: a quorum-signed burn intent of 1,000,000 USDC to a random
recipient validates (`test_baseline_unguardedMsca_signsAnyRecipient` on v0.7,
`test_v08_baseline_unguarded_signsAnything` on v0.8).

**Where it hooks.**

- **v0.7 (`GatewayIntentGuardPlugin`).** On Circle's deployed generation, `isValidSignature` is an execution
  function owned by `WeightedWebauthnMultisigPlugin`, so a second plugin cannot answer ERC-1271. But
  `BaseMSCA.fallback` runs every `preRuntimeValidationHook` registered on a selector for any non-EntryPoint caller,
  before dispatch, and passes `msg.sender` and the full calldata. The guard is a pre-runtime validation hook on
  `isValidSignature`. No Circle contract change is needed: post-creation `installPlugin` is an owner action and is
not blocked by the factory allowlist, which applies only to install at account creation.
- **v0.8 (`GatewayIntentGuardModule`).** A validation hook on the `WeightedMultisigValidationModule` entity. It
  receives its own signature segment through `preSignatureValidationHook`. Circle has not deployed v0.8 on any
  mainnet. The module is ready for when it is.

**Wire format.**

- v0.7: `signature = multisigSig ‖ envelope ‖ uint256(envelope.length) ‖ ENVELOPE_MAGIC`, where
  `envelope = abi.encode(uint8 kind, bytes payload)` and
  `ENVELOPE_MAGIC = keccak256("BUFI.GatewayIntentGuard.envelope.v1")`. `multisigSig` is Circle's unchanged
  signature over `getReplaySafeMessageHash(account, hash)`. Circle's `checkNSignatures` stops once the threshold
  weight is reached, so it does not see the trailer. The trailer is not signed and does not need to be, because its
  digest must equal the signed hash.
- v0.8: Circle's envelope `[ModuleEntity(multisig, 0)][index 0 ‖ len ‖ envelope][0xff][multisigSig]`.
- Size for a USDC burn: envelope 704 bytes, full signature about 0.9 KB.

**What it checks.** The same kind 0 and kind 1 checks as section 3.2, read from per-account config. It never looks
at owner signatures. Circle's multisig does that afterwards. An optional bound AddressBook can add EVM-shaped
recipients, for EVM destination domains only.

**Revert semantics.** A hook cannot change an ERC-1271 return value in either generation, so on any violation the
guard reverts with a specific error (`RecipientNotAllowed`, `DigestMismatch`, `IntentShapeRejected`, and others).
In v0.7 the error arrives wrapped in `PreRuntimeValidationHookFailed(guard, 0, reason)`; in v0.8 it is the raw
revert. USDC's `SignatureChecker` treats a revert as invalid. Whether Gateway's enclave treats a revert the same as
`0xffffffff` is not yet confirmed (ask 4.1.D). With a quorum below threshold, v0.7 `checkNSignatures` reads into
the trailer and reverts instead of returning `0xffffffff`. It is still a refusal, and trailer bytes cannot add
weight.

**Tests.** 42 for the v0.7 plugin and 14 for the v0.8 module. Mutation checks (from `docs/GATEWAY-INTENT-GUARD.md`,
not re-run after the review added tests): making the v0.7 hook a no-op fails 24 tests; making the v0.8 hook a
no-op fails 7.

### 3.4 Solana leg: threshold delegate

Gateway on Solana accepts only an Ed25519 signature from the depositor or a registered delegate. A Squads vault is a
PDA and has no key. So the Squads quorum deposits and registers one delegate whose key is a FROST group key. In
production the same owners hold its shares, with weights as share counts, and below threshold there is no valid
signature. In the sandbox one process holds every share (section 5). The aggregate is
a plain RFC 8032 signature, so Gateway verifies it like any key. Squads can remove the delegate by quorum.

`frost-delegate sign` is the policy coordinator. It signs only a message that is exactly one hook-free Circle burn
intent, and it checks that intent against `policy.json` (depositor, signer, source domain, contract and token,
destination domain with its minter and token, recipient and caller allowed and shaped for that domain, value cap,
fee cap, expiry window) before any share signs.

### 3.5 One balance

A Gateway balance is keyed by depositor per domain. The EVM treasury is deployed only on Arc testnet today, so
there is one EVM position. Deploying it at the same address on other EVM chains would unify those positions under
one depositor. This is not done, and `localDomain` is a constructor argument, so a plain redeploy gives a different
address per chain. The Solana position belongs to the Squads vault. The app shows one number (the sum) and
spends from either side. A budget set on both chains would allow up to 2× globally, so budgets are split per chain,
never duplicated.

## 4. Asks

### 4.1 Circle Gateway

**A. A Solana program-signer path, equivalent to ERC-1271.**
Why: on EVM the quorum and the allowlist are enforced at validation time by our contract, inside your enclave. On
Solana the same policy is enforced by the coordinator that runs the FROST rounds. That is off-chain. It stops blind
signing but not a share majority that signs without the coordinator. It is the weakest point of the design.
Smallest change: accept a Solana burn intent when a program-owned approval for that intent exists, validated
read-only the way the enclave validates `isValidSignature`. For example, a Squads-executed `approve_intent(hash)`
creates a PDA derived from (depositor, intent hash). The enclave reads that account at a recent slot against an RPC
quorum and checks that it is owned by an allowlisted approval program, binds the exact intent hash, and has not been
revoked. Gateway already attributes the balance to the vault, so no new deposit path is needed.

**B. EURC and cirBTC on Gateway.**
Why: the product is asset first. Our spec, app and treasury contract already model multiple assets with a per-token
allowlist. Today the app shows EURC and cirBTC as "not on Gateway yet" rather than invent a balance.
Smallest change: list EURC on the chains where USDC is listed, with the same `depositWithAuthorization` path. We
would run the same canary for it.

**C. Bounded-expiry guidance.**
Why: signed intents live long. We measured 3,024,000 slots on Solana (about 14 days). Arc testnet's floor is
1,209,599 blocks (about 7 days), the value our desk code uses (ledger section 5). A treasury needs a published floor per chain to set its own ceiling (ours is 1,250,000
blocks).
Smallest change: publish the per-chain minimum `maxBlockHeight` delta and whether it can change, and say whether an
intent can be cancelled before expiry other than by draining the balance.

**D. Confirm enclave behaviour for nested calls and hook reverts.**
Why: only a single-contract `isValidSignature` is proven live. The GatewayIntentGuard and nested owners need the
simulation to follow an ERC-1967 proxy DELEGATECALL, the account fallback, and nested CALL or STATICCALL into the
guard, the multisig plugin or module, and an owner contract.
Smallest change: state whether the contract-signer verification follows those calls, its gas budget, the block it
evaluates against, whether a REVERT is treated the same as `0xffffffff`, and whether the API accepts contract
signatures of about 1 KB. If the enclave keeps an allowlist of callable contracts, it must include the account
implementation, `WeightedWebauthnMultisigPlugin` (`0x0000000C984AFf541D6cE86Bb697e68ec57873C8`) and the guard
address once deployed.

### 4.2 Circle Modular Wallets

**A. Review and support `GatewayIntentGuardPlugin` (v0.7) and `GatewayIntentGuardModule` (v0.8).**
Why: on a Circle MSCA, `isValidSignature` is routed to the ownership plugin over the bare digest, so a Gateway
depositor MSCA has no per-intent policy (section 3.3). The AddressBook also rejects `deposit` and `addDelegate`
(`docs/GATEWAY-1271-EVALUATION.md`). The guard fixes both: the account signs only intents that match its policy,
and deposits happen by signature.
Smallest change: no on-chain allowlist blocks a post-creation `installPlugin`, so this is a request for review,
not for an allowlist entry. Review the guard and, once deployed, list it in the Modular Wallets SDK and Console as
a supported plugin for Gateway depositor accounts. Longer term, either
native per-depositor intent policy in Gateway, or a signature-validation hook in the v0.7 multisig that can return
`0xffffffff` instead of reverting.

**B. The plugins already submitted** (`docs/CIRCLE-SUBMISSION.md`): `BufiSessionKeyPlugin`
(`0xBd607dBAC82CF1351C352FB65fC29dE9D0095339`) and `BufiEarnModule` (`0xeb94A8b7412418B506b24dBeD4Aed0E9ba5453c2`),
same addresses on Avalanche Fuji and Arc testnet (post-fix builds of 2026-09-02, from `contracts/deployments/*.json`).
The earlier builds `0x28504B34871Aa5a00269a960A9390187cbB5c070` and `0x57D446a9A9c23d939035a924F7D3643B6eedE4Cf`
carry pre-fix bytecode and must not be installed. They let the EVM side carry the same kinds of policy Squads
policies express on Solana (scoped agent spend, automated Earn).

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
   balance through a delegate key. Squads holding or coordinating the FROST shares, or exposing an approved-intent
   PDA that Gateway can read (ask 4.1.A), would make this a supported Squads feature.

### 4.4 Altitude

Adopt the spec in section 3.1 as the shared source of truth for treasuries that span EVM and Solana. Each chain
enforces it with its own local quorum, and the bridge is never in the approval path. The compilers and the parity
test are Apache-2.0.

## 5. Known limits

- **Key rotation and revocation take up to 5 minutes on EVM.** Gateway validates against blocks up to 5 minutes old
  (`gateway/references/erc-1271`). A removed owner can still sign for that window. `revokeIntent` and `pause` have
  the same lag.
- **Minimum expiry is about 7 days on EVM and 14 days on Solana.** Policy is checked when the intent is validated,
  not when it is used.
- **Removing a delegate does not cancel intents it already signed** (Gateway technical guide). On Solana an intent
  signed by the FROST delegate stays valid until expiry even if Squads removes the delegate.
- **The fee cap is larger than small values.** Gateway debits value + fee. Arc's per-transfer fee floor is about
  2 USDC, so the fee cap is 2.01 USDC against a 2 USDC value cap. One approved intent can debit up to
  `maxDebitPerIntent()` = 4.01 USDC. The fee is not bounded relative to value. Lowering the fee cap is a policy
  choice for the owners, and it would refuse small transfers on Arc today.
- **Installing the guard makes the account's ERC-1271 Gateway-only.** There is no pass-through for other hashes,
  because one would let the quorum sign a burn intent and present it without the envelope. This breaks other
  ERC-1271 uses on the same account. Use a dedicated Gateway-depositor account.
- **The guard has no timelock.** The quorum that signs intents can reconfigure or uninstall it. On v0.8 only the
  validations that carry the hook are guarded.
- **The Solana allowlist is enforced off-chain.** `frost-delegate sign` refuses any message that is not one burn
  intent satisfying its `policy.json`. A threshold of share holders who sign without the binary is not bound by it.
- **The app has two Solana gates, kept in sync by hand.** For a Solana send, the app server first checks the
  recipient against the EVM treasury's on-chain allowlist, then `frost-delegate` checks `policy.json`. The two lists
  are maintained separately. In the sandbox `policy.json` lists R on domain 26 only.
- **The sandbox threshold property is not real.** The sandbox DKG runs every participant in one process, so that
  process is effectively a dealer and sees every share. In production each owner would run its own participant and
  hold only its own shares.
- **The app is dev-only.** Its signer is a Vite dev-server plugin. A production build cannot send and says "connect
  a signer", so there is no hosted preview by design.
- **Nested ERC-1271 owners and the guard are unproven live.** The canary used EOA owners. The 1,000,000-gas cap on
  a nested owner call is not checked against Gateway's simulation limits.
- **Passkey owners cannot hold an Ed25519 FROST share.** They would need a second key type on Solana.
- **Squads rule changes need all owners**, not the weighted quorum. Stricter than EVM, never looser.
- **Per-intent cap only.** A period budget would need state, and Gateway's validation is read-only.
- **RPC trust.** Per Circle's own doc, the RPC quorum mitigates but cannot guarantee correct validation.
- **Mainnet not attempted.** Everything above is Arc testnet, Base Sepolia and Solana devnet. EURC is not proven.

## 6. Security review

A review in three lenses (app and signer, Gateway spec, contract security) raised 22 raw findings (9, 6 and 7).
The fix step reported 15 as confirmed but did not list which IDs. The full mapping, including findings merged or
not upheld, is in [`docs/SECURITY-REVIEW-GATEWAY.md`](SECURITY-REVIEW-GATEWAY.md). Red-first was recorded for 7 of
the 12 new `GatewayTreasury` regression tests and for 4 new guard plugin tests. The `cargo test` and `bun test`
suites did not compile or import before the fix. The fee finding is only partly fixed (exposed, not bounded). UT-9
was checked by hand and has no test. UT-8 was fixed after the fact-check (see the table). v2 `0xC3f4De2372167F7FFA0a1B3FbF221a8a7289e7d5` carries
the contract fixes; v1 does not.

| IDs | Finding | Fix | Regression tests | Status |
| --- | --- | --- | --- | --- |
| GT-1, GT-1 (spec), GG-1 | Recipient, caller and destination token not tied to the destination domain | address shape checked per domain; AddressBook used for EVM domains only | `test_GT1_recipientShapeBoundToDomain`, `test_GG1_addressBookRecipient_refusedOnSolanaDomain`, `test_GG1_explicitRecipients_boundToDomainShape` | fixed |
| GT-4, GT-6 (spec) | `sourceDomain` and `destinationContract` not pinned | pinned to the local domain and the configured minter per domain | `test_GT4_destinationContractAndSourceDomainPinned` (treasury and plugin), `test_GT4_constructor_requiresMinterPerDomain` | fixed |
| GT-6 | Any allowlisted payee was also a valid destination caller | separate destination-caller list | `test_GT6_destinationCallerNotImpliedByRecipientAllowlist`, `test_GT6_recipientIsNotADestinationCaller` | fixed |
| GT-2 | Admin ops never expired | 7-day grace and an admin epoch bumped on owner or timelock change | `test_GT2_adminOpExpiresAfterGrace`, `test_GT2_ownerRotationInvalidatesPendingOps`, `test_GT2_timelockChangeInvalidatesPendingOps` | fixed |
| GT-3 | A signed but never-queued admin op could not be revoked | signed deadline and epoch; `cancelAdmin` burns unqueued nonces | `test_GT3_cancelNeverQueuedNonce_burnsIt`, `test_GT3_adminSignaturesExpireAndDieOnRotation` | fixed |
| GT-2 (spec) | No fast revocation of a signed intent | `revokeIntent` and `pause`, quorum-signed, no timelock | `test_GT2_revokeIntent_immediate`, `test_GT2_pause_immediate_unpauseTimelocked` | fixed; Gateway's block lag remains |
| GT-3 (spec), fee part of GT-4 | Per-intent cap understated outflow (value + fee) | `maxDebitPerIntent()` exposed and documented | `test_GT3_maxDebitPerIntent_includesFee` | partly fixed: exposed, not bounded |
| GT-4 (spec), UT-3 | FROST tool signed arbitrary bytes | `sign` is a policy coordinator over `policy.json` | `policy_accepts_the_canonical_intent`, `policy_refuses_each_violation`, `refuses_anything_that_is_not_one_burn_intent` | fixed in the tool; off-chain only |
| UT-6, UT-7 | Duplicate signer labels counted toward threshold; `dkg` overwrote shares world-readable | labels deduplicated; `dkg` refuses to overwrite and writes 0600 | `duplicate_or_unknown_signer_labels_are_refused`, `dkg_refuses_to_overwrite_and_writes_owner_only_files` | fixed |
| UT-1 | Dev server served key files over `/@fs/` | `.sandbox` and key files denied; OPTIONS refused | `apps/ultimate-treasury/server/hardening.test.ts`, "UT-1 dev server file exposure" | fixed |
| UT-4 | Signer trusted the Host header | loopback socket and exact page origin required | same file, "UT-4 localOnly" | fixed |
| UT-2 | Refusal demos skipped caps and balance; Solana weights could drift from the share map | caps and balance always checked; 409 on drift | same file, "UT-2 send validation" | fixed |
| UT-5 | Mint success reported as error under RPC lag; retries paid twice | attestation persisted; mint read from the receipt log; duplicate send blocked | same file, "UT-5 mint bookkeeping" | fixed |
| UT-9 | Canary sent real funds to an unvalidated `TREASURY` | `canary.ts` checks the address, its code on Arc testnet, and reads back owners and Gateway wallet first | none; checked by hand | fixed, manual check only |
| UT-8 | `u256be` in `gateway-solana-delegate.ts` dropped the high 128 bits | full 256-bit encoder in `packages/weighted-treasury/src/encoding.ts`, overflow refused | `encoding.regression-1.test.ts` (packages/weighted-treasury/test) | fixed |

Open after review: the fee is not bounded relative to value (section 5), the Solana policy is off-chain (ask
4.1.A).

## 7. How to reproduce

Repo root is `BUFI-6900`. Owner and recipient keys live in `.sandbox/ultimate-treasury/` (gitignored: `keys.json`
for EVM A, B, C, R, S; `solana-owners.json`; `frost/` shares and `policy.json`; `solana-leg.json`). The EVM fee
payer needs Arc testnet USDC and Base Sepolia ETH. The Solana fee payer is `~/.config/solana/id.json` with devnet SOL
and at least 3 devnet USDC.

Tests (counts in the ledger, section 6):

```bash
cd contracts && forge test --match-path "test/bufi/gateway-*/**"  # treasury, nested owners, guard v0.7 and v0.8
cd packages/weighted-treasury && bun test test                    # EVM rule ⇔ Squads policies parity
cd apps/ultimate-treasury && bun test server                      # app hardening
cd tools/frost-delegate && cargo test                             # coordinator policy
```

Deploy a treasury. All values come from the environment: `OWNERS`, `WEIGHTS`, `THRESHOLD`, `GATEWAY_WALLET`,
`RECIPIENTS`, `DESTINATION_DOMAINS`, `TOKEN_ADDRESSES`, `TOKEN_NAMES`, `TOKEN_VERSIONS`, `DESTINATION_TOKENS`,
`PER_INTENT_CAP`, `MAX_FEE_CAP`, `MAX_EXPIRY_BLOCKS`, `ADMIN_TIMELOCK`, `LOCAL_DOMAIN` (26 on Arc testnet),
`DESTINATION_MINTERS` (one 32-byte word per destination domain; GatewayMinter
`0x0022222ABE238Cc2C7Bb1f21003F0a260052475B` left-padded) and optional `DESTINATION_CALLERS`.

```bash
cd contracts && forge script script/gateway-treasury/DeployGatewayTreasury.s.sol \
  --rpc-url https://rpc.testnet.arc.network --broadcast --private-key "$DEPLOYER_PK"
```

EVM canary against the live v2 treasury (deposits, two refusals, accepted burn, mint on Base Sepolia):

```bash
DEPLOYER_PK=… TREASURY=0xC3f4De2372167F7FFA0a1B3FbF221a8a7289e7d5 bun scripts/gateway-treasury/canary.ts
# add --skip-deposit to reuse the existing Gateway balance
```

The canary refuses a `TREASURY` that is not an address or has no code on Arc testnet.

Solana leg (Squads account, `deposit_for`, FROST delegate, refusals, burn, mint on Arc). `dkg` refuses to overwrite
existing shares:

```bash
cd tools/frost-delegate && cargo build --release
./target/release/frost-delegate dkg --dir ../../.sandbox/ultimate-treasury/frost --owners A:2,B:1,C:1 --threshold 3
cd ../../packages/weighted-treasury && bun run squads:sdk
DEPLOYER_PK=… bun scripts/gateway-solana-delegate.ts            # new Squads account
DEPLOYER_PK=… bun scripts/gateway-solana-delegate.ts --reuse    # reuse the account in solana-leg.json
```

Squads weighted policies on devnet:

```bash
cd packages/weighted-treasury && bun run squads:sdk && bun run devnet:proof   # ~0.2 devnet SOL
```

App (dev server only; see `apps/ultimate-treasury/README.md`):

```bash
bun install && bun run treasury:dev
```

Related documents: `docs/EVIDENCE-LEDGER.md` (every address and hash), `docs/SECURITY-REVIEW-GATEWAY.md`
(findings, fixes, residual risks), `docs/GATEWAY-INTENT-GUARD.md` (guard and nested owners), `docs/GATEWAY-TREASURY-CANARY.md` (canary narrative), `docs/ULTIMATE-TREASURY-PLAN.md` (design),
`docs/WEIGHTED-TREASURY-SQUADS.md` (Squads compiler), `docs/GATEWAY-1271-EVALUATION.md` (why not an execution
plugin), `docs/CIRCLE-SUBMISSION.md` (plugins), `tools/frost-delegate/README.md` (threshold key).
