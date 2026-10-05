# GatewayIntentGuard: the GatewayTreasury policy on a Circle MSCA, plus nested contract owners

Status 2026-10-05: **implemented and tested locally (forge), not deployed, not tried against Gateway live.**
New, unaudited BUFI code.

Two deliverables:

1. **Nested contract owners in `GatewayTreasury`.** An owner can now be a smart account (a Circle MSCA, a Safe)
   that authorizes through its own ERC-1271.
2. **`GatewayIntentGuard`**: the same intent policy packaged for Circle ERC-6900 accounts, as a v0.7 plugin (the
   generation Circle has deployed and BUFI treasuries run on) and a v0.8 validation-hook module.

Shared policy code lives in `contracts/src/bufi/gateway-guard/GatewayIntentPolicy.sol` (internal library, inlined).
`GatewayTreasury` was refactored onto it; all 42 original tests still pass unchanged.

## Why a guard is needed at all

Circle's weighted multisig answers ERC-1271 for **any** hash the quorum signed. Circle's
`ColdStorageAddressBookPlugin` gates `execute`/`executeBatch` recipients only; it never sees `isValidSignature`.
So a Circle treasury MSCA used as a Gateway depositor (`contractSigner: true`) has no recipient, domain, cap or
expiry policy on burns. `test_baseline_unguardedMsca_signsAnyRecipient` (v0.7) and
`test_v08_baseline_unguarded_signsAnything` (v0.8) show it: a burn intent of 1,000,000 USDC to a random recipient
validates. The guard closes that gap without touching Circle's multisig.

## 1. Nested contract owners (GatewayTreasury)

`ownerSigs` is now a Safe-style blob:

- **Static part:** k slots of 65 bytes, owners in **strictly ascending address order across both kinds**.
  - EOA owner: `r ‖ s ‖ v`, v in {27, 28}, low-s, recovered over the hash (unchanged).
  - Contract owner: `v = 0`, `r` = owner address (upper 96 bits must be zero), `s` = byte offset (from the start of
    `ownerSigs`) of that owner's dynamic signature.
- **Dynamic part:** at each offset, a 32-byte length L and L bytes, passed verbatim to
  `IERC1271(owner).isValidSignature(hash, sig)`.

Rules (all return invalid, never revert):

| Rule | Why |
| --- | --- |
| static part ends exactly at the lowest dynamic offset (or at the end of the blob when all owners are EOAs) | no partial slots, no bytes between slots and data; EOA-only blobs keep the old `len % 65 == 0` rule, so existing signers are byte-compatible |
| offset ≥ end of its own slot, `offset + 32 ≤ len`, `L ≤ len − offset − 32` (written overflow-free) | no out-of-bounds reads, no wrap-around with huge offsets/lengths |
| nested call is a STATICCALL capped at 1,000,000 gas, copies at most 32 bytes back, and requires the full word `0x1626ba7e00…00` | a reverting, out-of-gas, return-bombing, short-return or dirty-magic owner reads as invalid |
| owner ≠ the treasury (refused in the constructor, `setOwners`, and at validation) | no self-recursion |
| owner must have code | an EOA in a `v = 0` slot is invalid |

Mutual recursion (an owner that calls back into the treasury) is cut by the gas cap and the 63/64 rule; it returns
invalid (`test_nested_mutualRecursion_terminatesInvalid`). The cap (1,000,000) is sized for an owner MSCA whose
signers are P-256 passkeys verified in Solidity (~300k each without RIP-7212).

**Unproven live:** Gateway's enclave simulation has only ever resolved our *single-contract* `isValidSignature`
(docs/GATEWAY-TREASURY-CANARY.md). A nested owner adds a second contract call (and, for a Circle MSCA owner, an
ERC-1967 proxy DELEGATECALL plus a plugin CALL). Whether the simulation follows those calls, with what gas and at
what block, is not known until a live canary signs with a nested owner.

Measured (forge): EOA + nested Circle v0.7 MSCA (2-of-3 inner quorum) `isValidSignature` = 99,561 gas.

## 2. GatewayIntentGuard

### Investigation: where can a module see the hash, the caller and a payload?

| Generation | ERC-1271 routing in Circle's account | Integration point chosen |
| --- | --- | --- |
| **v0.7** (`BaseMSCA`, production) | `isValidSignature` is an *execution function* owned by `WeightedWebauthnMultisigPlugin` (runtime validation ALWAYS_ALLOW). Only one plugin may own a selector, so a second plugin cannot answer ERC-1271. But `BaseMSCA.fallback` runs every `preRuntimeValidationHook` registered on the selector for any non-EntryPoint caller, **before** dispatching, even under ALWAYS_ALLOW, and passes `msg.sender` + full calldata. `PluginManager` allows hooks on another plugin's selector. | `GatewayIntentGuardPlugin`: a `preRuntimeValidationHook` on `isValidSignature`. |
| **v0.8** (`BaseMSCA`, not deployed by Circle on any mainnet) | `isValidSignature` selects a validation by the first 24 bytes, runs that validation's hooks via `preSignatureValidationHook(entityId, caller, hash, hookSegment)` (each hook gets its own signature segment), then `validateSignature` on the final segment. | `GatewayIntentGuardModule`: a validation hook on the `WeightedMultisigValidationModule` entity. |

v0.8 is the cleaner fit (a hook made for this, with its own segment). v0.7 is the one that matters for BUFI today,
and it works without any Circle change.

### What the guard does (both packagings)

1. Decode the envelope `abi.encode(uint8 kind, bytes payload)` (same `kind`/`payload` as GatewayTreasury).
2. Re-derive the EIP-712 digest and require it to equal `hash`:
   - kind 0: Gateway `BurnIntent`, domain `{name: "GatewayWallet", version: "1"}` (no chainId);
   - kind 1: USDC `ReceiveWithAuthorization`, domain = the calling token's name/version/chainId/address.
3. Enforce per-account policy:
   - kind 0: version 1; `sourceDomain` = the configured local domain; `sourceContract` = configured
     GatewayWallet; `sourceDepositor` = `sourceSigner` = the account; `maxBlockHeight − block.number ≤
     maxExpiryBlocks`; canonical source token in the token set; destination token and domain in their sets;
     `destinationContract` = the GatewayMinter configured for that destination domain; recipient in the recipient
     set; `destinationCaller` zero or in the SEPARATE destination-caller set (a relayer is not a payee); empty
     `hookData`; `0 < value ≤ perIntentCap`; `maxFee ≤ maxFeeCap`.
   - Domain binding: the destination token, recipient and caller must have the destination domain's address shape
     (a canonical non-zero 20-byte address on an EVM domain, a word with its upper 96 bits set on Solana, domain
     5). One flat set holds both kinds, and an EVM address minted on Solana (or a Solana key truncated by an EVM
     minter) lands in an account nobody controls. Unknown domains are treated as EVM, so a future non-EVM domain
     fails closed until it is added to `GatewayIntentPolicy.isEvmDomain`.
   - Fees: Gateway debits `value + fee` (fee ≤ `maxFee`), so one approved intent can take up to
     `perIntentCap + maxFeeCap` (GatewayTreasury exposes this as `maxDebitPerIntent()`). The fee is not bounded
     relative to value: Arc's per-transfer fee floor (~2 USDC) is larger than small transfer values.
   - kind 1: caller is an allowed token; `from` = the account; `to` = the GatewayWallet.
   - Optional (v0.7 and v0.8): if an address book is bound at install, an **EVM-shaped** recipient in the account's
     `ColdStorageAddressBook` set is also allowed. Caveat: that set is a source-chain list; trusting it on the
     destination chain assumes the same address is the same party there (true for EOAs, not guaranteed for
     per-chain contracts). It is consulted only for EVM destination domains: Solana recipients never come from it.
4. Delegate the quorum: the guard never looks at owner signatures. Circle's weighted multisig does, afterwards.

On any violation the guard **reverts** with a specific error (`RecipientNotAllowed`, `DigestMismatch`,
`IntentShapeRejected`, …). Hooks cannot change an ERC-1271 return value in either generation, and every ERC-1271
caller (USDC's `SignatureChecker`, Gateway's simulation) treats a revert as invalid. In v0.7 the error arrives
wrapped in `PreRuntimeValidationHookFailed(guard, 0, reason)`; in v0.8 it is the raw revert.

### Wire formats

- **v0.7:** `signature = multisigSig ‖ envelope ‖ uint256(envelope.length) ‖ ENVELOPE_MAGIC`, where
  `ENVELOPE_MAGIC = keccak256("BUFI.GatewayIntentGuard.envelope.v1")` and `multisigSig` is Circle's unchanged
  signature over `WeightedWebauthnMultisigPlugin.getReplaySafeMessageHash(account, hash)`. Circle's
  `checkNSignatures` stops once the threshold weight is reached and only follows offsets it was given, so the
  trailer is invisible to it. The trailer is not signed; it does not need to be, since its digest must equal the
  signed hash. Side effect: with a quorum *below* threshold, `checkNSignatures` keeps reading into the trailer and
  reverts instead of returning `0xffffffff`; still a refusal, and trailer bytes cannot add weight (they would need
  a real owner signature over the replay-safe hash).
- **v0.8:** Circle's 1271 envelope `[ModuleEntity(multisig, 0)][index 0 ‖ len ‖ envelope][0xff][multisigSig]`.

Sizes for a USDC burn: envelope 704 bytes; full signature about 0.9 KB (v0.7 ~900 B with a 2-signer quorum, v0.8
~864 B). The live canary already pushed a GatewayTreasury signature of the same order through Gateway's API.

### Configuration and admin ("guarded the way Circle plugins are")

Per-account state keyed by `msg.sender` (the account), with an epoch so a reinstall never inherits old entries.

- **v0.7:** setters (`setGatewayRecipient`, `setGatewayDestinationDomain`, `setGatewayToken`,
  `setGatewayDestinationToken`, `setGatewayLimits`, `setGatewayDestinationMinter`, `setGatewayDestinationCaller`)
  are execution functions on the account. User-op validation =
  dependency slot 1 (weighted multisig owner validation, id 0); runtime validation = dependency slot 0 (the
  production fail-closed id 1). This is exactly the arrangement of Circle's `ColdStorageAddressBookPlugin`
  (`_addressBookDependencies()` in the harness). Install data `abi.encode(GatewayGuardInit)`; a bound address book
  must declare `IAddressBookPlugin` and be installed on the account.
- **v0.8:** setters are called by the account through `execute(guard, 0, setGateway…(…))`, so they pass the
  owners' validation. Install = `installValidation` on the existing multisig entity with the guard as a hook
  (flags unchanged). The userOp/runtime hooks are no-ops, so the owners' normal operations are unaffected.

### Honest limits

- **The account's ERC-1271 becomes Gateway-only.** There is no pass-through for "other" hashes: one would let the
  quorum sign a burn intent and present it without an envelope. In v0.7 this covers every ERC-1271 call; in v0.8,
  every call through the guarded validation. This **breaks other ERC-1271 uses on the same account**, including
  desk-v1's treasury conduit (a quorum-signed ReceiveWithAuthorization to the agent DCW: kind 1 with `to` ≠
  GatewayWallet is refused). Use a dedicated Gateway-depositor account.
- **No timelock.** The quorum that signs intents also reconfigures the guard and can uninstall it (v0.7:
  `uninstallPlugin`, after which the multisig signs anything again; proven by
  `test_uninstall_reopensErc1271_andReinstallStartsClean`). v0.8 cannot detach one hook, but the quorum can
  install a second, unguarded signature validation. GatewayTreasury's timelocked admin queue has no equivalent here.
- **v0.8 scope:** only the validation(s) carrying the hook are guarded; every other signature-capable validation
  on the account is an open ERC-1271 path.
- **Not live-tested.** Gateway's enclave would have to resolve: the ERC-1967 proxy DELEGATECALL, the account
  fallback, a CALL into the guard, and a CALL into the multisig plugin (v0.7), or STATICCALLs into the guard and
  the validation module (v0.8). Only a single-contract `isValidSignature` is proven live.

### What Circle would need to change or allowlist

Nothing in Circle's contracts is required for v0.7: post-creation `installPlugin` needs no factory allowlist, and
the hook only uses mechanisms Circle's `BaseMSCA` and `PluginManager` already support. What we need from Circle:

1. **Gateway simulation:** confirm the contract-signer verification follows proxies (DELEGATECALL) and nested
   CALL/STATICCALL into other contracts (plugin/module addresses, and nested owners), state the gas budget and the
   block it evaluates against, and whether a REVERT is treated the same as `0xffffffff`. If the enclave keeps an
   allowlist of callable contracts, it must include the account implementation, `WeightedWebauthnMultisigPlugin`
   (`0x0000000C984AFf541D6cE86Bb697e68ec57873C8`), the guard plugin address once deployed, and, for a Circle-MSCA
   owner of a GatewayTreasury, that MSCA.
2. **Signature length:** confirm the Gateway API accepts ~1 KB contract signatures (the canary suggests yes).
3. **v0.8:** Circle has not deployed v0.8 on any mainnet; the module is ready for when it is.
4. **Better long-term (the Circle ask):** native per-depositor intent policy in Gateway, or a signature-validation
   hook in Circle's v0.7 multisig that can return `0xffffffff` instead of reverting.

## Files

| File | Role |
| --- | --- |
| `contracts/src/bufi/gateway-guard/GatewayIntentPolicy.sol` | structs, EIP-712 digests, scalar checks, non-reverting ERC-1271 helper |
| `contracts/src/bufi/gateway-guard/IGatewayIntentGuard.sol` | shared ABI: init struct, events, errors, setters, views |
| `contracts/src/bufi/gateway-guard/GatewayIntentGuardCore.sol` | per-account config + policy evaluation |
| `contracts/src/bufi/gateway-guard/GatewayIntentGuardPlugin.sol` | v0.7 plugin (pre-runtime hook on `isValidSignature`) |
| `contracts/src/bufi/gateway-guard/GatewayIntentGuardModule.sol` | v0.8 validation-hook module |
| `contracts/src/bufi/gateway-treasury/GatewayTreasury.sol` | refactored onto the library; nested contract owners |
| `contracts/test/bufi/gateway-treasury/GatewayTreasuryNested.t.sol` | nested owners: mocks + real Circle v0.7 MSCA owner |
| `contracts/test/bufi/gateway-guard/GatewayIntentGuardPlugin.t.sol` | v0.7, on `CircleStackHarness` (Circle canonical bytecode) |
| `contracts/test/bufi/gateway-guard/GatewayIntentGuardModuleV08.t.sol` | v0.8, on `CircleV08Harness` |

## Test results (forge, 2026-10-05)

```
cd contracts && forge test --match-path 'test/bufi/gateway-*/*'
GatewayTreasuryTest                    54 passed  (42 original + 12 review-finding regressions)
GatewayTreasuryNestedOwnersTest        28 passed
GatewayTreasuryCircleMscaOwnerTest      4 passed
GatewayIntentGuardPluginTest (v0.7)    42 passed  (38 + 4 review-finding regressions)
GatewayIntentGuardModuleV08Test        14 passed
142 passed, 0 failed
```

Full default profile: 458 passed, 0 failed on the working tree at the time (454 on a clean checkout; see docs/EVIDENCE-LEDGER.md §6). Fuzz tests also pass at 1,024 runs (`FOUNDRY_PROFILE=ci`).
Mutation checks: removing the nested ERC-1271 call fails 11 tests; making the v0.7 hook a no-op fails 24; making
the v0.8 hook a no-op fails 7.

Gas (forge, warm): guarded v0.7 `isValidSignature` 55,276; guarded v0.8 45,265; GatewayTreasury with EOA + nested
Circle MSCA owner 99,561.
