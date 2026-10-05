# @bufi6900/weighted-treasury

One weighted-multisig + recipient-allowlist treasury spec, compiled to two chains with the same meaning:

- `compileEvm(spec)` → Circle MSCA inputs (WeightedWebauthnMultisigPlugin owners/weights/threshold +
  ColdStorageAddressBookPlugin seed), the same fields as `@bufi6900/treasury-kit`'s `DeployTreasuryInput`.
- `compileSquads(spec)` → Squads Smart Account Program plan: settings (all owners, admin timelock) and one
  SpendingLimit policy per minimal winning coalition × asset, `destinations` = the allowlist.
- `toSdkPolicyCreateActions(plan, { PublicKey, BN })` → `SettingsAction::PolicyCreate` objects for
  `@sqds/smart-account`, using the runtime types you inject.

Both compilers refuse a spec they cannot express exactly. No dependencies. Apache-2.0.

```bash
bun test test                          # parity: EVM rule ⇔ Squads policies on every owner subset
bun run squads:sdk && bun run devnet:proof   # live proof on Solana devnet (needs ~0.2 devnet SOL)
```

Design, proof results and the v2 proposal: [`docs/WEIGHTED-TREASURY-SQUADS.md`](../../docs/WEIGHTED-TREASURY-SQUADS.md).
