# GatewayTreasury live canary: ERC-1271 Gateway transfer, Arc testnet → Base Sepolia

**Result 2026-10-05: PASSED.** The first ERC-1271 Gateway burn from a weighted-multisig treasury contract, attested
and minted. Script: `scripts/gateway-treasury/canary.ts`. Contract: `contracts/src/bufi/gateway-treasury/GatewayTreasury.sol`
(forge 42/42).

Treasury `0x692Db08885870fA99ADA4Acdee02633947669daF` (Arc testnet 5042002): owners A=2, B=1, C=1, threshold 3;
allowlist = R `0xF7D0520C36717e25c5b77F977A89741d2974589C` only; destination domain 6 (Base Sepolia) only; tokens
Arc USDC → Base Sepolia USDC; per-intent cap 2 USDC; fee cap 2.01 USDC; expiry window 1,250,000 blocks; admin timelock 600 s.
Deployed by `0x09Ce8E2B…0474` (broadcast `contracts/broadcast/DeployGatewayTreasury.s.sol/5042002/run-latest.json`).

| Step | Result | Evidence |
| --- | --- | --- |
| Deposit A: USDC transfer + permissionless `sweepToGateway` (3 USDC) | credited | `0xd990c619…8cab`, `0x9d236e64…7a0d` |
| Deposit B: owners A+B sign ERC-3009 `ReceiveWithAuthorization`; `GatewayWallet.depositWithAuthorization` pulls 1 USDC (USDC asks the treasury's `isValidSignature`, kind 1) | credited, no user operation | `0xb9d5bc6e…f4a2` |
| `GatewayWallet.availableBalance` | 4 USDC | on-chain read |
| Burn intent to **S** (not allowlisted), signed A+B | **refused** by Gateway: 400 "contract signature verification request failed"; local `isValidSignature` = `0xffffffff` | canary log |
| Burn intent to R signed **B+C** (weight 2 < 3) | **refused** by Gateway, same message | canary log |
| Burn intent to R, 1 USDC, signed A+B (weight 3), `contractSigner: true` | **201**, attestation issued | canary log |
| `gatewayMint` on Base Sepolia | R 0 → **1 USDC**; `GatewayMinter` event: source domain 26, depositor = signer = the treasury | `0x9c5b49d4…9277` |

What this proves: Gateway's enclave simulation runs our policy-checked `isValidSignature` and enforces it, both the
weighted quorum and the recipient allowlist, end to end. Expiry was bounded at head + 1,211,599 blocks (above
Gateway's 1,209,599 floor, under the treasury's 1,250,000 ceiling).

Not yet proven: nested owners (a smart-account owner signing via its own ERC-1271), the Solana leg, EURC.
