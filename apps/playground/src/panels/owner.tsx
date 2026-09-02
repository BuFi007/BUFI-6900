/*
 * Copyright (c) 2026, Circle Internet Group, Inc. All rights reserved.
 * Modifications Copyright (c) 2026 BUFI. Licensed under the Apache License, Version 2.0.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// The "Account" + "Send User Operation" sections of Circle's example, plus balances and a dev-only faucet.
import type * as React from 'react'
import { type LocalAccount, formatEther, formatUnits, isAddress, parseEther, parseUnits } from 'viem'
import type { SmartAccount, WebAuthnAccount } from 'viem/account-abstraction'

import { encodeTransfer } from '@bufi/modular-wallets-core'

import type { OwnerMode } from '../app'
import { ANVIL, type OpOptions, USDC, USDC_ABI, USDC_DECIMALS, bundlerClient, deployerWallet, rpc, sendUserOp, short, usdc } from '../sandbox'
import type { AccountState } from '../state'
import { Field, Mono, OpStatus, Panel, Tag, useOp } from '../ui'

export function OwnerPanel(props: {
  account: SmartAccount
  owner: LocalAccount | WebAuthnAccount
  ownerMode: OwnerMode
  username: string | null
  state: AccountState | undefined
  ops: OpOptions
  onChanged: () => void
  onForgetOwner: () => void
}) {
  const { account, owner, ownerMode, username, state, ops, onChanged, onForgetOwner } = props
  const { state: op, run, busy } = useOp(onChanged)

  const fundMe = () =>
    run('Fund me: anvil #0 mints 10,000 USDC and sends 5 ETH', async () => {
      const mint = await deployerWallet.writeContract({
        address: usdc,
        abi: USDC_ABI,
        functionName: 'mint',
        args: [account.address, USDC(10_000)],
      })
      await rpc.waitForTransactionReceipt({ hash: mint })
      const eth = await deployerWallet.sendTransaction({ to: account.address, value: parseEther('5') })
      await rpc.waitForTransactionReceipt({ hash: eth })
      return `funded — mint tx ${short(mint)} · ETH tx ${short(eth)}`
    })

  const sendUserOperation = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const formData = new FormData(event.currentTarget)
    const to = String(formData.get('to') ?? '').trim()
    const value = String(formData.get('value') ?? '').trim()
    run(`transfer ${value} USDC → ${to ? short(to) : '?'}`, () => {
      if (!isAddress(to)) throw new Error('recipient is not an address')
      // Create callData for USDC transfer
      const callData = encodeTransfer(to, usdc, parseUnits(value, USDC_DECIMALS))
      return sendUserOp(bundlerClient, { account, calls: [callData], ...ops })
    })
  }

  return (
    <Panel title="Account" id="owner" badge={state?.deployed ? <Tag kind="ok">deployed</Tag> : <Tag kind="off">counterfactual</Tag>}>
      <dl className="kv">
        <dt>Owner</dt>
        <dd>
          {ownerMode === 'passkey' ? (
            <>
              passkey <b>{username ?? '(login)'}</b> · P-256 public key{' '}
              <Mono>{owner.type === 'webAuthn' ? short(owner.publicKey) : '—'}</Mono>{' '}
              <Tag kind="stub">rp_* verification stubbed</Tag>
            </>
          ) : (
            <>
              EOA <Mono>{owner.type === 'local' ? owner.address : '—'}</Mono> <Tag kind="dev">dev</Tag>
            </>
          )}{' '}
          <button onClick={onForgetOwner} disabled={busy} title="Clears the owner from localStorage. A forgotten EOA key is gone for good.">
            Forget owner
          </button>
        </dd>
        <dt>Address</dt>
        <dd>
          <Mono>{account.address}</Mono>
        </dd>
        <dt>USDC</dt>
        <dd id="usdc-balance">{state ? formatUnits(state.usdcBalance, USDC_DECIMALS) : '…'}</dd>
        <dt>ETH</dt>
        <dd id="eth-balance">{state ? formatEther(state.ethBalance) : '…'}</dd>
      </dl>
      <p>
        <button onClick={fundMe} disabled={busy} id="fund-me">
          Fund me <Tag kind="dev">dev · anvil #0 {short(ANVIL.deployer.address)}</Tag>
        </button>
      </p>

      <h3>Send User Operation</h3>
      <p className="muted">
        A plain <Mono>execute</Mono> user operation, as in Circle's example. The first one deploys the account (the
        mock supplies the factory <Mono>initCode</Mono>); once the address book is installed the recipient must be on
        it.
      </p>
      <form onSubmit={sendUserOperation} className="row">
        <Field label="To">
          <input name="to" placeholder="Address" />
        </Field>
        <Field label="Amount (USDC)">
          <input name="value" placeholder="Amount (USDC)" defaultValue="1" />
        </Field>
        <button type="submit" className="primary" disabled={busy} id="send-usdc">
          Send
        </button>
      </form>
      <OpStatus state={op} />
    </Panel>
  )
}
