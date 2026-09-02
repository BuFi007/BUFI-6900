/*
 * Copyright (c) 2026 BUFI. Licensed under the Apache License, Version 2.0.
 *
 * The agent client: `toBufiSessionKeyAccount` wraps calls in `executeWithSessionKey` and signs with the session
 * key; its own bundler client submits. Shows the two ways a spend fails — validation-phase rejections (scope, time
 * range, gas) come back as RPC errors, while the ERC-20 budget is an execution-phase check: the op is included and
 * reverts on-chain (receipt.success = false, gas paid, no funds moved).
 */
import * as React from 'react'
import { type Hex, type LocalAccount, encodeFunctionData, isAddress, parseUnits } from 'viem'
import { type SmartAccount, createBundlerClient } from 'viem/account-abstraction'

import { encodeTransfer, toBufiSessionKeyAccount } from '@bufi/modular-wallets-core'

import {
  USDC_ABI,
  USDC_DECIMALS,
  chain,
  client,
  deployment,
  formatError,
  isInstalled,
  modularTransport,
  sameAddress,
  sendUserOp,
  short,
  usdc,
} from '../sandbox'
import type { AccountState } from '../state'
import { Field, Mono, OpStatus, Panel, Tag, useOp } from '../ui'

export function AgentSpendPanel(props: {
  account: SmartAccount
  state: AccountState | undefined
  sponsor: boolean
  onChanged: () => void
  agent: LocalAccount | undefined
}) {
  const { account, state, sponsor, onChanged, agent } = props
  const plugin = deployment.bufiSessionKey?.address
  const granted =
    agent !== undefined &&
    state !== undefined &&
    isInstalled(state.installed, plugin) &&
    state.sessionKeys.some((k) => sameAddress(k, agent.address))
  const { state: op, run, busy } = useOp(onChanged)
  const [agentAccount, setAgentAccount] = React.useState<SmartAccount>()
  const [buildError, setBuildError] = React.useState<string>()

  React.useEffect(() => {
    setAgentAccount(undefined)
    setBuildError(undefined)
    if (!granted || !agent || !plugin) return
    let cancelled = false
    toBufiSessionKeyAccount({ client, account: account.address, sessionKey: agent, plugin, deployment })
      .then((built) => {
        if (!cancelled) setAgentAccount(built)
      })
      .catch((error) => {
        if (!cancelled) setBuildError(formatError(error))
      })
    return () => {
      cancelled = true
    }
  }, [granted, agent, plugin, account.address])

  // The agent's own bundler client — the owner's client is never involved in an agent spend.
  const agentBundler = React.useMemo(
    () => (agentAccount ? createBundlerClient({ account: agentAccount, chain, transport: modularTransport }) : undefined),
    [agentAccount],
  )

  const spend = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const formData = new FormData(event.currentTarget)
    const to = String(formData.get('to') ?? '').trim()
    const value = String(formData.get('value') ?? '').trim()
    run(`agent transfer ${value} USDC → ${to ? short(to) : '?'}`, () => {
      if (!agentBundler || !agentAccount) throw new Error('agent account not ready')
      if (!isAddress(to)) throw new Error('recipient is not an address')
      return sendUserOp(agentBundler, { account: agentAccount, calls: [encodeTransfer(to, usdc, parseUnits(value, USDC_DECIMALS))], sponsor })
    })
  }
  const tryApprove = () =>
    run('agent USDC.approve (selector outside the grant)', () => {
      if (!agentBundler || !agentAccount) throw new Error('agent account not ready')
      const data = encodeFunctionData({ abi: USDC_ABI, functionName: 'approve', args: [account.address, 1n] })
      return sendUserOp(agentBundler, { account: agentAccount, calls: [{ to: usdc, data }], sponsor })
    })
  const trySelfCall = () =>
    run('agent calls the account itself (target outside the grant)', () => {
      if (!agentBundler || !agentAccount) throw new Error('agent account not ready')
      return sendUserOp(agentBundler, { account: agentAccount, calls: [{ to: account.address, data: '0x' as Hex, value: 0n }], sponsor })
    })

  return (
    <Panel title="Agent spend" id="agent-spend" badge={granted ? <Tag kind="ok">agent granted</Tag> : <Tag kind="off">no grant</Tag>}>
      <p className="muted">
        <Mono>toBufiSessionKeyAccount</Mono> + its own <Mono>createBundlerClient</Mono>. Calls go out as{' '}
        <Mono>executeWithSessionKey(calls, sessionKey)</Mono>, signed by the agent key.
      </p>
      {!agent && <p className="muted">Generate an agent key in the Agent grant panel.</p>}
      {agent && !granted && <p className="muted">Grant the agent first.</p>}
      {buildError && <p className="error">RPC error: {buildError}</p>}
      {granted && !agentAccount && !buildError && <p className="muted">building the agent account…</p>}
      <form onSubmit={spend} className="row">
        <Field label="To (any address — the address book does NOT gate executeWithSessionKey)">
          <input name="to" placeholder="Address" />
        </Field>
        <Field label="Amount (USDC)">
          <input name="value" placeholder="Amount (USDC)" defaultValue="200" />
        </Field>
        <button type="submit" className="primary" disabled={busy || !agentBundler} id="agent-send">
          Spend as agent
        </button>
      </form>
      <p>
        <button onClick={tryApprove} disabled={busy || !agentBundler} id="agent-approve">
          Try USDC.approve
        </button>
        <button onClick={trySelfCall} disabled={busy || !agentBundler} id="agent-selfcall">
          Try calling the account
        </button>
        <span className="muted"> both are outside the grant → rejected at validation (RPC error)</span>
      </p>
      <p className="muted">
        Over the ERC-20 budget → the op is <b>included</b> and reverts on-chain: <Mono>receipt.success = false</Mono>{' '}
        below, gas paid, no funds moved (execution-phase check).
      </p>
      <OpStatus state={op} />
    </Panel>
  )
}
