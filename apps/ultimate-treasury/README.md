# @bufi/ultimate-treasury

An asset-first, chain-abstracted treasury app (Vite + React 19 + TypeScript, plain CSS, same stack as
`apps/playground`). The user sees **assets and amounts first**; chains appear only when the position breakdown is
opened or a send reports where it was delivered.

Every address, hash and test count here is also in [docs/EVIDENCE-LEDGER.md](../../docs/EVIDENCE-LEDGER.md), the
single source. This is a **local dev app**. It is not offered as a hosted preview, because signing is dev-only by
design: a hosted build can read balances but cannot send.

- **One USDC number**: the sum of the live Circle Gateway balances of
  - the EVM `GatewayTreasury` v2 contract on Arc testnet (domain 26,
    `0xC3f4De2372167F7FFA0a1B3FbF221a8a7289e7d5`, the deployment of the current source), and
  - the Solana Squads vault on devnet (domain 5, `AtBgen532MGQmGjhmKcXRHxaBpSDz1ML6WXuUYw1yy9B`),
  read from `POST https://gateway-api-testnet.circle.com/v1/balances`. Base Sepolia and Fuji positions are not read.
  The v1 treasury `0x692Db08885870fA99ADA4Acdee02633947669daF` is superseded and no longer used by the app.
- **Asset rows**: USDC is live. EURC, cirBTC and other StableFX assets are shown disabled as "not on Gateway yet".
  No balance is ever invented for them.
- **Send**: asset, amount, a recipient from the treasury allowlist (R), the policy (quorum, destinations, caps,
  expiry; read live from the contract in dev), owner checkboxes with weights and a live "weight N of 3" indicator.
  The source position is chosen automatically (the larger balance that covers amount + typical fee, within the
  per-intent cap) unless the user overrides it. Status steps: approvals collected → Gateway attestation → minted,
  with explorer links.
- **Refusal demo**: A+B to S (not on the allowlist) or B+C only (weight 2 of 3). The request is really signed and
  submitted, and the refusal is shown verbatim. The signer refuses to run a "refusal demo" that would actually succeed.

## Run

```bash
bun install
bun run treasury:dev                 # from the repo root, or: bun run --cwd apps/ultimate-treasury dev
PORT=5187 bun run --cwd apps/ultimate-treasury dev   # pick a port (default 5180)
bun run --cwd apps/ultimate-treasury check:type
bun run --cwd apps/ultimate-treasury build           # static, signer-free bundle in dist/
```

The dev signer needs, all gitignored / outside the repo:

| What | Where | Override |
| --- | --- | --- |
| EVM owners A, B, C and recipients R, S | `.sandbox/ultimate-treasury/keys.json` | `UT_SANDBOX_DIR` |
| FROST shares + group key | `.sandbox/ultimate-treasury/frost/` | (same dir) |
| FROST signer binary | `tools/frost-delegate/target/release/frost-delegate` | `UT_FROST_BIN` |
| EVM fee payer (submits `gatewayMint`; needs Base Sepolia ETH and Arc testnet USDC gas) | `../desk-v1/.deployer-wallet.json` | `UT_FEE_PAYER_FILE` |
| Solana RPC (slot height only) | `https://api.devnet.solana.com` | `SOLANA_RPC_URL` |

## Architecture

```
browser (src/)                          dev-only Vite middleware (server/)            networks
──────────────                          ───────────────────────────────────            ────────
Holdings ── GET /api/ut/balances ─────▶ fetchGatewayBalances ───────────────────────▶ Gateway /v1/balances
SendPanel ─ GET /api/ut/treasury ─────▶ readPolicy (GatewayTreasury views) ─────────▶ Arc testnet RPC
          ─ POST /api/ut/send ────────▶ startSend → job
          ─ GET /api/ut/jobs/:id ◀───── EVM:    EIP-712 BurnIntent, owner ECDSA sigs ascending,
                                                kind-0 ERC-1271 blob, local isValidSignature,
                                                POST /v1/transfer contractSigner:true ────────▶ Gateway
                                                gatewayMint on Base Sepolia (fee payer) ──────▶ Base Sepolia
                                        Solana: coordinator allowlist check (treasury's on-chain list),
                                                binary burn intent + 0xff00… domain,
                                                frost-delegate sign (A+B shares → 1 Ed25519 sig),
                                                POST /v1/transfer, retry "not authorized" ≤ 3 min ─▶ Gateway
                                                gatewayMint on Arc testnet (fee payer) ───────────▶ Arc testnet
```

- `shared/` holds only public facts (addresses, domains, caps) and the read-only balance fetch; it is imported by
  both sides.
- `server/secrets.ts` is the only file that reads key material, at request time, and nothing it reads is cached,
  logged or returned (`/api/ut/status` returns the fee payer's *address*).
- `server/evm.ts` reproduces `scripts/gateway-treasury/canary.ts`; `server/solana.ts` reproduces the encoder of
  `packages/weighted-treasury/scripts/gateway-solana-delegate.ts` without web3.js (a 20-line base58 codec is all the
  signer needs).
- Expiry is bounded just above Gateway's floors: Arc `head + 1,209,599 + 2,000` (under the treasury's 1,250,000
  ceiling), Solana `slot + 3,024,000 + 10,000`. A signed intent is a bearer note until it expires; only an accepted
  one is consumed, so the Solana retry resubmits the same signed intent.
- One send at a time (409 otherwise). Every send, refusal demos included, is capped at 1 USDC and at the per-intent
  cap, and must fit the source's balance: `expectRefusal` adds a check, it never removes one.
- The Solana allowlist is NOT on-chain. Two separate off-chain gates stand in for it, and both must pass:
  1. This app server checks the recipient against the EVM treasury's on-chain allowlist.
  2. `frost-delegate sign` decodes the burn intent and checks `.sandbox/ultimate-treasury/frost/policy.json`
     (recipient per destination domain, value and fee caps, expiry, depositor, minter) before any share signs.

  The two lists are kept in sync **by hand**. `policy.json` lists R on domain 26 only. If an owner changes the EVM
  allowlist, `policy.json` must be edited to match, or the gates disagree. Share holders who sign without
  `frost-delegate` are bound by neither gate. A sub-threshold quorum cannot produce a FROST signature at all. The UI
  says which layer refused. A Solana send is refused outright (409) when the FROST share map differs from the
  on-chain weights (re-run the DKG and a new Squads `add_delegate` after a rotation).
- **Sandbox DKG caveat.** `frost-delegate dkg` runs every participant in one process, and all shares sit in one
  directory on one machine. In the sandbox that process could rebuild the group key, so the threshold property is
  not real here. A production setup needs each owner to run their own DKG participant and hold their own share.
- An accepted attestation is saved (memory + `.sandbox/ultimate-treasury/attestations/`, 0600) until a mint receipt
  succeeds. A failed mint is resumed with the SAME attestation (`POST /api/ut/jobs/:id/resume-mint`, the "Resume
  mint" button); a new send of the same amount to the same recipient is refused meanwhile. A successful mint receipt
  is never reported as an error, whatever the (lagging) balance RPC says.
- The dev server serves only this app and the hoisted `node_modules` (`server.fs.allow`) and denies `.sandbox/` and
  key files outright; the signer answers only loopback sockets and this page's exact origin, and refuses preflights.

## The dev-only signer boundary

1. `server/plugin.ts` is a Vite plugin with `apply: 'serve'`: it exists under `vite` (dev) and is absent from
   `vite build` and `vite preview`. No browser module imports anything under `server/`.
2. `src/api.ts` gates every signer call behind `import.meta.env.DEV`; in a production build the `/api/ut` routes are
   compiled out, the page reads public balances straight from Gateway (CORS `*`), shows the policy "as deployed",
   disables Send and the refusal demo, and says **"connect a signer"**.
3. The middleware answers only `localhost` / `127.0.0.1` hosts and origins (foreign Origin → 403), `server.cors` is
   off, the dev server binds `127.0.0.1`, and `POST /send` requires `Content-Type: application/json`.

Verification of a build (run after `vite build`):

```bash
grep -rl "/api/ut\|privateKey\|frost-delegate\|deployer-wallet\|child_process" apps/ultimate-treasury/dist  # → nothing
```

## Security review fixes in this app

The 2026-10-05 review raised 9 findings in the app, the FROST tool and the scripts (UT-1 to UT-9; full mapping in
[`docs/SECURITY-REVIEW-GATEWAY.md`](../../docs/SECURITY-REVIEW-GATEWAY.md)). Four are in this app and pinned by
`server/hardening.test.ts` (`bun test server`: 22 passed), listed below. The other five are outside this app:

- UT-3 (merged into GT-4 (spec)), UT-6 and UT-7 are fixed in `tools/frost-delegate` and pinned by its `cargo test`
  (5 passed): `policy_accepts_the_canonical_intent`, `policy_refuses_each_violation`,
  `refuses_anything_that_is_not_one_burn_intent`, `dkg_refuses_to_overwrite_and_writes_owner_only_files`,
  `duplicate_or_unknown_signer_labels_are_refused`.
- UT-9 is fixed in `scripts/gateway-treasury/canary.ts` (it validates `TREASURY` before sending). It was checked by
  hand and has no regression test.
- UT-8 is still open: `u256be` in `packages/weighted-treasury/scripts/gateway-solana-delegate.ts` encodes only the
  low 128 bits.

App findings and their tests:

| Finding | Regression tests |
| --- | --- |
| UT-1 dev server file exposure (`/@fs` reading keys and shares) | `UT-1 dev server file exposure`: each `/@fs/...` key path is refused; the app itself still serves; OPTIONS on the signer is refused |
| UT-2 send validation | `UT-2 send validation`: a refusal request cannot lift the sandbox cap or skip the balance check; the Solana leg refuses when on-chain weights drifted from the FROST share map; a consistent request still validates |
| UT-4 `localOnly` origin checks | `UT-4 localOnly`: a LAN peer spoofing `Host: localhost`, a page on another localhost port and DNS rebinding are refused; loopback without Origin and the dev page are allowed |
| UT-5 mint bookkeeping | `UT-5 mint bookkeeping`: a second send to the same recipient and amount is blocked while an attestation is unminted; the minted amount is read from the receipt `Transfer` log, not a lagging `balanceOf` |

## Verified live (2026-10-05)

These runs were made while the app pointed at the **v1** treasury (pre-review bytecode, now superseded). The app now
points at v2. The v2 contract itself is proven by `scripts/gateway-treasury/canary.ts` (ledger §1), but no app send
against v2 is recorded yet.

| Flow | Result |
| --- | --- |
| `GET /api/ut/balances` | both positions: treasury 2.9965, vault 1.85, total 4.8465 USDC |
| Refusal, EVM, A+B → S | local `isValidSignature` `0xffffffff`; Gateway 400 `{"success":false,"message":"Invalid signature: contract signature verification request failed"}` |
| Refusal, EVM, B+C → R | same Gateway 400 |
| Refusal, Solana, B+C | `frost-delegate` refuses below threshold (2 shares < 3; the sandbox process holds every share) |
| Refusal, Solana, A+B → S | coordinator refuses before signing (as recorded at the time; current code refuses at the app server gate first) |
| EVM send 0.25 USDC A+B → R | Gateway 201; `gatewayMint` Base Sepolia `0xd03bea29bcd9fd21fc170e2a1ce5417a36c7e154f2138b0a04e646e8c2e09238`; R 1 → 1.25 |
| Solana send 0.25 USDC A+B → R | Gateway 201; `gatewayMint` Arc testnet `0xd04c6001a6c1b4e4850da81456bfc57354ffde6e34e7162f8d00db174b0d334d`; R 1 → 1.25 |
| Balances after | treasury 2.743, vault 1.45 (fees: ~0.0035 EVM, ~0.15 Solana) |
