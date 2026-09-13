import { Address, Bytes, ethereum, store } from '@graphprotocol/graph-ts';

import { Agent, WalletBinding } from '../../generated/schema';
import { getOrCreateAccount } from '../shared/account';

/**
 * BUFI: agent wallet address → workspace identity.
 *
 * The address that signs ERC-8183 jobs and ERC-8004 ratings is the
 * workspace's agent wallet (the `agentWallet` metadata key on its identity),
 * so this binding is the one join between the escrow and the registries. It
 * is written when `agentWallet` is set and removed when the identity's wallet
 * is cleared, transferred or burned.
 */
export function bindWallet(agent: Agent, wallet: Address, event: ethereum.Event): void {
  // A wallet points at one identity; rebinding to a newer identity replaces
  // the old link rather than leaving two workspaces claiming one wallet.
  const account = getOrCreateAccount(wallet);
  let binding = WalletBinding.load(wallet);
  if (binding == null) binding = new WalletBinding(wallet);
  binding.account = account.id;
  binding.agent = agent.id;
  binding.boundAt = event.block.timestamp.toI64();
  binding.boundAtTransaction = event.transaction.hash;
  binding.save();
}

/** Drops the binding for `wallet` if it still points at `agent`. */
export function unbindWallet(agent: Agent, wallet: Bytes | null): void {
  if (!wallet) return;
  const binding = WalletBinding.load(wallet!);
  if (binding == null) return;
  if (!binding.agent.equals(agent.id)) return;
  store.remove('WalletBinding', wallet!.toHexString());
}

/** The workspace behind an address, or null when it is not a bound agent wallet. */
export function resolveAgentByWallet(address: Address): Agent | null {
  const binding = WalletBinding.load(address);
  if (binding == null) return null;
  return Agent.load(binding.agent);
}
