# Threat model — BUFI cascade wallets on Circle MSCA

## Actors

| Actor | Holds | Can |
| --- | --- | --- |
| **Owner set** (weighted passkey / EOA multisig, `WeightedWebauthnMultisigPlugin`) | k-of-n signatures | anything the account can do: `execute`, `installPlugin`, `uninstallPlugin`, owner rotation, address-book edits, grant / revoke session keys, adopt earn configs |
| **Agent session key** (`BufiSessionKeyPlugin`) | one EOA private key, held by an AI agent runtime | `executeWithSessionKey` within its access list, spend limits, gas limit, time range; nothing else |
| **Earn relayer** (`BufiEarnModule`) | an EOA on the module's relayer list | trigger `autoEarn` (approve + deposit into an account-adopted ERC-4626 vault); cannot withdraw |
| **Earn module owner** (BUFI ops) | module `Ownable` owner | register vault configs (produces a new content-addressed hash); cannot change what an account has adopted |
| **Bundler / paymaster** | tx submission, gas sponsorship | reorder, delay, drop userOps; a paymaster can refuse to sponsor; neither can forge validation |
| **Circle factory owner** (`0x0166EA…`) | `setPlugins` on the production factory | allowlist plugins for *init-time* install only; has no power over deployed accounts |
| **Plugin author** (BUFI) | source | a malicious plugin update cannot reach an account without the owner set installing it (plugins are immutable contracts; accounts pin them by address + manifest hash) |

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

## Attack surfaces and mitigations

| Threat | Surface | Mitigation / test |
| --- | --- | --- |
| Agent key exfiltrated | `executeWithSessionKey` | access list + spend limits + expiry bound the loss; owners `removeSessionKey`/`rotateSessionKey` (`AgenticWalletPolicy.t.sol::owner_revokes_mid_grant`) |
| Agent tries to escalate | management selectors, `installPlugin`, `execute` | plugin's own userOp validation only accepts `executeWithSessionKey`; other selectors validate against the owner set (`::agent_cannot_escalate`) |
| Agent bypasses recipient allowlist | `executeWithSessionKey` is a different selector from `execute`, so AddressBook hooks do not fire | the grant's access list must encode recipients (function-level entries); see `docs/PLUGIN-COMPOSITION.md` and `SessionKeyWithAddressBook.t.sol` |
| Gas griefing by the agent | gas spend limit measured as EntryPoint v0.7 required prefund | `SessionKeyOnCircleMsca.t.sol` gas-limit cases; `PORT-NOTES.md` §gas |
| Relayer drains via earn | `autoEarn` → `executeFromPluginExternal` | only approve+deposit toward the adopted config; vault must be trusted at adoption time; AddressBook does not gate this path (documented) |
| Malicious vault registered by module owner | `setConfig` | new hash, not adopted; accounts unaffected until owners adopt (`BufiEarnModuleOnMsca.t.sol`) |
| Plugin uninstall leaves dangling hooks / state | `uninstallPlugin` | Circle `PluginManager.uninstall` + plugin `onUninstall`; tests assert clean state and that dependents block uninstall |
| Cross-account state leakage | account-associated storage | isolation tests (two accounts, same plugin) |
| Factory allowlist abuse | `setPlugins` | only affects init-time installs; post-creation installs need owner userOps regardless |

## Residual risks (accepted, documented)

- The earn relayer can deposit at a bad time (liquidity timing), never withdraw.
- Session-key spend limits are per-key, per-account; an agent with several keys has several envelopes — grant
  issuance policy lives in the owner-side application layer.
- A compromised bundler can censor but not forge; a compromised paymaster can only refuse.
- WebAuthn owner recovery is Circle's `msca-wallet-recovery` lane (forked here as `packages/msca-recovery`).
