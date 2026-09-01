# Audit scope — BUFI-6900

## In scope (BUFI-authored or BUFI-ported Solidity)

| Path | Lines of concern | Notes for the auditor |
| --- | --- | --- |
| `contracts/src/bufi/v0.7/session/**` | `BufiSessionKeyPlugin.sol`, `permissions/*`, vendored libraries | Port of alchemyplatform/modular-account **v1.0.1** `src/plugins/session/**` (audited: Spearbit 2024-01-31 `0e3fd1e`, Quantstamp 2024-02-20 `8ae319e`, both PDFs in `contracts/lib/alchemy-modular-account/audits/`). Every deviation from the audited original is enumerated with line references in `PORT-NOTES.md`. Please diff against upstream rather than reading from scratch. |
| `contracts/src/bufi/v0.7/earn/**` | `BufiEarnModule.sol` | Port of fluidkey/fluidkey-earn-module (Ackee-audited Safe module, Rhinestone AutoSavings lineage) to an ERC-6900 v0.7 plugin. Deviations listed in `EARN-NOTES.md`. |
| `contracts/src/bufi/v0.8/gateway/**` | `GatewayExecutionModule.sol`, `GatewayHelper.sol` | ERC-6900 **v0.8** execution module for Circle Gateway (delegate lifecycle). Targets the v0.8 account generation, not the v0.7 production accounts. |
| `contracts/test/harness/**`, `contracts/test/**` | — | Test code; in scope only insofar as the auditor relies on it to reproduce claims. |

## Out of scope (vendored, unmodified, already audited by their owners)

- Circle `buidl-wallet-contracts` (`contracts/lib/buidl-wallet-contracts`, pinned `3c47aa9`): `UpgradableMSCA`,
  `UpgradableMSCAFactory`, `PluginManager`, `PluginExecutor`, `WeightedWebauthnMultisigPlugin`,
  `ColdStorageAddressBookPlugin`, `SponsorPaymaster`. The sandbox deploys **Circle's shipped creation bytecode**
  (`script/bytecode-deploy/build-output/*.json`), not a recompilation.
- eth-infinitism EntryPoint v0.7, OpenZeppelin 5.0.2, solady, FreshCryptoLib, erc6900 reference/libs.
- The TypeScript packages (`packages/**`) — they encode calldata and drive the sandbox; they hold no funds and
  are not part of the on-chain trust boundary. Reviewers are welcome to use them to reproduce flows.

## Claims the suites substantiate (each maps to a test name)

1. Circle's stack is recreated bit-for-bit at canonical addresses; manifest hashes equal the SDK's pinned
   constants — `test/stack/CanonicalStack.t.sol::test_canonicalAddressesAndManifestHashes`.
2. A k-of-n weighted multisig account created through the production factory installs
   ColdStorageAddressBookPlugin with the production dependency-slot arrangement, and the allowlist gates
   `execute` transfers — `::test_weightedMultisigLifecycle_2of3_withAddressBook`.
3. The address-book runtime path is fail-closed on weighted accounts (dependency slot 0 → unimplemented
   function id 1) — `::test_addressBookRuntimePathIsFailClosed`.
4. `BufiSessionKeyPlugin` installs on the production account, enforces access lists / spend limits / gas
   limits / time ranges / required paymaster, isolates state per account, cannot escalate, and is uninstallable —
   `test/bufi/v0.7/session/**`.
5. Composition matrix (Weighted + AddressBook + SessionKey + Earn on one account) and the exact selector
   coverage of each hook — `docs/PLUGIN-COMPOSITION.md`, `test/bufi/v0.7/session/SessionKeyWithAddressBook.t.sol`,
   `test/bufi/v0.7/earn/BufiEarnModuleOnMsca.t.sol`.
6. `BufiEarnModule` deposits only into vaults the multisig adopted (content-addressed config hash) and only
   from an authorised relayer; funds cannot leave the account through it —
   `test/bufi/v0.7/earn/**`.

## Known limitations the auditor should not rediscover

- WebAuthn (P-256 passkey) owners are exercised by Circle's own suites, not ours; our harness signs with EOA
  owners in the same wire format (`BaseMultisigPlugin.checkNSignatures`). The plugin under test does not depend
  on owner key type.
- The mock Circle API does not verify WebAuthn attestations (`rp_*` are stubs); it is a transport stand-in.
- Fork suites under `test/fork/**` need a Sepolia RPC and are excluded from the default profile.
