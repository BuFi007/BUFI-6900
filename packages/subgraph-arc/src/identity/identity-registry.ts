import { Address, BigInt, Bytes, crypto, dataSource } from '@graphprotocol/graph-ts';

import {
  Approval,
  ApprovalForAll,
  MetadataSet,
  Registered,
  Transfer,
  URIUpdated,
} from '../../generated/IdentityRegistry/IdentityRegistry';
import {
  Agent,
  AgentApprovalChange,
  AgentMetadata,
  AgentMetadataRevision,
  AgentTransfer,
  AgentURIRevision,
  IdentityRegistry,
  OperatorApproval,
  OperatorApprovalChange,
} from '../../generated/schema';
import { applyScoreAttestation, BUFI_SCORE_KEY } from '../bufi/score';
import { bindWallet, unbindWallet } from '../bufi/wallet-binding';
import { getOrCreateAccount } from '../shared/account';
import { toEip155Caip10 } from '../shared/caip';
import { classifyUri } from '../shared/uri';
import { agentEntityId, getAgent } from './agent';
import { resolveAgentRegistration } from './registration';
import { registryEntityId } from './registry';

export function handleRegistered(event: Registered): void {
  const registry = getOrCreateIdentityRegistry(event.address, event.block.timestamp);
  registry.agentCount = registry.agentCount.plus(BigInt.fromI32(1));
  registry.unburnedAgentCount = registry.unburnedAgentCount.plus(BigInt.fromI32(1));
  registry.updatedAt = event.block.timestamp.toI64();
  registry.save();

  const owner = getOrCreateAccount(event.params.owner);
  const agentURIKind = classifyUri(event.params.agentURI);
  const agentIdBytes = agentEntityId(registry.chainId, event.address, event.params.agentId);
  const registrationId = resolveAgentRegistration(
    agentIdBytes,
    event.params.agentURI,
    agentURIKind
  );

  const agent = new Agent(agentIdBytes);
  agent.registry = registry.id;
  agent.agentId = event.params.agentId;
  agent.owner = owner.id;
  agent.isBurned = false;
  agent.agentURI = event.params.agentURI;
  agent.agentURIKind = agentURIKind;
  agent.uriRevision = BigInt.zero();
  agent.registration = registrationId;
  agent.feedbackCount = BigInt.zero();
  agent.activeFeedbackCount = BigInt.zero();
  agent.responseCount = BigInt.zero();
  // BUFI counters (see schema.graphql, "BUFI:").
  agent.verifiedFeedbackCount = BigInt.zero();
  agent.jobsAsClient = BigInt.zero();
  agent.jobsAsProvider = BigInt.zero();
  agent.settledAsClient = BigInt.zero();
  agent.settledAsProvider = BigInt.zero();
  agent.settledVolumeAsClient = BigInt.zero();
  agent.settledVolumeAsProvider = BigInt.zero();
  agent.refundedVolumeAsClient = BigInt.zero();
  agent.createdAt = event.block.timestamp.toI64();
  agent.createdAtBlock = event.block.number;
  agent.createdAtTransaction = event.transaction.hash;
  agent.updatedAt = event.block.timestamp.toI64();
  agent.updatedAtBlock = event.block.number;
  agent.updatedAtTransaction = event.transaction.hash;
  agent.save();

  const revision = new AgentURIRevision(event.transaction.hash.concatI32(event.logIndex.toI32()));
  revision.agent = agent.id;
  revision.revision = BigInt.zero();
  revision.uri = event.params.agentURI;
  revision.uriKind = agentURIKind;
  revision.updatedBy = owner.id;
  revision.registration = registrationId;
  revision.blockNumber = event.block.number;
  revision.timestamp = event.block.timestamp.toI64();
  revision.transactionHash = event.transaction.hash;
  revision.logIndex = event.logIndex;
  revision.save();
}

export function handleMetadataSet(event: MetadataSet): void {
  const agent = getAgent(agentEntityId(contextChainId(), event.address, event.params.agentId));
  if (agent == null) return;

  if (event.params.metadataKey == 'agentWallet') {
    // BUFI: the agent wallet is the join to ERC-8183 parties and rating
    // clients; keep WalletBinding in step with the metadata.
    unbindWallet(agent, agent.agentWallet);
    const wallet = agentWalletFromMetadataValue(event.params.metadataValue);
    agent.agentWallet = wallet;
    if (wallet) bindWallet(agent, wallet!, event);
  } else if (event.params.metadataKey == BUFI_SCORE_KEY) {
    applyScoreAttestation(agent, event.params.metadataValue, event.block.timestamp);
  }

  const keyHash = Bytes.fromByteArray(crypto.keccak256(Bytes.fromUTF8(event.params.metadataKey)));
  const metadataId = agent.id.concat(keyHash);

  let metadata = AgentMetadata.load(metadataId);
  if (metadata == null) {
    metadata = new AgentMetadata(metadataId);
    metadata.agent = agent.id;
    metadata.key = event.params.metadataKey;
    metadata.keyHash = keyHash;
  }
  metadata.value = event.params.metadataValue;
  metadata.updatedAt = event.block.timestamp.toI64();
  metadata.updatedAtBlock = event.block.number;
  metadata.updatedAtTransaction = event.transaction.hash;
  metadata.save();

  const revision = new AgentMetadataRevision(
    event.transaction.hash.concatI32(event.logIndex.toI32())
  );
  revision.agent = agent.id;
  revision.key = event.params.metadataKey;
  revision.keyHash = keyHash;
  revision.value = event.params.metadataValue;
  revision.blockNumber = event.block.number;
  revision.timestamp = event.block.timestamp.toI64();
  revision.transactionHash = event.transaction.hash;
  revision.logIndex = event.logIndex;
  revision.save();

  agent.updatedAt = event.block.timestamp.toI64();
  agent.updatedAtBlock = event.block.number;
  agent.updatedAtTransaction = event.transaction.hash;
  agent.save();
}

export function handleURIUpdated(event: URIUpdated): void {
  const agent = getAgent(agentEntityId(contextChainId(), event.address, event.params.agentId));
  if (agent == null) return;

  const updatedBy = getOrCreateAccount(event.params.updatedBy);
  const uriKind = classifyUri(event.params.newURI);
  const registrationId = resolveAgentRegistration(agent.id, event.params.newURI, uriKind);

  agent.agentURI = event.params.newURI;
  agent.agentURIKind = uriKind;
  agent.uriRevision = agent.uriRevision.plus(BigInt.fromI32(1));
  agent.registration = registrationId;
  agent.updatedAt = event.block.timestamp.toI64();
  agent.updatedAtBlock = event.block.number;
  agent.updatedAtTransaction = event.transaction.hash;
  agent.save();

  const revision = new AgentURIRevision(event.transaction.hash.concatI32(event.logIndex.toI32()));
  revision.agent = agent.id;
  revision.revision = agent.uriRevision;
  revision.uri = event.params.newURI;
  revision.uriKind = uriKind;
  revision.updatedBy = updatedBy.id;
  revision.registration = registrationId;
  revision.blockNumber = event.block.number;
  revision.timestamp = event.block.timestamp.toI64();
  revision.transactionHash = event.transaction.hash;
  revision.logIndex = event.logIndex;
  revision.save();
}

export function handleTransfer(event: Transfer): void {
  // The Identity Registry's mint also emits `Transfer`. `handleRegistered`
  // already establishes ownership from `Registered`, so this handler only
  // deals with real transfers and burns.
  if (event.params.from.equals(Address.zero())) return;

  const agent = getAgent(agentEntityId(contextChainId(), event.address, event.params.tokenId));
  if (agent == null) return;

  const from = getOrCreateAccount(event.params.from);
  const to = getOrCreateAccount(event.params.to);
  const isBurn = event.params.to.equals(Address.zero());

  agent.owner = isBurn ? null : to.id;
  // ERC-721 approvals and the operational wallet do not carry over to a new
  // owner (or survive a burn); both must be re-established explicitly.
  agent.approved = null;
  unbindWallet(agent, agent.agentWallet);
  agent.agentWallet = null;
  agent.isBurned = isBurn;
  agent.updatedAt = event.block.timestamp.toI64();
  agent.updatedAtBlock = event.block.number;
  agent.updatedAtTransaction = event.transaction.hash;
  agent.save();

  const transfer = new AgentTransfer(event.transaction.hash.concatI32(event.logIndex.toI32()));
  transfer.agent = agent.id;
  transfer.from = from.id;
  transfer.to = to.id;
  transfer.blockNumber = event.block.number;
  transfer.timestamp = event.block.timestamp.toI64();
  transfer.transactionHash = event.transaction.hash;
  transfer.logIndex = event.logIndex;
  transfer.save();

  if (!isBurn) return;

  const registry = IdentityRegistry.load(registryEntityId(contextChainId(), event.address));
  if (registry == null) return;
  registry.unburnedAgentCount = registry.unburnedAgentCount.minus(BigInt.fromI32(1));
  registry.updatedAt = event.block.timestamp.toI64();
  registry.save();
}

export function handleApproval(event: Approval): void {
  const agent = getAgent(agentEntityId(contextChainId(), event.address, event.params.tokenId));
  if (agent == null) return;

  const owner = getOrCreateAccount(event.params.owner);
  const approved = getOrCreateAccount(event.params.approved);
  const clearsApproval = event.params.approved.equals(Address.zero());

  agent.approved = clearsApproval ? null : approved.id;
  agent.updatedAt = event.block.timestamp.toI64();
  agent.updatedAtBlock = event.block.number;
  agent.updatedAtTransaction = event.transaction.hash;
  agent.save();

  const change = new AgentApprovalChange(event.transaction.hash.concatI32(event.logIndex.toI32()));
  change.agent = agent.id;
  change.owner = owner.id;
  change.approved = approved.id;
  change.blockNumber = event.block.number;
  change.timestamp = event.block.timestamp.toI64();
  change.transactionHash = event.transaction.hash;
  change.logIndex = event.logIndex;
  change.save();
}

export function handleApprovalForAll(event: ApprovalForAll): void {
  const owner = getOrCreateAccount(event.params.owner);
  const operator = getOrCreateAccount(event.params.operator);

  // Both addresses are fixed-width, so concatenation alone is a safe,
  // collision-free ID: unlike `agentEntityId` in ../entities/agent.ts, no
  // delimiter is needed between two same-length components.
  let approval = OperatorApproval.load(owner.id.concat(operator.id));
  if (approval == null) {
    approval = new OperatorApproval(owner.id.concat(operator.id));
    approval.owner = owner.id;
    approval.operator = operator.id;
  }
  approval.approved = event.params.approved;
  approval.updatedAt = event.block.timestamp.toI64();
  approval.updatedAtBlock = event.block.number;
  approval.updatedAtTransaction = event.transaction.hash;
  approval.save();

  const change = new OperatorApprovalChange(
    event.transaction.hash.concatI32(event.logIndex.toI32())
  );
  change.owner = owner.id;
  change.operator = operator.id;
  change.approved = event.params.approved;
  change.blockNumber = event.block.number;
  change.timestamp = event.block.timestamp.toI64();
  change.transactionHash = event.transaction.hash;
  change.logIndex = event.logIndex;
  change.save();
}

function getOrCreateIdentityRegistry(address: Address, timestamp: BigInt): IdentityRegistry {
  const chainId = contextChainId();
  const id = registryEntityId(chainId, address);
  let registry = IdentityRegistry.load(id);
  if (registry == null) {
    registry = new IdentityRegistry(id);
    registry.network = dataSource.network();
    registry.chainId = chainId;
    registry.agentRegistry = toEip155Caip10(chainId, address);
    registry.agentCount = BigInt.zero();
    registry.unburnedAgentCount = BigInt.zero();
    registry.createdAt = timestamp.toI64();
  }
  return registry;
}

// The `chainId` context value set for this data source in
// subgraph.template.yaml; agent and registry entity IDs are chain-scoped.
function contextChainId(): BigInt {
  return dataSource.context().getBigInt('chainId');
}

// `agentWallet` is a reserved onchain metadata key (see the 8004scan agent
// metadata profile): its value is the 20-byte wallet address, right-aligned
// in the ABI-encoded bytes. A zero address means the wallet was cleared.
function agentWalletFromMetadataValue(value: Bytes): Address | null {
  if (value.length < 20) return null;

  const address = Address.fromBytes(Bytes.fromUint8Array(value.subarray(value.length - 20)));
  if (address.equals(Address.zero())) return null;
  return address;
}
