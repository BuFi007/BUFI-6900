# TreasuryBridgeConduitV2 release review

V2 is a new, unaudited contract. This package is a reproducible proposal; none of
its predicted addresses is a deployment record. Desk `contracts/DEPLOYMENTS.md`
and `contracts/deployments.json` remain the deployment source of truth. V1 stays
recorded at its actual testnet addresses. Do not replace V1 metadata with V2
predictions or enable server capability evidence from this document.

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
only an authorized operator adds `--broadcast`. No broadcast was run for this
package. Environment names are `DEPLOYER_PRIVATE_KEY`, `BRIDGE_CONDUIT_OWNER`,
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

A live funded testnet burn/mint and lost-response recovery remain an operator
smoke after approved V2 deployment and canonical runtime configuration. This
source-fork evidence does not claim that destination settlement has occurred.
