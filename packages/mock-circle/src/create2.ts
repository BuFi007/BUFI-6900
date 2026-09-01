/*
 * @bufi/mock-circle — CREATE2 through the Arachnid deterministic deployment proxy.
 *
 * calldata = salt(32) ‖ creationCode ‖ constructorArgs; the proxy returns the 20-byte address.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import { concatHex, getAddress, getContractAddress, type Address, type Hex } from 'viem'

import { hasCode, type Clients } from './chain.ts'
import { CIRCLE_CANONICAL, type Logger } from './config.ts'

export interface Create2Request {
  label: string
  salt: Hex
  creationCode: Hex
  constructorArgs?: Hex
  /** When set, the computed address must match (Circle's canonical addresses). */
  expected?: Address
}

export interface Create2Result {
  address: Address
  /** false when code already existed at the address (idempotent re-run). */
  deployed: boolean
}

export function create2Address(salt: Hex, initCode: Hex): Address {
  return getContractAddress({ opcode: 'CREATE2', from: CIRCLE_CANONICAL.create2Deployer, salt, bytecode: initCode })
}

export async function deployCreate2(clients: Clients, req: Create2Request, log: Logger): Promise<Create2Result> {
  const initCode = concatHex([req.creationCode, req.constructorArgs ?? '0x'])
  const address = create2Address(req.salt, initCode)
  if (req.expected && getAddress(req.expected) !== address) {
    throw new Error(
      `${req.label}: CREATE2 pre-image does not land on the expected address (computed ${address}, expected ${req.expected})`,
    )
  }
  if (await hasCode(clients.publicClient, address)) {
    log(`${req.label}: already at ${address}`)
    return { address, deployed: false }
  }

  const data = concatHex([req.salt, initCode])
  // Dry-run first: the proxy returns the address, and a constructor revert surfaces here with a reason.
  const dryRun = await clients.publicClient.call({
    account: clients.account,
    to: CIRCLE_CANONICAL.create2Deployer,
    data,
  })
  const returned = dryRun.data ? getAddress(`0x${dryRun.data.slice(-40)}`) : undefined
  if (returned !== address) {
    throw new Error(`${req.label}: deployer dry-run returned ${returned ?? '<nothing>'}, expected ${address}`)
  }

  const hash = await clients.walletClient.sendTransaction({ to: CIRCLE_CANONICAL.create2Deployer, data })
  const receipt = await clients.publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`${req.label}: CREATE2 transaction reverted (${hash})`)
  if (!(await hasCode(clients.publicClient, address))) {
    throw new Error(`${req.label}: transaction succeeded but no code at ${address}`)
  }
  log(`${req.label}: deployed at ${address} (gas ${receipt.gasUsed})`)
  return { address, deployed: true }
}
