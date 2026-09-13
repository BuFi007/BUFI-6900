import { Address, BigInt, Bytes, dataSource, ethereum } from '@graphprotocol/graph-ts';

import { AgenticCommerce as AgenticCommerceContract } from '../../generated/AgenticCommerce/AgenticCommerce';
import { AgenticCommerce } from '../../generated/schema';
import { getOrCreateAccount } from '../shared/account';

/**
 * `AgenticCommerce` entity ID: UTF-8 bytes of "<chainId>:<contract address>",
 * the same chain-scoped scheme the registries use, so ids never collide across
 * chains when the escrow deploys at one address on several of them.
 */
export function agenticCommerceEntityId(chainId: BigInt, address: Address): Bytes {
  return Bytes.fromUTF8(chainId.toString() + ':' + address.toHexString());
}

export function contextChainId(): BigInt {
  return dataSource.context().getBigInt('chainId');
}

/** Arc settles in USDC; the escrow has no per-job token event, so it is manifest context. */
export function contextPaymentToken(): Bytes {
  return dataSource.context().getBytes('paymentToken');
}

export function getOrCreateAgenticCommerce(event: ethereum.Event): AgenticCommerce {
  const chainId = contextChainId();
  const id = agenticCommerceEntityId(chainId, event.address);
  let agenticCommerce = AgenticCommerce.load(id);
  if (agenticCommerce != null) return agenticCommerce;

  agenticCommerce = new AgenticCommerce(id);
  agenticCommerce.network = dataSource.network();
  agenticCommerce.chainId = chainId;
  agenticCommerce.paymentToken = contextPaymentToken();
  agenticCommerce.platformFeeBP = BigInt.zero();
  agenticCommerce.evaluatorFeeBP = BigInt.zero();
  agenticCommerce.jobCount = BigInt.zero();
  agenticCommerce.settledJobCount = BigInt.zero();
  agenticCommerce.settledVolume = BigInt.zero();
  agenticCommerce.refundedVolume = BigInt.zero();
  agenticCommerce.createdAt = event.block.timestamp.toI64();
  agenticCommerce.updatedAt = event.block.timestamp.toI64();

  // Fee configuration has no events on Circle's implementation; read it once
  // at first sight (three views, first block only).
  const contract = AgenticCommerceContract.bind(event.address);
  const treasury = contract.try_platformTreasury();
  if (!treasury.reverted && !treasury.value.equals(Address.zero())) {
    agenticCommerce.platformTreasury = getOrCreateAccount(treasury.value).id;
  }
  const platformFee = contract.try_platformFeeBP();
  if (!platformFee.reverted) agenticCommerce.platformFeeBP = platformFee.value;
  const evaluatorFee = contract.try_evaluatorFeeBP();
  if (!evaluatorFee.reverted) agenticCommerce.evaluatorFeeBP = evaluatorFee.value;

  agenticCommerce.save();
  return agenticCommerce;
}
