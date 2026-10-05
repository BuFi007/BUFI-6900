# frost-delegate

Weighted FROST(Ed25519, SHA-512) threshold key for a Circle Gateway **delegate** on Solana (RFC 9591, via the
Zcash Foundation's `frost-ed25519` 3.0). Gateway on Solana accepts only an Ed25519 signature from the depositor or a
registered delegate; a Squads vault has no key. The Squads quorum registers this group key as the delegate, and the
same owners hold its shares, so a weighted quorum still signs every Solana transfer. The aggregate is a plain
RFC 8032 signature: Gateway verifies it like any key.

```bash
cargo build --release
./target/release/frost-delegate dkg  --dir ../../.sandbox/ultimate-treasury/frost --owners A:2,B:1,C:1 --threshold 3
./target/release/frost-delegate sign --dir ../../.sandbox/ultimate-treasury/frost --signers A,B --message-hex 0x…
```

- **Weights are share counts.** `A:2,B:1,C:1` with threshold 3 gives A shares 1–2, B share 3, C share 4.
  A+B and A+C reach 3 shares; B+C hold 2 and cannot produce a signature at all (it is not a policy refusal: the
  math has no valid signature for fewer than `threshold` shares; the CLI just refuses before trying).
- **DKG, not a dealer.** Shares come from a distributed key generation; no step ever holds the whole key.
- **Sandbox caveat.** This CLI runs every participant in one process. In production each owner's device holds only
  its own share file(s) and a coordinator relays the two signing rounds. The allowlist on this leg is enforced by
  that coordinator, not on-chain (Gateway on Solana has no ERC-1271 equivalent yet).
- `sign` verifies the aggregate with `ed25519-dalek` before printing it.

Used by `packages/weighted-treasury/scripts/gateway-solana-delegate.ts`.
