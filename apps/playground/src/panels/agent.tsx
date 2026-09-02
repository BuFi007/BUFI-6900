/*
 * Copyright (c) 2026 BUFI. Licensed under the Apache License, Version 2.0.
 *
 * The agent face: a session key (kept in localStorage — it is the AGENT's key, not the owner's) granted a BUFI policy
 * {scope, budget, expiry} through `buildAgentFaceCalls`. The first grant installs BufiSessionKeyPlugin seeded with the
 * key; later grants are `addSessionKey` calls. Both are plugin management calls = raw user operation calldata.
 */
import * as React from 'react'
import { type Address, type LocalAccount, formatEther, formatUnits, parseEther } from 'viem'
import type { SmartAccount } from 'viem/account-abstraction'

import {
  type SpendLimitInfo,
  buildAgentFaceCalls,
  encodeRemoveSessionKey,
  findPredecessor,
  getERC20SpendLimitInfo,
  getGasSpendLimit,
  getKeyTimeRange,
} from '@bufi/modular-wallets-core'

import {
  APPROVE_SELECTOR,
  type OpOptions,
  TRANSFER_SELECTOR,
  USDC,
  USDC_DECIMALS,
  bundlerClient,
  deployment,
  formatError,
  isInstalled,
  rpc,
  sameAddress,
  sendUserOp,
  short,
  usdc,
} from '../sandbox'
import type { AccountState } from '../state'
import { Field, Mono, OpStatus, Panel, Tag, useOp } from '../ui'

interface KeyDetails {
  validAfter: number
  validUntil: number
  usdc: SpendLimitInfo
  gas: SpendLimitInfo
}

const when = (ts: number): string => (ts === 0 ? 'unbounded' : new Date(ts * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC')
const perWindow = (seconds: number): string => (seconds === 0 ? 'never refreshes' : `per ${seconds}s`)

export function AgentPanel(props: {
  account: SmartAccount
  state: AccountState | undefined
  ops: OpOptions
  onChanged: () => void
  agent: LocalAccount | undefined
  onGenerateAgent: () => void
}) {
  const { account, state, ops, onChanged, agent, onGenerateAgent } = props
  const plugin = deployment.bufiSessionKey?.address
  const installed = state !== undefined && isInstalled(state.installed, plugin)
  const { state: op, run, busy } = useOp(onChanged)

  const [allowTransfer, setAllowTransfer] = React.useState(true)
  const [allowApprove, setAllowApprove] = React.useState(false)
  const [erc20Limit, setErc20Limit] = React.useState('500')
  const [erc20Window, setErc20Window] = React.useState('86400')
  const [gasLimit, setGasLimit] = React.useState('1')
  const [gasWindow, setGasWindow] = React.useState('86400')
  const [expiryDays, setExpiryDays] = React.useState('7')

  const [details, setDetails] = React.useState<Record<string, KeyDetails>>({})
  const [readError, setReadError] = React.useState<string>()

  React.useEffect(() => {
    if (!plugin || !state || !installed || state.sessionKeys.length === 0) {
      setDetails({})
      return
    }
    let cancelled = false
    Promise.all(
      state.sessionKeys.map(async (sessionKey) => {
        const base = { plugin, account: account.address, sessionKey }
        const [range, erc20, gas] = await Promise.all([
          getKeyTimeRange(rpc, base),
          getERC20SpendLimitInfo(rpc, { ...base, token: usdc }),
          getGasSpendLimit(rpc, base),
        ])
        return [sessionKey.toLowerCase(), { ...range, usdc: erc20, gas: gas.info }] as const
      }),
    )
      .then((entries) => {
        if (!cancelled) {
          setDetails(Object.fromEntries(entries))
          setReadError(undefined)
        }
      })
      .catch((error) => {
        if (!cancelled) setReadError(formatError(error))
      })
    return () => {
      cancelled = true
    }
  }, [plugin, state, installed, account.address])

  const grant = () =>
    run(installed ? 'addSessionKey(agent, grant)' : 'installPlugin(BufiSessionKeyPlugin) seeded with the agent grant', async () => {
      if (!agent) throw new Error('generate an agent key first')
      if (!plugin) throw new Error('the deployment carries no bufiSessionKey plugin — build the contracts and restart the sandbox')
      const selectors = [...(allowTransfer ? [TRANSFER_SELECTOR] : []), ...(allowApprove ? [APPROVE_SELECTOR] : [])]
      const now = Number((await rpc.getBlock()).timestamp)
      const face = buildAgentFaceCalls({
        account: account.address,
        deployment,
        agents: [
          {
            sessionKey: agent.address,
            grant: {
              scope: { allow: [{ target: usdc, selectors: selectors.length > 0 ? selectors : undefined }] },
              budget: {
                erc20: [{ token: usdc, limit: USDC(erc20Limit), refreshIntervalSeconds: Number(erc20Window) }],
                gas: { limit: parseEther(gasLimit), refreshIntervalSeconds: Number(gasWindow) },
              },
              expiry: { validUntil: now + Math.round(Number(expiryDays) * 86_400) },
            },
          },
        ],
      })
      const callData = installed ? face.addSessionKeys[0].data : face.installSessionKeyPlugin.data
      return sendUserOp(bundlerClient, { account, callData, ...ops })
    })

  const revoke = (sessionKey: Address) =>
    run(`removeSessionKey(${short(sessionKey)})`, async () => {
      if (!plugin) throw new Error('no session key plugin')
      const predecessor = await findPredecessor(rpc, { plugin, account: account.address, sessionKey })
      return sendUserOp(bundlerClient, { account, callData: encodeRemoveSessionKey({ sessionKey, predecessor }), ...ops })
    })

  return (
    <Panel
      title="Agent grant"
      id="agent"
      badge={
        !plugin ? <Tag kind="off">plugin not deployed</Tag> : installed ? <Tag kind="ok">BufiSessionKeyPlugin installed</Tag> : <Tag kind="off">not installed</Tag>
      }
    >
      <p className="muted">
        <Mono>BufiSessionKeyPlugin</Mono> at <Mono>{plugin ?? '—'}</Mono> (Alchemy MAv1 <Mono>ISessionKeyPlugin</Mono>{' '}
        ABI). <Mono>buildAgentFaceCalls</Mono> compiles the grant into ordered permission updates; the first grant
        installs the plugin seeded with the key, the next ones are <Mono>addSessionKey</Mono>.
      </p>
      <dl className="kv">
        <dt>Agent key</dt>
        <dd>
          {agent ? (
            <>
              <Mono>{agent.address}</Mono>{' '}
              {state && agent && state.sessionKeys.some((k) => sameAddress(k, agent.address)) ? <Tag kind="ok">granted</Tag> : <Tag kind="off">not granted</Tag>}
            </>
          ) : (
            <span className="muted">none yet</span>
          )}{' '}
          <button onClick={onGenerateAgent} disabled={busy} id="generate-agent">
            {agent ? 'Regenerate' : 'Generate'} agent key <Tag kind="dev">localStorage</Tag>
          </button>
        </dd>
      </dl>

      <h3>Grant</h3>
      <div className="row">
        <Field label="Scope · target">
          <input value={`USDC ${short(usdc)}`} readOnly name="scope-target" />
        </Field>
        <Field label="Scope · selectors">
          <span>
            <label className="inline">
              <input type="checkbox" checked={allowTransfer} onChange={(e) => setAllowTransfer(e.target.checked)} name="allow-transfer" /> transfer{' '}
              <Mono>{TRANSFER_SELECTOR}</Mono>
            </label>
            <br />
            <label className="inline">
              <input type="checkbox" checked={allowApprove} onChange={(e) => setAllowApprove(e.target.checked)} name="allow-approve" /> approve{' '}
              <Mono>{APPROVE_SELECTOR}</Mono>
            </label>
          </span>
        </Field>
      </div>
      <div className="row">
        <Field label="ERC-20 budget (USDC)">
          <input value={erc20Limit} onChange={(e) => setErc20Limit(e.target.value)} name="erc20-limit" />
        </Field>
        <Field label="…per window (seconds)">
          <input value={erc20Window} onChange={(e) => setErc20Window(e.target.value)} name="erc20-window" />
        </Field>
        <Field label="Gas budget (ETH)">
          <input value={gasLimit} onChange={(e) => setGasLimit(e.target.value)} name="gas-limit" />
        </Field>
        <Field label="…per window (seconds)">
          <input value={gasWindow} onChange={(e) => setGasWindow(e.target.value)} name="gas-window" />
        </Field>
        <Field label="Expiry (days from now)">
          <input value={expiryDays} onChange={(e) => setExpiryDays(e.target.value)} name="expiry-days" />
        </Field>
      </div>
      <button className="primary" onClick={grant} disabled={busy || !agent || !plugin || !state?.deployed} id="grant-agent">
        {installed ? 'Grant (addSessionKey)' : 'Install plugin + grant'}
      </button>
      {!state?.deployed && <span className="muted"> deploy the account first</span>}

      {installed && (
        <>
          <h3 className="muted">Session keys (sessionKeysOf)</h3>
          {readError && <p className="error">RPC error: {readError}</p>}
          {state && state.sessionKeys.length === 0 && <p className="muted">no keys registered</p>}
          {state && state.sessionKeys.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>key</th>
                  <th>valid</th>
                  <th>USDC budget</th>
                  <th>gas budget</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {state.sessionKeys.map((key) => {
                  const d = details[key.toLowerCase()]
                  return (
                    <tr key={key}>
                      <td>
                        <Mono title={key}>{short(key)}</Mono>
                        {agent && sameAddress(key, agent.address) && <Tag kind="info">this browser's agent</Tag>}
                      </td>
                      <td>{d ? `${when(d.validAfter)} → ${when(d.validUntil)}` : '…'}</td>
                      <td>
                        {d
                          ? d.usdc.hasLimit
                            ? `${formatUnits(d.usdc.limitUsed, USDC_DECIMALS)} / ${formatUnits(d.usdc.limit, USDC_DECIMALS)} ${perWindow(d.usdc.refreshInterval)}`
                            : 'no limit'
                          : '…'}
                      </td>
                      <td>
                        {d
                          ? d.gas.hasLimit
                            ? `${formatEther(d.gas.limitUsed)} / ${formatEther(d.gas.limit)} ETH ${perWindow(d.gas.refreshInterval)}`
                            : 'no limit'
                          : '…'}
                      </td>
                      <td>
                        <button onClick={() => revoke(key)} disabled={busy}>
                          revoke
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </>
      )}
      <OpStatus state={op} />
    </Panel>
  )
}
