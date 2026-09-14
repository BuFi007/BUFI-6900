# @bufi6900/treasury-kit

Deploy a BUFI treasury on many chains, give an agent a scoped session key on it, and move the
treasury's money through protocols in **one transaction** via `TreasuryConduit` — never held by
anyone but the treasury. The shapes live in `src/types.ts`; this file is the function contract
that `apps/agent` is written against.

## Chains — `src/chains.ts`

```ts
export const CHAINS: Record<TreasuryChainKey, TreasuryChain>
export function getChain(key: TreasuryChainKey): TreasuryChain          // throws on unknown
export function withConduit(chain: TreasuryChain, conduit: Address, targets: Record<string, Address>): TreasuryChain
```

`LOCAL` reads `contracts/deployments/local.json` (mock-circle sandbox, `modularPath: null`, the
transport is `MOCK_CIRCLE_URL`). Testnets: `ARC-TESTNET` (`/arcTestnet`), `AVAX-FUJI`
(`/avalancheFuji`), `ARB-SEPOLIA` (`/arbitrumSepolia`), `BASE-SEPOLIA` (`/baseSepolia`);
mainnets `ARC` (`/arc`, addresses TBD), `AVAX` (`/avalanche`). ERC-3009 domains per chain come from
Circle's deployments (USDC: name "USDC"/"USD Coin", version "2" — see the table in the file).

The Circle transport for a chain is `${CIRCLE_CLIENT_URL}${chain.modularPath}` with
`CIRCLE_CLIENT_KEY`; on `LOCAL` it is `MOCK_CIRCLE_URL` with any key. `createClients(chain, env)`
returns `{ publicClient, modularTransport, bundlerClient }` for the callers below.

## Signing — `src/signing.ts`

```ts
export function localKeySigner(privateKey: Hex): OwnerSigner
/** k-of-n blob for a userOp: owners sorted ascending, first chunk +32 over the actual digest. */
export function kOfNSignature(input: { userOpHash: Hex; minimalDigest: Hex; owners: readonly OwnerSigner[] }): Promise<Hex>
/** ERC-1271 blob over `toReplaySafeHash(account, chainId, digest)`: one r‖s‖v per owner, ascending by address. */
export function sign1271Digest(input: { chain: TreasuryChain; account: Address; digest: Hex; owners: readonly OwnerSigner[] }): Promise<Hex>
/** The EIP-712 ReceiveWithAuthorization digest for `auth` on `chain`, then `sign1271Digest` over it. */
export function signErc3009Authorization(input: { chain: TreasuryChain; auth: ConduitAuthorization; to: Address; owners: readonly OwnerSigner[] }): Promise<Hex>
```

## Treasury — `src/treasury.ts`

```ts
export function deployTreasury(input: DeployTreasuryInput, env: KitEnv): Promise<DeployTreasuryResult>
export function treasuryStatus(chain: TreasuryChainKey, treasury: Address, env: KitEnv): Promise<{
  deployed: boolean; owners: readonly TreasuryOwner[]; thresholdWeight: bigint;
  allowlist: readonly Address[]; balances: Record<string, bigint> /* symbol → atomic */
}>
```

`deployTreasury` runs the chains in parallel with per-chain error isolation. Per chain:
1. `toCircleSmartAccount({ owner: signer(owners[0]), deployment })` → first userOp deploys the
   account (1-of-1, as the SDK mints it).
2. `buildTreasuryBootstrapCalls` → userOp `updateMultisigWeights` (adds the other owners, sets the
   threshold), THEN a separate userOp `installAddressBook(allowlist)`. Never batched.
3. Verify through `getInstalledPlugins` / `getAllowedRecipients` before reporting success.

`KitEnv = { circleClientUrl?: string; circleClientKey?: string; mockCircleUrl?: string; rpcUrls?: Partial<Record<TreasuryChainKey, string>> }`.

## Agent face — `src/agent.ts`

```ts
/** The grant that lets a session key drive the conduit: `conduit.execute` only, gas budget, expiry. */
export function conduitExecutorGrant(input: { conduit: Address; validUntil: number; gasBudget?: { limit: bigint; refreshIntervalSeconds: number } }): AgentGrant
export function deployAgentFace(input: DeployAgentFaceInput, env: KitEnv): Promise<DeployedAgentFace>
```

The agent MSCA's owner is the treasury (nested ERC-1271 owner, weight = threshold). Its bootstrap
userOps — create, `installSessionKeyPlugin` with the key seeded, `buildBufiGrant(grant)` — are
signed by the quorum through `sign1271Digest` (the treasury is the account's owner). The session
key can only ever `executeWithSessionKey` inside the grant; it cannot sign ERC-1271 or install
plugins.

## Conduit — `src/conduit.ts`

```ts
export const TREASURY_CONDUIT_ABI
export function intentNonce(intent: ConduitIntent): Hex           // == TreasuryConduit.intentNonce
export function encodeExecute(auth: ConduitAuthorization, sig: Hex, intent: ConduitIntent): Hex

export function buildSwapRequest(input: {
  chain: TreasuryChainKey; treasury: Address; tokenIn: 'USDC' | 'EURC'; tokenOut: 'USDC' | 'EURC';
  amountIn: bigint; minOut: bigint; validForSeconds?: number;
  /** Router calldata for `target`, receiver = the conduit (swept to the treasury). */
  route: { target: Address; data: Hex; label: string }
}): ConduitRequest
export function buildEarnDepositRequest(input: {
  chain: TreasuryChainKey; treasury: Address; vault: Address; token: 'USDC' | 'EURC'; amountIn: bigint; minShares: bigint; validForSeconds?: number
}): ConduitRequest      // ERC-4626 deposit(amount, receiver = treasury)
export function buildFromPodsBytecode(input: PodsBytecodeInput & { chain: TreasuryChainKey; treasury: Address; validForSeconds?: number }): ConduitRequest
/** Throws unless `destinationAddress === treasury` (Pods maps it to onBehalfOf/to). */

export function approveWithQuorum(request: ConduitRequest, quorum: Quorum, env: KitEnv): Promise<ApprovedConduitRequest>
/** Submit `execute` from any sender: an EOA, the agent's session key (`via: { agent, sessionKey }`), or a Circle DCW. */
export function submitApproved(approved: ApprovedConduitRequest, via: SubmitVia, env: KitEnv): Promise<ConduitReceipt>
export type SubmitVia = { kind: 'eoa'; privateKey: Hex } | { kind: 'agent'; agent: Address; sessionKey: OwnerSigner }
```

A request's `authorization.nonce` is `intentNonce(intent)`, its `to` is the chain's conduit, and
its `facts` are what a human reads before approving. `approveWithQuorum` never submits.

## Sandbox proof — `test/kit.e2e.test.ts` (bun test, boots mock-circle)

Deploy a 2-of-2 treasury on LOCAL → deploy the agent face with `conduitExecutorGrant` → build a
swap request against the sandbox `MockSwapRouter` → quorum approves → the agent submits through its
session key → EURC is in the treasury, the conduit holds nothing, a second submit is refused.
Then an Earn deposit into the sandbox vault. Then a forced failure (rate under the floor) reverts
and the same signature succeeds after the rate recovers.
