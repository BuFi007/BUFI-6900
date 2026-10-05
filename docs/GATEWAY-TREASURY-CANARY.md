# Gateway treasury live canaries: ERC-1271 (Arc testnet → Base Sepolia) and FROST delegate (Solana devnet → Arc testnet)

Every address and hash below is also in [EVIDENCE-LEDGER.md](EVIDENCE-LEDGER.md), the single source. If the two
ever disagree, the ledger wins.

## v2 run: current source (2026-10-05)

**Result 2026-10-05: PASSED.** This is the deployment of the current `GatewayTreasury.sol` source: nested owners,
the `GatewayIntentPolicy` library and the fixes from the security review. Script: `scripts/gateway-treasury/canary.ts`.
Contract: `contracts/src/bufi/gateway-treasury/GatewayTreasury.sol`. Forge: 142 passed on the gateway paths, see the
ledger §6.

Treasury `0xC3f4De2372167F7FFA0a1B3FbF221a8a7289e7d5` (Arc testnet 5042002), deploy tx
`0x3650cc2d8d1d5aebac60915b3acc20e1bbdc6e8765656d8fd9906a93f10624ab`, broadcast
`contracts/broadcast/DeployGatewayTreasury.s.sol/5042002/run-1791172223279.json`.

Parameters (from the broadcast constructor arguments and the on-chain read back):

- Owners A `0x5fC11d3f4C37a02EaB41B71E18Af0486D6348c06` weight 2, B `0x13898C82DF06B860a4ded8896c601Cb82394870d`
  weight 1, C `0xCf1478c67eE1e073988Fc9018bCb0DFA5FB0f2E7` weight 1. Threshold 3.
- Allowlist: R `0xF7D0520C36717e25c5b77F977A89741d2974589C` only. No separate destination callers.
- Local domain 26 (pinned). Destination domain 6 (Base Sepolia) only, with its GatewayMinter
  `0x0022222ABE238Cc2C7Bb1f21003F0a260052475B` pinned as the destination contract.
- Tokens: Arc USDC → Base Sepolia USDC. Per-intent cap 2 USDC, fee cap 2.01 USDC, so `maxDebitPerIntent` = 4.01 USDC.
- Expiry ceiling 1,250,000 blocks. Admin timelock 600 s.
- Deployed by the EVM fee payer `0x09Ce8E2B3Fede2727dA4392Ea8Fe618305ba0474`.

| Step | Result | Evidence |
| --- | --- | --- |
| Deposit A: USDC transfer to the treasury | credited to the contract | `0xaca91b0d44c6d740cde4fbd4cadb1106513bafb71fe11edcabca521a9a771888` |
| Deposit A: permissionless `sweepToGateway` (3 USDC) | Gateway balance credited | `0xd437cc7f6860313c402770fe568bda45b937e04fedba33c2ab0f11c61832525a` |
| Deposit B: quorum-signed `depositWithAuthorization` (1 USDC) | credited, no user operation | `0xd62b37c6582d27c9b8d77252d2b56d7fe9c23b4226df1097a85cd323b05086ec` |
| Burn intent to **S** `0xd21389825CeB0843d108F639c9C70B55caa30A28` (not allowlisted), signed A+B | **refused** by Gateway: 400 "Invalid signature: contract signature verification request failed" | canary log (reproducible, not on-chain) |
| Burn intent to R signed **B+C** (weight 2 < 3) | **refused** by Gateway, same message | canary log (reproducible, not on-chain) |
| Burn intent to R, 1 USDC, signed A+B (weight 3), `contractSigner: true` | **201**, attestation issued | canary log |
| `gatewayMint` on Base Sepolia | R 1.25 → **2.25 USDC** | `0x2811ea79eff095289d6ddce116bbf44ff27ada534d9cdc82dd5cf7c86aac4ca5` |

What this proves: the bytecode of the current source is what Gateway's enclave ran. Its policy-checked
`isValidSignature` enforces the weighted quorum and the recipient allowlist end to end, and a correct quorum to an
allowlisted recipient is minted on a second chain.

Not proven by this run (EOA owners only). Proven since, by `scripts/gateway-treasury/live-nested-and-guard.ts`:
nested ERC-1271 owners (ledger §7) and the v0.7 `GatewayIntentGuardPlugin` on a real Circle MSCA (ledger §8).
Still unproven live: the v0.8 module, EURC, any mainnet flow.

## v1 run: pre-review bytecode (superseded)

**Superseded by v2 above.** Result 2026-10-05: PASSED, but on bytecode that predates the security-review fixes and
nested owners. It is kept as history. Do not cite it as proof of the current source.

Treasury `0x692Db08885870fA99ADA4Acdee02633947669daF` (Arc testnet 5042002), deploy tx
`0xc13a957d5d937ad0216f4b35aae80bd9a6d7d8853534fadbb0ecb60177f3a8b7`. Owners A=2, B=1, C=1, threshold 3;
allowlist R only; destination domain 6 only; Arc USDC → Base Sepolia USDC; per-intent cap 2 USDC; fee cap
2.01 USDC; expiry ceiling 1,250,000 blocks; admin timelock 600 s. Deployed by
`0x09Ce8E2B3Fede2727dA4392Ea8Fe618305ba0474`.

| Step | Result | Evidence |
| --- | --- | --- |
| Deposit A: USDC transfer | credited to the contract | `0xd990c6192d40772f53d36142f82f51f2cbb8131f6e388449420906cf366f8cab` |
| Deposit A: permissionless `sweepToGateway` (3 USDC) | Gateway balance credited | `0x9d236e641515b818192688ac829978d272713e233c815e96efb86a57f7b07a0d` |
| Deposit B: owners A+B sign ERC-3009 `ReceiveWithAuthorization`; `GatewayWallet.depositWithAuthorization` pulls 1 USDC (USDC asks the treasury's `isValidSignature`, kind 1) | credited, no user operation | `0xb9d5bc6e389183f35455fb69a3c3e3b787249607c8ea8c2ca6d3301e0b28f4a2` |
| `GatewayWallet.availableBalance` | 4 USDC | on-chain read at the time (not in the ledger, not reproducible now) |
| Burn intent to **S** (not allowlisted), signed A+B | **refused** by Gateway: 400 "Invalid signature: contract signature verification request failed"; local `isValidSignature` = `0xffffffff` | canary log |
| Burn intent to R signed **B+C** (weight 2 < 3) | **refused** by Gateway, same message | canary log |
| Burn intent to R, 1 USDC, signed A+B (weight 3), `contractSigner: true` | **201**, attestation issued | canary log |
| `gatewayMint` on Base Sepolia | R 0 → **1 USDC**; `GatewayMinter` event: source domain 26, depositor = signer = the treasury | `0x9c5b49d49dbef4e58667356035e3295c5585cf59feaee3616fd0ea8e96e49277` |
| App EVM send, 0.25 USDC A+B → R, mint on Base Sepolia | R 1 → 1.25 USDC | `0xd03bea29bcd9fd21fc170e2a1ce5417a36c7e154f2138b0a04e646e8c2e09238` |

Expiry was bounded at head + 1,211,599 blocks: above Gateway's 1,209,599 floor and under the treasury's 1,250,000
ceiling.

## Solana leg: Squads treasury + FROST threshold delegate, Solana devnet → Arc testnet

**Result 2026-10-05: PASSED.** Script: `packages/weighted-treasury/scripts/gateway-solana-delegate.ts`. Key tool:
`tools/frost-delegate` (FROST Ed25519, RFC 9591). The script run does not use the EVM treasury contract, so the v1/v2
change does not affect it. The app Solana send (last row) was made while the app read the v1 treasury's on-chain
allowlist. The app now reads v2, and no app send against v2 is recorded yet.

Owners A=2, B=1, C=1, threshold 3. FROST shares A:[1,2], B:[3], C:[4], threshold 3. Group key (the delegate)
`EBjX3U8y1S1weZBNGooB7Ab3YmsFLNGK5W6EVYKhL3c2`. Squads smart account `AVfkRovDYbmb3Nf7nUGdrubYWykeoY4vtphPusjnMshz`,
vault `AtBgen532MGQmGjhmKcXRHxaBpSDz1ML6WXuUYw1yy9B` (settings: all 3 owners). Solana fee payer
`4EZgQyZN36gQsyzVUU7itVEmLzxcjTKkYtcZxEaVuP9W`.

| Step | Result | Evidence |
| --- | --- | --- |
| `deposit_for` the vault, 3 USDC (any wallet can fund it; no vault transaction) | Gateway balance 3 USDC | `qbsyMA5Z7ma3ExbQkz5VDMmtvYCh7CyrEpCT2Fu5ETN9zUMkz2pDDRkEiMNUJu5zYASbRYnCJpiV5qKUxpwdCDg` |
| `add_delegate(group key)`: the vault signs through a synchronous Squads transaction co-signed by all 3 owners | delegate account status Authorized | `26rFMVScZsc2sXEBo9knwPoeP7WfAdxxdCQ676Rgu8KSm6xfRbWFCX5dkHxj3Fsx9Q6DXkaqPGDRAdMGKL8JwKJ1` |
| B+C (2 of 4 shares, threshold 3) | **refused**: `frost-delegate` refuses below threshold | the sandbox process holds all shares, so this shows the protocol rule, not key separation |
| Burn intent signed with owner A's own key (not the delegate) | **refused** by Gateway: "Signer is not authorized to spend funds from sourceDepositor" | script log (reproducible) |
| Burn intent Solana → Arc, 1 USDC to R, FROST-signed by A+B (one Ed25519 signature) | **201**, attestation | script log |
| `gatewayMint` on Arc testnet | R 0 → **1 USDC** | `0x24f28de341f43f42d5b0cf0f1fdc90f6f52697466ae4d95e806ec7f9d4427163` |
| App Solana send, 0.25 USDC A+B → R, mint on Arc testnet | R 1 → 1.25 USDC | `0xd04c6001a6c1b4e4850da81456bfc57354ffde6e34e7162f8d00db174b0d334d` |

Measured on the way (Gateway testnet, 2026-10-05):

- Solana `maxBlockHeight` floor is **3,024,000 slots** above head (14 days at 400 ms), double the EVM ~7 days.
- Gateway indexes a new delegate with a short lag. The first submits return "Signer is not authorized" while the
  on-chain delegate account already reads Authorized. A refused intent is not consumed, so resubmitting the same
  signed intent is safe.
- The Solana burn intent is Circle's binary layout (magic `0x070afbc2` / `0xca85def7`, big-endian), signed with a
  16-byte `0xff00…` domain prefix.

What this leg does NOT give: an on-chain allowlist. Two off-chain gates stand in for it. The app server checks the
recipient against the EVM treasury's on-chain allowlist. Then `frost-delegate sign` checks the decoded burn intent
against `policy.json` before any share signs. `policy.json` is kept in sync with the EVM allowlist by hand. A
threshold of share holders who sign without `frost-delegate` is bound by neither gate. The sandbox DKG also ran every
participant in one process, so in the sandbox the threshold property is not real: one machine held every share. The
real fix is a Solana counterpart to ERC-1271 in Gateway (read a Squads-approved intent), which is in the Circle ask.
