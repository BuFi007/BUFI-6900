# TreasuryBridgeConduitV2 release review

V2 is a new, unaudited contract. The immutable review JSON is the original
reproducible proposal, including undeployed mainnet plans. Authorized testnet
deployment receipts and independent readback are recorded separately in
`treasury-bridge-v2.testnet-deployments.json`. Desk `contracts/DEPLOYMENTS.md`
and `contracts/deployments.json` remain the deployment source of truth. V1 stays
recorded at its actual addresses. Server capability evidence requires the actual
deployment record and current policy, code and authority observations.

V2 keeps the weighted Treasury ERC-1271/ERC-3009 quorum and adds
`executePersonal(Intent,bytes)` for an ordinary human wallet transaction funded
by that caller's exact ERC-20 allowance. The signed intent includes an explicit
input-token platform fee, its recipient, and a positive measured bridge floor.
The fee, optional source swap, and Circle burn all revert together. A source burn
is a checkpoint; destination receipt verification completes the application.

The application release supports USDC over standard finalized CCTP V2, optionally
swapping a supported source asset into USDC before the burn. CCTPx is present in
the Solidity contract and local tests but is absent from these deployment inputs
and the application capability set. Destination swaps are not enabled. Mainnet
source swap venue lists deliberately start empty and require separate review.

## Reproduce

From `contracts/`:

```sh
forge test --offline --match-path test/bufi/v0.7/conduit/TreasuryBridgeConduitV2.t.sol -vv
forge build --offline src/bufi/conduit/TreasuryBridgeConduitV2.sol script/DeployTreasuryBridgeConduitV2.s.sol --out out-release --cache-path cache-release
FOUNDRY_PROFILE=fork-bridge forge test --offline --fork-url https://api.avax-test.network/ext/bc/C/rpc --fork-block-number 59527372 --match-path 'test/fork/bridge/*' -vv
```

From the repository root:

```sh
python3 -B scripts/release/prepare-treasury-bridge-v2.py --output contracts/release/treasury-bridge-v2.review.json
python3 -B -m unittest discover -s scripts/release -p 'test_*.py' -v
```

Use the separate Paris `out-release` build. The generator refuses Cancun fork
artifacts, wrong compiler settings, stale source hashes, unknown owner policies,
and a mainnet owner other than that chain's recorded Safe. The generator runs
only offline `cast` hashing and encoding commands. It has no RPC or signing code.
`treasury-bridge-v2.review.json` includes full CREATE2 calldata and registration
transactions for inspection, runtime hash, compiler identity, source hashes, and
activation requirements. Regenerate after any source, dependency or build change.

## Deployment tooling and approval boundary

`script/DeployTreasuryBridgeConduitV2.s.sol` accepts only Arc Testnet (5042002)
and Avalanche Fuji (43113), requires an explicit owner equal to the authorized
broadcaster, and verifies code, owner, bridge and venue readback. It registers
only the supplied CCTP V2 bridge and venues. Standard `forge script` simulates;
only an authorized operator adds `--broadcast`. Testnet broadcasts were authorized
and completed on 2026-10-16 UTC. Environment names are `DEPLOYER_PRIVATE_KEY`, `BRIDGE_CONDUIT_OWNER`,
`BRIDGE_CCTP_V2`, and optional comma-separated `BRIDGE_CONDUIT_TARGETS`.

Mainnet has no deployment override in that script. The offline mainnet plans use
the recorded chain Safe as constructor owner and provide owner registration
calldata for review. Audit, explicit release approval, independently verified
bridge/venue implementations, deployment receipt and code/owner readback, the
canonical Desk registry entry, sealed runtime evidence, source/destination gas
policies, and an automated destination/recovery smoke are required before
activation. Mainnet quorum settings are unchanged.

## Evidence and limits

- Local Foundry: 96 passing tests; four fuzz cases each run 256 times. The Circle
  weighted two-owner MSCA, weighted plugin and AddressBook are real locally
  deployed contracts. FiatToken, swap venues, CCTP and CCTPx are local mocks.
- Fuji source fork: public network state at block 59527372. The block hash and
  proxy code hashes are in `treasury-bridge-v2.source-fork.json`. Actual Fuji
  FiatToken and CCTP execute locally: Personal exact-allowance source burn;
  real-token one-unit floor rollback; two-owner ERC-1271 Treasury source burn through a separate gas-only Circle
  SCA UserOp and canonical EntryPoint, one-owner refusal, and replay refusal. Funding uses `deal`, and the Treasury
  account is deployed locally from canonical Circle sources. No remote network
  transaction, Circle account, destination attestation, or destination mint is
  created by these tests.
- Backend tests separately exercise frozen attempt and operation identities,
  human authorization envelopes, live-quorum refusal, exact-call gas preflight,
  durable source fences, concurrent callers, ambiguous provider responses,
  original-only reconciliation, and verified destination completion. Their RPC,
  provider, membership, and policy observations are fixtures; they do not prove
  an end-to-end live deployment.

## Authorized testnet deployment

The frozen `997dfad6aca5e3e9ae3d6c1d66b15fecbd47f012` release was simulated,
then deployed with the established testnet EOA owner
`0x09Ce8E2B3Fede2727dA4392Ea8Fe618305ba0474`. Both testnets use
`0x41422093Ef6d03FBd3c0a2E3A6a6F69b1Cad4409`; runtime is 9432 bytes,
hash `0x5ddb81fad45ec7282ba7d75cfc5474232aed59b7cbc398ae1c522485cbdf268e`.

| Testnet | CREATE2 deployment transaction | Registrations |
| --- | --- | --- |
| Arc Testnet (5042002) | `0xa1a150338cd658d7bc10e54a32f014e2b944c7353900ff9c5b7562aa6f022205` | CCTP V2, reviewed App Kit adapter and LI.FI |
| Avalanche Fuji (43113) | `0x67927dc08f8bd6b5c6c67163695cebe388cb2e07007cc26f36dd2510ef807a2a` | CCTP V2; no source swap venues |

`check-treasury-bridge-v2-testnets.py` records read-only chain identity, established
owner, test gas balances, exact CCTP contracts, domains and proxy implementations.
`record-treasury-bridge-v2-testnet-proof.py` independently reads all six original
receipts, checks exact reviewed calldata and sender, requires successful canonical
finalized receipts, and checks runtime, owner and registration readback. These
scripts allow only the two testnet RPCs and never load signing material.

```sh
python3 -B scripts/release/check-treasury-bridge-v2-testnets.py --output /tmp/v2-preflight.json
python3 -B scripts/release/record-treasury-bridge-v2-testnet-proof.py --output /tmp/v2-deployment-proof.json
```

Deployment used existing testnet funds only. Mainnet plans remain review-only;
no mainnet or Safe transaction was sent, and no quorum was changed. A live funded
testnet burn/mint and lost-response recovery require separate application evidence
after canonical runtime configuration. Contract deployment and source-fork proofs
do not establish destination settlement.
