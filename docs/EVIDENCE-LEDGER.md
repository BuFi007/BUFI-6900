# Evidence ledger: Ultimate Treasury on Circle Gateway (testnet)

The single source for every address and transaction hash the other docs cite. Full values, no truncation.
Chains: Arc testnet (chainId 5042002, Gateway domain 26), Base Sepolia (domain 6), Solana devnet (domain 5).
Explorers: Arc testnet `https://testnet.arcscan.app/tx/<hash>`, Base Sepolia `https://sepolia.basescan.org/tx/<hash>`,
Solana devnet `https://explorer.solana.com/tx/<sig>?cluster=devnet`.

## Actors (sandbox keys, gitignored under `.sandbox/ultimate-treasury/`)

| Role | Address |
| --- | --- |
| Owner A (weight 2) | `0x5fC11d3f4C37a02EaB41B71E18Af0486D6348c06` |
| Owner B (weight 1) | `0x13898C82DF06B860a4ded8896c601Cb82394870d` |
| Owner C (weight 1) | `0xCf1478c67eE1e073988Fc9018bCb0DFA5FB0f2E7` |
| R (allowlisted recipient) | `0xF7D0520C36717e25c5b77F977A89741d2974589C` |
| S (not allowlisted) | `0xd21389825CeB0843d108F639c9C70B55caa30A28` |
| EVM fee payer / deployer | `0x09Ce8E2B3Fede2727dA4392Ea8Fe618305ba0474` |
| Solana fee payer | `4EZgQyZN36gQsyzVUU7itVEmLzxcjTKkYtcZxEaVuP9W` |

## 1. GatewayTreasury v2 (current source: nested owners, review fixes) — 2026-10-05

Deployed `0xC3f4De2372167F7FFA0a1B3FbF221a8a7289e7d5`, tx `0x3650cc2d8d1d5aebac60915b3acc20e1bbdc6e8765656d8fd9906a93f10624ab`
(broadcast `contracts/broadcast/DeployGatewayTreasury.s.sol/5042002/run-1791172223279.json`). Read back: threshold 3,
localDomain 26, maxExpiryBlocks 1,250,000, maxDebitPerIntent 4.01 USDC. Canary `scripts/gateway-treasury/canary.ts`:

| Step | Hash / result |
| --- | --- |
| Deposit A: USDC transfer to treasury | `0xaca91b0d44c6d740cde4fbd4cadb1106513bafb71fe11edcabca521a9a771888` |
| Deposit A: `sweepToGateway` (3 USDC) | `0xd437cc7f6860313c402770fe568bda45b937e04fedba33c2ab0f11c61832525a` |
| Deposit B: quorum-signed `depositWithAuthorization` (1 USDC) | `0xd62b37c6582d27c9b8d77252d2b56d7fe9c23b4226df1097a85cd323b05086ec` |
| Burn intent to S (not allowlisted), A+B | Gateway 400 "Invalid signature: contract signature verification request failed" (reproducible, not on-chain) |
| Burn intent to R, B+C (weight 2 < 3) | Gateway 400, same message (reproducible, not on-chain) |
| Burn intent to R, A+B, 1 USDC, `contractSigner:true` | Gateway 201 |
| `gatewayMint` on Base Sepolia, R 1.25 → 2.25 USDC | `0x2811ea79eff095289d6ddce116bbf44ff27ada534d9cdc82dd5cf7c86aac4ca5` |

## 2. GatewayTreasury v1 (pre-review bytecode, superseded) — 2026-10-05

Deployed `0x692Db08885870fA99ADA4Acdee02633947669daF`, tx `0xc13a957d5d937ad0216f4b35aae80bd9a6d7d8853534fadbb0ecb60177f3a8b7`.
Its proofs predate the review fixes; v2 above re-proves the same flow on current source.

| Step | Hash |
| --- | --- |
| Deposit A transfer / sweep | `0xd990c6192d40772f53d36142f82f51f2cbb8131f6e388449420906cf366f8cab` / `0x9d236e641515b818192688ac829978d272713e233c815e96efb86a57f7b07a0d` |
| Deposit B `depositWithAuthorization` | `0xb9d5bc6e389183f35455fb69a3c3e3b787249607c8ea8c2ca6d3301e0b28f4a2` |
| `gatewayMint` Base Sepolia (1 USDC to R) | `0x9c5b49d49dbef4e58667356035e3295c5585cf59feaee3616fd0ea8e96e49277` |
| App EVM send, 0.25 USDC A+B → R, mint on Base Sepolia | `0xd03bea29bcd9fd21fc170e2a1ce5417a36c7e154f2138b0a04e646e8c2e09238` |

## 3. Solana leg: Squads vault + FROST threshold Gateway delegate — 2026-10-05

FROST group key (the delegate) `EBjX3U8y1S1weZBNGooB7Ab3YmsFLNGK5W6EVYKhL3c2`; shares A:[1,2] B:[3] C:[4], threshold 3.
Squads smart account (settings) `AVfkRovDYbmb3Nf7nUGdrubYWykeoY4vtphPusjnMshz`, vault `AtBgen532MGQmGjhmKcXRHxaBpSDz1ML6WXuUYw1yy9B`.
Script `packages/weighted-treasury/scripts/gateway-solana-delegate.ts`.

| Step | Signature / hash |
| --- | --- |
| `deposit_for` vault, 3 USDC | `qbsyMA5Z7ma3ExbQkz5VDMmtvYCh7CyrEpCT2Fu5ETN9zUMkz2pDDRkEiMNUJu5zYASbRYnCJpiV5qKUxpwdCDg` |
| `add_delegate(group key)` via Squads, all 3 owners | `26rFMVScZsc2sXEBo9knwPoeP7WfAdxxdCQ676Rgu8KSm6xfRbWFCX5dkHxj3Fsx9Q6DXkaqPGDRAdMGKL8JwKJ1` |
| B+C (2 of 4 shares) | no signature possible (below threshold) |
| Owner A's own key as signer | Gateway 400 "Signer is not authorized to spend funds from sourceDepositor" (reproducible) |
| A+B FROST signature, Solana → Arc, 1 USDC to R, `gatewayMint` on Arc testnet | `0x24f28de341f43f42d5b0cf0f1fdc90f6f52697466ae4d95e806ec7f9d4427163` |
| App Solana send, 0.25 USDC A+B → R, mint on Arc testnet | `0xd04c6001a6c1b4e4850da81456bfc57354ffde6e34e7162f8d00db174b0d334d` |

## 4. Squads weighted policies (Smart Account Program) — 2026-10-04

`packages/weighted-treasury/scripts/devnet-proof.ts`. Devnet settings account `C5QBLUm2XzJx9pzhmttoiJtqnz1VFQxJgQZJBx6m4oeS`.
Localnet runs (mainnet `SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG` cloned) passed the same assertions; localnet
accounts are ephemeral and not listed.

## 5. Measured Gateway behaviour (testnet, 2026-10-05)

| Fact | Value |
| --- | --- |
| Arc testnet `maxBlockHeight` floor above head | 1,209,599 blocks (desk `packages/circle-kit/src/burn-intent.ts`) |
| Solana devnet `maxBlockHeight` floor above head | 3,024,000 slots ("expected at least 510600547, got 509576547" with a +2,000,000 attempt) |
| ERC-1271 refusal message | "Invalid signature: contract signature verification request failed" |
| Non-delegate Solana signer | "Signer is not authorized to spend funds from sourceDepositor" |
| New Solana delegate | refused with the same message until Gateway indexes it; on-chain delegate account already `Authorized` |

## 6. Test counts (working tree at commit time, 2026-10-05)

- `cd contracts && forge test --match-path "test/bufi/gateway-*/**"`: 142 passed (GatewayTreasuryTest 54, GatewayTreasuryNestedOwnersTest 28, GatewayTreasuryCircleMscaOwnerTest 4, GatewayIntentGuardPluginTest 42, GatewayIntentGuardModuleV08Test 14). Full default profile: 454 passed on a clean checkout of the committed tree (458 on the working tree, which also held 4 tests from an unrelated untracked file).
- `cd packages/weighted-treasury && bun test test`: 36 passed (includes the UT-8 regression test).
- `cd apps/ultimate-treasury && bun test server`: 22 passed.
- `cd tools/frost-delegate && cargo test`: 5 passed.

## 7. Nested ERC-1271 owner, live against Gateway — 2026-10-05

Setup `contracts/script/gateway-guard/LiveGatewaySetup.s.sol` (addresses in `contracts/deployments/arc-testnet.gateway-live.json`);
canary `scripts/gateway-treasury/live-nested-and-guard.ts --only nested`.

| Step | Hash / result |
| --- | --- |
| Circle v0.7 MSCA M1 `0x96D2534Cce5b4C90E6EA75926Dc976813b2A45D7` via Circle's factory `createAccount` (owners N1/N2/N3, 2-of-3) | `0xdde8a38c4fff4149a819afe01406110d87c7ae1f39afec677bddecb33bd7b398` |
| GatewayTreasury v3 `0x7671e34415652194Adc7Db58aF98f0EF123755E5`: owners EOA A (2) + MSCA M1 (1), threshold 3 | `0xca79d1ff6fe3ccddee4984f43700af0e76cb7648aa56852a069e13fdac7ba30b` |
| Deposit: transfer / `sweepToGateway` (3 USDC) | `0x875ff812e00535f221b27df388be276ebe4ef7d6a3ebe88048c0b01a970a549c` / `0x12be40f1c922dc9efde5e80409c05a691b8e8b25d7ef08806f75c13b6bab7cfe` |
| A + M1 where M1 signed 1-of-3 (below its own threshold) | Gateway 400 "Invalid signature: contract signature verification request failed" (reproducible) |
| A + M1 (2-of-3), `contractSigner:true` | Gateway 201 |
| `gatewayMint` on Base Sepolia, R 2.25 → 3.25 USDC | `0x339baf468daa19d275b7d2c2b40725612ecae05c35a097cead9ae97fb692c71f` |

Gateway's enclave follows a nested call: treasury `isValidSignature` → Circle MSCA `isValidSignature` (proxy delegatecall,
weighted multisig plugin), within its simulation gas.

## 8. GatewayIntentGuardPlugin on a real Circle MSCA, live against Gateway — 2026-10-05

| Step | Hash / result |
| --- | --- |
| Circle v0.7 MSCA M2 `0x44033b5b17B52DdF92d4B3b209031a0D0c9e3B85` via `createAccount` (owners A=2, B=1, C=1, threshold 3) | `0x37aa412419331a87ee21753474f931a1b757500cafdb2b3a705aeaa231af0134` |
| GatewayIntentGuardPlugin `0x9586776fa5eFAa0DD1251dF947A3Df8113EF9B59` deployed | `0xea10b0f519fcd107eb84cb609df768a93d8893f6b13d77ffee56f18d1df3d0ac` |
| M2 prefund (0.5 native USDC for its own gas) | `0xdc4437273f7cb672ad3808e65e4bc0ae1a9b9e3d03597071dec30c898720b5d0` |
| First self-bundled `handleOps` (installPlugin) | `0x6a92111b63c7b25afbdec0533e1d0dd1d4e37a93a7130707f94bf82a27ef4ca0` failed: transaction gas below the op's declared limits |
| `handleOps` → `installPlugin(guard)`, multisig-signed user operation (UserOperationEvent success = 1) | `0x37487851878e234d9cc8997c45c62037ef9ef3c2ed47e9b64baa60c1d3824203` |
| `getInstalledPlugins(M2)` | `[0x0000000C984AFf541D6cE86Bb697e68ec57873C8 (weighted multisig), 0x9586776fa5eFAa0DD1251dF947A3Df8113EF9B59 (guard)]` |
| Deposit: guard-checked ERC-3009 `depositWithAuthorization` (3 USDC, kind-1 envelope) | `0xaa526a37848bf70ad6ec5f784bf8e8638c9d9b5e4be67b25ec6203d90286021e` |
| Full quorum → S (not allowlisted), with envelope | guard reverts locally; Gateway 400 "Invalid signature: contract signature verification request failed" (reproducible) |
| Full quorum → R, quorum signature with NO intent envelope (blind) | guard reverts locally; Gateway 400, same message (reproducible) |
| A+B → R with the intent envelope, `contractSigner:true` | Gateway 201 |
| `gatewayMint` on Base Sepolia, R 3.25 → 4.25 USDC | `0x7ab0f39afc0af7313a90d91202ed800f35b543846da6bbd3958cc1c7349b5146` |

Gateway's enclave runs Circle's v0.7 pre-runtime validation hook on `isValidSignature`, passes the signature bytes through
unchanged (the trailer included), and treats a hook revert as an invalid signature. No Circle contract change was needed:
the plugin was installed with an ordinary multisig-signed user operation after creation (the factory allowlist only
governs plugins installed at creation).

## Not proven live

The v0.8 `GatewayIntentGuardModule` (forge only); EURC; any mainnet flow.
