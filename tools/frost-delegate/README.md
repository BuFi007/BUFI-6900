# frost-delegate

Weighted FROST(Ed25519, SHA-512) threshold key for a Circle Gateway **delegate** on Solana (RFC 9591, via the
Zcash Foundation's `frost-ed25519` 3.0). Gateway on Solana accepts only an Ed25519 signature from the depositor or a
registered delegate; a Squads vault has no key. The Squads quorum registers this group key as the delegate, and the
same owners hold its shares, so a weighted quorum still signs every Solana transfer. The aggregate is a plain
RFC 8032 signature: Gateway verifies it like any key.

```bash
cargo build --release && cargo test
./target/release/frost-delegate dkg  --dir ../../.sandbox/ultimate-treasury/frost --owners A:2,B:1,C:1 --threshold 3
./target/release/frost-delegate sign --dir ../../.sandbox/ultimate-treasury/frost --signers A,B \
    --current-slot <solana slot> --message-hex 0x…
```

- **Weights are share counts.** `A:2,B:1,C:1` with threshold 3 gives A shares 1–2, B share 3, C share 4.
  A+B and A+C reach 3 shares; B+C hold 2 and cannot produce a signature at all (it is not a policy refusal: the
  math has no valid signature for fewer than `threshold` shares; the CLI just refuses before trying).
- **DKG, not a dealer, in production.** Shares come from a distributed key generation. **Sandbox caveat:** this CLI
  runs every participant in one process, so for the duration of `dkg` (and of each `sign`) that process holds every
  participant's secrets and could reconstruct the key: here it is effectively a trusted dealer. In production each
  owner's device holds only its own share file(s) and a coordinator relays the rounds.
- **`dkg` never overwrites a live key.** It refuses when the directory already holds `group.json`, `public.json`,
  `owners.json` or any `share-*.json` (a second DKG would replace the key the vault registered as its Gateway
  delegate, leaving the vault recoverable only by a new all-owner `add_delegate`). `--force` overrides deliberately.
  Every file is written `0600`.
- **`sign` is the policy coordinator.** It signs only a message that is exactly ONE Circle Solana burn intent
  (`0xff00…` 16-byte prefix + Circle's binary layout, no hook data) satisfying `<dir>/policy.json`, and refuses
  (exit 3, `{"error":"policy","reason":…}`) before touching a share otherwise. Without `policy.json` it refuses to
  sign. Checked: depositor = the vault, signer = this group key, source domain / GatewayWallet / token, destination
  domain + its GatewayMinter + its token, recipient and any destination caller allowlisted **for that domain** and
  shaped for it (EVM address vs Solana key), `0 < value ≤ perIntentCap`, `maxFee ≤ maxFeeCap`, and
  `currentSlot < maxBlockHeight ≤ currentSlot + maxExpirySlots`. This is OFF-CHAIN only: Gateway on Solana has no
  ERC-1271 equivalent, so a threshold of share holders who sign without this binary is not bound by it. It stops
  blind signing and bugs, not a colluding share majority.
- **Signer labels** are deduplicated against the share map: a repeated (`B,B,C`) or unknown label is refused (exit 64),
  never counted twice. Below `threshold` shares exits 2 with `{"error":"below threshold",…}`.
- `sign` verifies the aggregate with `ed25519-dalek` before printing it.

`policy.json` (32-byte words as 0x-hex, amounts as decimal strings in base units):

```json
{
  "depositor": "0x<vault>", "sourceDomain": 5, "sourceContract": "0x<GatewayWallet program>",
  "sourceToken": "0x<USDC mint>", "perIntentCap": "2000000", "maxFeeCap": "2010000", "maxExpirySlots": 3040000,
  "destinations": [{ "domain": 26, "minter": "0x<GatewayMinter, left-padded>", "token": "0x<USDC, left-padded>",
                     "recipients": ["0x<R, left-padded>"], "callers": [] }]
}
```

Used by `packages/weighted-treasury/scripts/gateway-solana-delegate.ts`.
