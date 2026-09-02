/*
 * Copyright (c) 2026 BUFI. Licensed under the Apache License, Version 2.0.
 *
 * Circle's ColdStorageAddressBookPlugin driven through the SDK: install with an initial allowlist, read it back
 * (`getAllowedRecipients`), add / remove recipients. Every write is a plugin management call = RAW user operation
 * calldata, one per user operation (see the "Submitting management calls" section of the SDK README).
 */
import * as React from 'react'
import { type Address, isAddress } from 'viem'
import type { SmartAccount } from 'viem/account-abstraction'

import {
  encodeAddAllowedRecipients,
  encodeInstallAddressBook,
  encodeRemoveAllowedRecipients,
  getAllowedRecipients,
} from '@bufi/modular-wallets-core'

import { type OpOptions, bundlerClient, deployment, formatError, isInstalled, rpc, sendUserOp, short } from '../sandbox'
import type { AccountState } from '../state'
import { Field, Mono, OpStatus, Panel, Tag, useOp } from '../ui'

const parseAddresses = (text: string): Address[] =>
  text
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter((s): s is Address => isAddress(s))

export function AddressBookPanel(props: {
  account: SmartAccount
  state: AccountState | undefined
  ops: OpOptions
  onChanged: () => void
}) {
  const { account, state, ops, onChanged } = props
  const plugin = deployment.coldStorageAddressBook.address
  const active = state !== undefined && isInstalled(state.installed, plugin)
  const { state: op, run, busy } = useOp(onChanged)
  const [recipients, setRecipients] = React.useState<readonly Address[]>()
  const [readError, setReadError] = React.useState<string>()
  const [draft, setDraft] = React.useState('')

  React.useEffect(() => {
    if (!active) {
      setRecipients(undefined)
      return
    }
    getAllowedRecipients(rpc, { plugin, account: account.address })
      .then((list) => {
        setRecipients(list)
        setReadError(undefined)
      })
      .catch((error) => setReadError(formatError(error)))
  }, [active, account.address, plugin, state])

  const install = () =>
    run('installPlugin(ColdStorageAddressBook)', () => {
      const call = encodeInstallAddressBook({ account: account.address, recipients: parseAddresses(draft), deployment })
      return sendUserOp(bundlerClient, { account, callData: call.data, ...ops })
    })
  const add = () =>
    run('addAllowedRecipients', () => {
      const list = parseAddresses(draft)
      if (list.length === 0) throw new Error('enter at least one valid address')
      return sendUserOp(bundlerClient, { account, callData: encodeAddAllowedRecipients(list), ...ops })
    })
  const remove = (recipient: Address) =>
    run(`removeAllowedRecipients(${short(recipient)})`, () =>
      sendUserOp(bundlerClient, { account, callData: encodeRemoveAllowedRecipients([recipient]), ...ops }),
    )

  return (
    <Panel
      title="Address book"
      id="address-book"
      badge={active ? <Tag kind="ok">installed</Tag> : <Tag kind="off">not installed</Tag>}
    >
      <p className="muted">
        Circle's <Mono>ColdStorageAddressBookPlugin</Mono> at <Mono>{plugin}</Mono>. It hooks <Mono>execute</Mono> /{' '}
        <Mono>executeBatch</Mono> only: once installed, the owner's "Send USDC" to an unlisted address is rejected at
        validation, while agent spends (<Mono>executeWithSessionKey</Mono>) and earn deposits are not gated by it.
      </p>
      {!state?.deployed && <p className="muted">Deploy the account first (send any user operation from the Owner panel).</p>}
      <Field label={active ? 'Recipients to add (one per line)' : 'Initial allowlist (one address per line, optional)'}>
        <textarea value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="0x…" name="recipients" />
      </Field>
      {!active ? (
        <button className="primary" onClick={install} disabled={busy || !state?.deployed}>
          Install address book
        </button>
      ) : (
        <button className="primary" onClick={add} disabled={busy}>
          Add recipients
        </button>
      )}
      {active && (
        <>
          <h3 className="muted">Allowed recipients (getAllowedRecipients)</h3>
          {readError && <p className="error">RPC error: {readError}</p>}
          {recipients && recipients.length === 0 && <p className="muted">empty allowlist — every owner transfer is rejected</p>}
          {recipients && recipients.length > 0 && (
            <ul className="list">
              {recipients.map((recipient) => (
                <li key={recipient}>
                  <Mono>{recipient}</Mono>{' '}
                  <button onClick={() => remove(recipient)} disabled={busy}>
                    remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <OpStatus state={op} />
    </Panel>
  )
}
