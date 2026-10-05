// SPDX-License-Identifier: Apache-2.0
/** Reads a mint's outcome from its own receipt, so a public RPC lagging on balanceOf never turns a success into an error. */

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

export interface ReceiptLog {
  address: string
  topics: readonly string[]
  data: string
}

/** Sum of ERC-20 Transfer amounts of `token` to `recipient` in `logs`. */
export function mintedAmountFromLogs(logs: readonly ReceiptLog[], token: string, recipient: string): bigint {
  const to = `0x${recipient.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`
  let total = 0n
  for (const l of logs) {
    if (l.address.toLowerCase() !== token.toLowerCase()) continue
    if (l.topics[0]?.toLowerCase() !== TRANSFER_TOPIC || l.topics[2]?.toLowerCase() !== to) continue
    total += BigInt(l.data === '0x' ? 0 : l.data)
  }
  return total
}
