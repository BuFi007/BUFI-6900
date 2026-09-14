/**
 * @bufi6900/treasury-kit
 *
 * Three things, on any number of chains:
 *   1. `deployTreasury` — a weighted-multisig Circle MSCA with the AddressBook seeded.
 *   2. `deployAgentFace` — the agent's own MSCA, owned by the treasury, holding a session key
 *      whose grant the quorum signed.
 *   3. The conduit builders — `buildSwapRequest` / `buildEarnDepositRequest` /
 *      `buildFromPodsBytecode` → `approveWithQuorum` → `submitApproved`: one contract, one
 *      transaction, funds never held by anyone but the treasury.
 *
 * Every function is chain-parametrised through `TreasuryChain`; nothing here reads env.
 */
export * from './types'
export { CHAINS, getChain, withConduit } from './chains'
export { localKeySigner, kOfNSignature, sign1271Digest, signErc3009Authorization } from './signing'
export { deployTreasury, treasuryStatus } from './treasury'
export { deployAgentFace, conduitExecutorGrant } from './agent'
export {
  buildSwapRequest,
  buildEarnDepositRequest,
  buildFromPodsBytecode,
  intentNonce,
  approveWithQuorum,
  submitApproved,
  encodeExecute,
  TREASURY_CONDUIT_ABI,
} from './conduit'
