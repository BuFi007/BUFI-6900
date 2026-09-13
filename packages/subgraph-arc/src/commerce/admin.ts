import { HookWhitelistUpdated, Upgraded } from '../../generated/AgenticCommerce/AgenticCommerce';
import { HookAllowlistEntry } from '../../generated/schema';
import { getOrCreateAgenticCommerce } from './agentic-commerce';

export function handleHookWhitelistUpdated(event: HookWhitelistUpdated): void {
  const agenticCommerce = getOrCreateAgenticCommerce(event);
  // The entity id is chain-scoped and the hook address is fixed-width, so
  // concatenation alone is a collision-free id.
  const id = agenticCommerce.id.concat(event.params.hook);
  let entry = HookAllowlistEntry.load(id);
  if (entry == null) {
    entry = new HookAllowlistEntry(id);
    entry.agenticCommerce = agenticCommerce.id;
    entry.hook = event.params.hook;
  }
  entry.allowed = event.params.status;
  entry.updatedAt = event.block.timestamp.toI64();
  entry.updatedAtBlock = event.block.number;
  entry.updatedAtTransaction = event.transaction.hash;
  entry.save();

  agenticCommerce.updatedAt = event.block.timestamp.toI64();
  agenticCommerce.save();
}

export function handleUpgraded(event: Upgraded): void {
  const agenticCommerce = getOrCreateAgenticCommerce(event);
  agenticCommerce.implementation = event.params.implementation;
  agenticCommerce.updatedAt = event.block.timestamp.toI64();
  agenticCommerce.save();
}
