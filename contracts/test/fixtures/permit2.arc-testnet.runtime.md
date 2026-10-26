# Permit2 runtime test fixture

`permit2.arc-testnet.runtime.hex` is the canonical Permit2 runtime at
`0x000000000022D473030F116dDEE9F6B43aC78BA3`, reused from Desk's existing
`contracts/claim-vault/test/fixtures/permit2.arc-testnet.runtime.hex` fixture.

Keccak-256: `0x53681d3cf8f702f849c1504b491049c3d0a282e4595d9b297c410dcf36f0908e`.

The local test installs this bytecode with `vm.etch`, then exercises real
Permit2 witness hashing, unordered nonces, ERC-1271 and ERC-20 transfers against
Circle's weighted account and AddressBook stack. No network or wallet key is
used. The WARS/WBRL-named test tokens are exact-transfer ERC-20 test doubles;
these tests do not claim a fork simulation of the deployed Ripio tokens.

Canonical source: <https://github.com/Uniswap/permit2> (MIT).

## Pinned Arc mainnet fork

The separate `TreasuryConduitPermit2ArcTest` uses the actual mainnet code at
block **27,977,495**, with a local test router and local storage funding. It
does not overwrite mainnet Permit2. Run with the existing Cancun profile:

```sh
FOUNDRY_PROFILE=fork-arc ARC_PERMIT2_FORK_RPC=https://rpc.blockdaemon.mainnet.arc.io \
  forge test --match-contract TreasuryConduitPermit2ArcTest
```

Public RPC source: <https://docs.arc.io/arc/references/connect-to-arc>.

- Permit2 codehash: `0x05a793d6bdba8b8715c8f4cef0725ec3a961f567d33ebb2d360f541f19f70c8f`.
  The 9,152-byte runtime differs from the testnet fixture only in the cached
  chain-id and domain-separator immutable words.
- WARS: `0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D`.
  Implementation: `0xBa0030Bba7112171A8A5bCc417ee1994051321b9`;
  implementation codehash: `0xa921467240d95219a560bae76922283f1cf9d28f2bc0867caec8fa78e8290532`.
- WBRL: `0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0`.
  Implementation: `0xfbaB5DcB1647787Ec8402A6509add256Fa6c7f9D`;
  implementation codehash: `0x1cc2956795483c706cb46a343f67de09854000c74ce61af25267ca59f317a70b`.
- Both proxy codehashes: `0xf8d9ff5ea93bc29b43da9f8727fdeb3c9adac7ec55da259371f7af7182faf6a2`.

These fork cases prove the tested tokens' Permit2 funding and transfer behavior
under Circle's actual weighted ERC-1271 account. They do not establish a live
LI.FI quote, bridge finality, a document's Paid state, or an allowance on a real
user's wallet. The second-stage bridge tests prove source submission only;
destination delivery and its second quorum remain independent requirements.
