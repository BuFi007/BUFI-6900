# Threat model: BUFI cascade wallets on Circle MSCA

## Actors

| Actor | Holds | Can |
| --- | --- | --- |
| **Owner set** (weighted passkey / EOA multisig, `WeightedWebauthnMultisigPlugin`) | k-of-n signatures | anything the account can do: `execute`, `installPlugin`, `uninstallPlugin`, owner rotation, address-book edits, grant / revoke session keys, adopt earn configs |
| **Agent session key** (`BufiSessionKeyPlugin`) | one EOA private key, held by an AI agent runtime | `executeWithSessionKey` within its access list, spend limits, gas limit, time range; nothing else |
| **Earn relayer** (`BufiEarnModule`) | an EOA on the module's relayer list | trigger `autoEarn` (approve + deposit into an account-adopted ERC-4626 vault); cannot withdraw |
| **Earn module owner** (BUFI ops) | module `Ownable` owner | register vault configs (produces a new content-addressed hash); cannot change what an account has adopted |
| **Bundler / paymaster** | tx submission, gas sponsorship | reorder, delay, drop userOps; a paymaster can refuse to sponsor; neither can forge validation |
| **Circle factory owner** (`0x0166EA90E565476f13c6a0D25ED2C35599E58785`, per `contracts/deployments/*.json`) | `setPlugins` on the production factory | allowlist plugins for *init-time* install only; has no power over deployed accounts |
| **Plugin author** (BUFI) | source | a malicious plugin update cannot reach an account without the owner set installing it (plugins are immutable contracts; accounts pin them by address + manifest hash) |

**`BufiSessionRecipientHookPlugin` grants no actor any power.** It holds no keys, has no execution functions,
no owner and no admin. It only *removes* reach from the agent session key. The one thing it introduces is a
binding, chosen at install by the owner set: which AddressBook plugin this account's agent path reads.

## Assets

USDC/EURC and other ERC-20 held by treasury / operations / agent MSCAs; native gas balances and EntryPoint
deposits; the integrity of the owner set; the recipient allowlist; the agent's grant envelope.

## Invariants the plugins must hold

1. **No plugin widens owner authority.** Session keys and the earn relayer are strictly less powerful than the
   owner set; management functions are reachable only through owner-validated userOps.
2. **Every spend by a session key is bounded on-chain** by the key's access list, spend limits (with refresh
   intervals), gas limit and time range; expiry is enforced by the EntryPoint's validation-data time range
   (gas-free revocation by time).
3. **Funds never leave the account through `BufiEarnModule`.** It can only `approve` + `deposit` into a vault
   whose config hash the account explicitly adopted; shares mint to the account itself.
4. **Content-addressed configuration.** Re-registering a vault produces a new hash; an account keeps pointing at
   the old one until its owners adopt the new one.
5. **Fail-closed dependency slots.** On weighted-multisig accounts, runtime-validation dependencies point at an
   unimplemented function id, so nothing can be managed by a bare runtime call.
6. **ERC-4337 storage rules.** Validation-phase reads stay within account-associated storage so bundlers accept
   the ops (inherited from the audited originals; preserved in the port).
7. **One allowlist, both paths.** With `BufiSessionRecipientHookPlugin` installed, an agent's
   `executeWithSessionKey` and the owners' `execute` are gated by the **same on-chain set**: the AddressBook the
   account itself installed, read live at validation time. There is no mirrored per-key recipient list, so there
   is nothing to drift: `addAllowedRecipients` is visible to the agent on the next op and
   `removeAllowedRecipients` closes it on the next op, with no per-key re-issuance.
8. **The hook only narrows.** It can reject an op the session key would have allowed; it can never permit one the
   session key rejects, because Circle's account runs pre-userOp hooks *before* the plugin's own validation and
   both must pass. Uninstalling the AddressBook clears its set, which closes the agent path while opening the
   owners' `execute` path. The asymmetry is deliberate and is the fail-closed direction for the agent.

## Attack surfaces and mitigations

| Threat | Surface | Mitigation / test |
| --- | --- | --- |
| Agent key exfiltrated | `executeWithSessionKey` | access list + spend limits + expiry bound the loss; owners `removeSessionKey`/`rotateSessionKey` (`AgenticWalletPolicy.t.sol::owner_revokes_mid_grant`) |
| Agent tries to escalate | management selectors, `installPlugin`, `execute` | plugin's own userOp validation only accepts `executeWithSessionKey`; other selectors validate against the owner set (`::agent_cannot_escalate`) |
| Agent sends tokens to an unlisted recipient | `executeWithSessionKey` is a different selector from `execute`, so Circle's AddressBook hooks (keyed by selector) never fire on it. A key scoped to `USDC.transfer` may name **any** recipient: the access list sees `Call.target` + selector, never the address inside ERC-20 calldata. | **`BufiSessionRecipientHookPlugin`** registers a `preUserOpValidationHook` on that selector, decodes `(Call[], address)`, resolves each recipient with `RecipientAddressLib` and requires it in the account's AddressBook set (`BufiSessionRecipientHookPlugin.t.sol`). Without the hook installed the mitigation is grant-side only. The access list must encode recipients as function-level entries (`docs/PLUGIN-COMPOSITION.md`, `SessionKeyWithAddressBook.t.sol`). |
| Agent calls an allowlisted **contract** with hostile calldata | the hook's fallback branch: a zero-value call with no decodable token recipient is judged by its **target**, not by a recipient | **Not mitigated, by design.** The allowlist gates *which contracts an agent may reach*, not what those contracts then do. An allowlisted escrow that transfers out on some path will do so. Adversarial findings F-02 / F-03. The bound is the session key's own spend limits and access list, which still apply. |
| Owners install the hook against an AddressBook that is not theirs | `onInstall(abi.encode(addressBook))` | `onInstall` requires the address to be non-zero, have code, declare `IAddressBookPlugin` via ERC-165, **and** be in the installing account's own `IAccountLoupe.getInstalledPlugins()`. "Same set as the owners" is a checked property, not a convention. |
| Hook or session-key plugin uninstalled to re-open the agent path | `uninstallPlugin` | uninstall needs an owner-validated userOp, so this is the owner set acting deliberately. The hook declares no dependencies (`SELF`-typed), so neither plugin blocks the other's uninstall. Install order is free, and removing the hook is an owner decision that is visible on-chain. |
| Hook makes agent ops unbundleable | it runs inside `validateUserOp` | reads only `_addressBookOf[account]` and the AddressBook's account-keyed set (ERC-7562 [STO-021]); no `TIMESTAMP`/`NUMBER`/`BALANCE`/`GASPRICE`, no writes. It does make one `STATICCALL` into the AddressBook and one `EXTCODESIZE` per zero-value call. That is the same class of cross-contract access the account already performs on `execute`, but a strict tracer may surface it; allowlist it if a custom bundler is used. |
| Gas griefing by the agent | gas spend limit measured as EntryPoint v0.7 required prefund | `SessionKeyOnCircleMsca.t.sol` gas-limit cases; `PORT-NOTES.md` §gas |
| Relayer drains via earn | `autoEarn` → `executeFromPluginExternal` | only approve+deposit toward the adopted config; vault must be trusted at adoption time; AddressBook does not gate this path (documented) |
| Malicious vault registered by module owner | `setConfig` | new hash, not adopted; accounts unaffected until owners adopt (`BufiEarnModuleOnMsca.t.sol`) |
| Plugin uninstall leaves dangling hooks / state | `uninstallPlugin` | Circle `PluginManager.uninstall` + plugin `onUninstall`; tests assert clean state and that dependents block uninstall |
| Cross-account state leakage | account-associated storage | isolation tests (two accounts, same plugin) |
| Factory allowlist abuse | `setPlugins` | only affects init-time installs; post-creation installs need owner userOps regardless |

## Residual risks (accepted, documented)

- The earn relayer can deposit at a bad time (liquidity timing), never withdraw.
- Session-key spend limits are per-key, per-account; an agent with several keys has several envelopes. Grant
  issuance policy lives in the owner-side application layer.
- A compromised bundler can censor but not forge; a compromised paymaster can only refuse.
- WebAuthn owner recovery is Circle's `msca-wallet-recovery` lane (forked here as `packages/msca-recovery`).
- **The recipient hook is new, unaudited BUFI code with no audited ancestor to diff against.** Every other
  in-scope contract is a port of something Spearbit, Quantstamp or Ackee already reviewed. This one is not.
- An allowlisted contract is trusted for whatever its own calldata does. The hook narrows *reachability*, not
  behaviour; see the F-02 / F-03 row above.
- Recipient membership is a linear scan over `getAllowedRecipients`, `O(calls x n)` inside validation. Large
  allowlists raise simulation cost for every agent op naming that selector.
- If an AddressBook holding 5000+ entries is uninstalled, Circle's `onUninstall` leaves the set in place
  (`AllowedAddressesNotRemoved`). The hook then keeps enforcing that frozen set. It never widens, but it can
  outlive the owners' intent. Re-check the set after any large-allowlist uninstall.

---

# Gateway treasury (`GatewayTreasury`) and Solana delegate

Live deployment: GatewayTreasury v2 `0xC3f4De2372167F7FFA0a1B3FbF221a8a7289e7d5` on Arc testnet (v1 `0x692Db08885870fA99ADA4Acdee02633947669daF` is
superseded). Every address and hash is in `docs/EVIDENCE-LEDGER.md`. Review findings and their tests are in
`docs/SECURITY-REVIEW-GATEWAY.md`.

## Actors

| Actor | Holds | Can |
| --- | --- | --- |
| **Owner quorum** (weighted EOAs; contract owners via ERC-1271, forge-tested only) | weight >= threshold of signatures | sign burn intents (answered by the treasury's `isValidSignature`, kind 0), sign a `ReceiveWithAuthorization` to the Gateway wallet for Gateway's `depositWithAuthorization` (kind 1), `revokeIntent`, `pause`, queue timelocked admin ops (owners, allowlists, caps, minters, unpause, escape hatch) |
| **Anyone** | nothing | `sweepToGateway`; execute a queued admin op after its eta and before it expires |
| **Circle Gateway** (off-chain enclave + API) | the depositor balance | accept an intent only if the treasury's ERC-1271 says valid; checks against blocks up to about 5 minutes old |
| **FROST share holders** (Solana) | shares of the group key that is the Squads vault's Gateway delegate | sign Solana burn intents; `frost-delegate sign` checks `policy.json` first |
| **App dev signer** (`apps/ultimate-treasury`, dev server only) | sandbox owner keys and FROST shares on disk | build, sign and submit sends for loopback callers |

## Invariants

1. A burn intent validates only if the treasury is not paused, the digest is not revoked, a quorum signed it,
   **and** it passes the intent policy: source domain, Gateway wallet, depositor and signer pinned to this treasury;
   source token allowlisted; no hook data; destination domain allowed; destination contract equal to that domain's
   minter; destination token and recipient on their allowlists and shaped for the domain (20 bytes EVM, 32 bytes
   Solana); destination caller zero (any caller) or on its own allowlist and shaped for the domain; value nonzero
   and at most `perIntentCap`; fee at most `maxFeeCap`; expiry within `maxExpiryBlocks`.
2. Per-intent debit is at most `maxDebitPerIntent()` = `perIntentCap + maxFeeCap` (4.01 USDC on v2).
3. Policy changes are timelocked admin ops that expire 7 days after eta and die on owner or timelock change
   (epoch). Signed but unqueued ops can be cancelled.
4. Stopping is fast, starting is slow: `revokeIntent` and `pause` have no timelock; unpause is timelocked.
5. `isValidSignature` never reverts. A nested owner call is capped at 1,000,000 gas. An owner that names the
   treasury itself is refused before any call. Mutual nesting is cut off by the gas cap and returns invalid
   (`test_nested_mutualRecursion_terminatesInvalid`).

## Attack surfaces and mitigations

| Threat | Surface | Mitigation / test |
| --- | --- | --- |
| Quorum tricked into signing a burn to a stranger | `isValidSignature` | recipient allowlist per domain shape (`test_GT1_recipientShapeBoundToDomain`); live: Gateway 400 for S, generic ERC-1271 refusal message (ledger §1); the cause is pinned by the forge test, not by Gateway's message |
| Sub-threshold signers | `isValidSignature` | weighted threshold; live: Gateway 400 for B+C, generic ERC-1271 refusal message (ledger §1); the cause is pinned by the forge tests, not by Gateway's message |
| Intent for another source chain or a fake minter | `sourceDomain`, `destinationContract` | pinned (`test_GT4_destinationContractAndSourceDomainPinned`) |
| Relayer used as payee | `destinationCaller` | separate caller list (`test_GT6_destinationCallerNotImpliedByRecipientAllowlist`) |
| Leaked or stale admin signatures | admin queue | deadline, expiry, epoch, `cancelAdmin` (`test_GT2_*`, `test_GT3_*` in `GatewayTreasury.t.sol`) |
| Signed intent must be stopped before submission | Gateway | `revokeIntent` / `pause` (`test_GT2_revokeIntent_immediate`, `test_GT2_pause_immediate_unpauseTimelocked`); effective only after Gateway's block lag |
| Solana delegate signs anything | FROST group key | `frost-delegate` policy coordinator (`policy_refuses_each_violation`); off-chain only |
| Dev signer reachable from LAN or another origin | Vite plugin | socket + full-origin check, `/@fs` deny list (`apps/ultimate-treasury/server/hardening.test.ts`) |

## Residual risks (accepted, documented)

- Fee is not bounded relative to value; one small intent can pay a fee larger than its value.
- Revoke and pause reach Gateway only after its block lag (up to about 5 minutes), and pause needs the quorum.
  Gateway can still burn from the withdrawing balance.
- A failed admin op is not consumed; it stays executable until expiry, epoch change or cancel.
- Solana policy is off-chain. Share holders who sign without `frost-delegate` are not bound. The app server
  also checks the EVM on-chain allowlist; `policy.json` and that allowlist are kept in sync by hand.
- The sandbox DKG runs every participant in one process, so the sandbox threshold property is not real.
- The app's signer is dev-only by design; the app is not deployable as a hosted preview.
- Nested ERC-1271 owners: proven live on Arc testnet with a real Circle MSCA owner (ledger §7). The 1,000,000-gas cap
  on a nested owner call held for a 2-of-3 EOA-owned MSCA; heavier owners (passkeys without the P-256 precompile)
  are not measured against Gateway.

# GatewayIntentGuard (`contracts/src/bufi/gateway-guard/`)

The same intent policy for Circle ERC-6900 accounts: a v0.7 plugin (pre-runtime hook on `isValidSignature`, intent
carried as a trailer after Circle's multisig signature) and a v0.8 validation-hook module. Design in
`docs/GATEWAY-INTENT-GUARD.md`. **The v0.7 plugin is proven live on a real Circle MSCA on Arc testnet (ledger §8): Gateway runs the pre-runtime
hook and treats its revert as an invalid signature. The v0.8 module is tested in forge only.**

## Invariants

1. With the guard installed, the account's ERC-1271 answers valid only for a Gateway burn intent that passes the
   shared `GatewayIntentPolicy` (same checks as the treasury, invariant 1 above).
2. Address-book recipients count only on EVM domains (`test_GG1_addressBookRecipient_refusedOnSolanaDomain`).
3. The guard only narrows: Circle's multisig must still accept the signature.

## Residual risks (accepted, documented)

- **No timelock.** The quorum can reconfigure the guard at once, or uninstall it in v0.7 and reopen plain
  ERC-1271. In v0.8 only validations carrying the hook are guarded.
- **Gateway-only ERC-1271.** Installing it breaks other ERC-1271 uses on the same account (for example a
  quorum-signed `ReceiveWithAuthorization` to a non-Gateway recipient). Use a dedicated depositor account.
- **The guard does not see delegates.** The quorum can add a Gateway delegate through `execute`, which never
  reaches `isValidSignature`.
- **Unproven against Gateway.** Whether Gateway's simulation runs the v0.7 hook through the MSCA proxy, passes the
  trailer unchanged, and treats a hook revert as an invalid signature is unknown until a live canary runs.
- New, unaudited BUFI code with no audited ancestor.
