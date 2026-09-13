import { Address } from '@graphprotocol/graph-ts';

import { Account } from '../../generated/schema';

/**
 * Loads or lazily creates the `Account` for `address`. Shared by every data
 * source: an address can be an identity owner, an agent wallet, a feedback
 * client, or an escrow party, and `Account` has no other required fields.
 */
export function getOrCreateAccount(address: Address): Account {
  let account = Account.load(address);
  if (account == null) {
    account = new Account(address);
    account.save();
  }
  return account;
}
