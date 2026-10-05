// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react'

import { ASSETS, POSITIONS, type PositionId, pickSource } from '../shared/config'
import type { TreasuryPolicy } from '../shared/types'
import { domainName, shortAddr, usd } from './format'
import { JobStatus } from './job-status'
import { useSend } from './use-send'

interface Props {
  policy: TreasuryPolicy
  balances: Record<PositionId, number> | null
  signer: boolean
  onSettled: () => void
}

export function OwnerPicker({ policy, chosen, onChange }: { policy: TreasuryPolicy; chosen: string[]; onChange: (ids: string[]) => void }) {
  const weight = chosen.reduce((s, id) => s + (policy.owners.find((o) => o.id === id)?.weight ?? 0), 0)
  const reached = weight >= policy.thresholdWeight
  return (
    <fieldset className="owners">
      <legend>Approvals</legend>
      {policy.owners.map((o) => (
        <label key={o.id} className="check">
          <input
            type="checkbox"
            checked={chosen.includes(o.id)}
            onChange={(e) => onChange(e.target.checked ? [...chosen, o.id] : chosen.filter((x) => x !== o.id))}
          />
          Owner {o.id} <span className="muted">weight {o.weight}</span> <span className="mono muted">{shortAddr(o.address)}</span>
        </label>
      ))}
      <div className={`quorum ${reached ? 'good' : 'bad'}`} aria-live="polite">
        weight {weight} of {policy.thresholdWeight} {reached ? 'reached' : 'needed'}
      </div>
    </fieldset>
  )
}

export function SendPanel({ policy, balances, signer, onSettled }: Props) {
  const [asset, setAsset] = useState('USDC')
  const [amount, setAmount] = useState('0.25')
  const [recipient, setRecipient] = useState(policy.allowlist[0]?.address ?? '')
  const [owners, setOwners] = useState<string[]>(['A', 'B'])
  const [override, setOverride] = useState<'auto' | PositionId>('auto')
  const { job, error, submit, resume, busy } = useSend(onSettled)

  const n = Number(amount)
  const amountOk = /^\d+(\.\d{1,6})?$/.test(amount) && n > 0
  const auto = balances && amountOk ? pickSource(balances, n, policy.perIntentCap) : null
  const source = override === 'auto' ? auto : override
  const weight = owners.reduce((s, id) => s + (policy.owners.find((o) => o.id === id)?.weight ?? 0), 0)
  const ready = signer && amountOk && asset === 'USDC' && !!recipient && weight >= policy.thresholdWeight && !!source && !busy

  return (
    <section className="panel">
      <h2>Send</h2>
      <div className="row">
        <label className="field">
          <span>Asset</span>
          <select value={asset} onChange={(e) => setAsset(e.target.value)}>
            {ASSETS.map((a) => (
              <option key={a.symbol} value={a.symbol} disabled={!a.onGateway}>
                {a.symbol}
                {a.onGateway ? '' : ' (not on Gateway yet)'}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Amount</span>
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.trim())} aria-invalid={!amountOk} />
        </label>
      </div>

      <fieldset className="recipients">
        <legend>Recipient (treasury allowlist)</legend>
        {policy.allowlist.map((r) => (
          <label key={r.address} className="check">
            <input type="radio" name="recipient" checked={recipient === r.address} onChange={() => setRecipient(r.address)} />
            {r.id} <span className="mono muted">{r.address}</span>
          </label>
        ))}
        <details className="policy">
          <summary>Policy {policy.live ? <span className="tag ok">live from contract</span> : <span className="tag off">as deployed</span>}</summary>
          <ul className="small">
            <li>Quorum: weight {policy.thresholdWeight} ({policy.owners.map((o) => `${o.id}=${o.weight}`).join(', ')})</li>
            <li>Destinations: {policy.destinationDomains.map(domainName).join(', ')} (treasury contract); Arc testnet (Squads vault)</li>
            <li>Per-intent cap: {usd(policy.perIntentCap)} USDC · fee cap: {usd(policy.maxFeeCap)} USDC</li>
            <li>Expiry window: at most {policy.maxExpiryBlocks.toLocaleString()} blocks</li>
          </ul>
        </details>
      </fieldset>

      <OwnerPicker policy={policy} chosen={owners} onChange={setOwners} />

      <div className="row">
        <label className="field">
          <span>Pay from</span>
          <select value={override} onChange={(e) => setOverride(e.target.value as 'auto' | PositionId)}>
            <option value="auto">Automatic{auto ? ` (${POSITIONS[auto].label})` : ''}</option>
            {(Object.keys(POSITIONS) as PositionId[]).map((id) => (
              <option key={id} value={id}>
                {POSITIONS[id].label} · {balances ? usd(balances[id]) : '—'} USDC
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="primary"
          disabled={!ready}
          onClick={() => submit({ asset: 'USDC', amount, recipient, signers: owners, source: override })}
        >
          {busy ? 'Sending…' : `Send ${amountOk ? amount : ''} ${asset}`}
        </button>
      </div>
      {source && <p className="small muted">Delivered on {POSITIONS[source].destination.chain}.</p>}
      {!source && amountOk && balances && <p className="small bad">No position covers {amount} USDC plus fee.</p>}
      {!signer && <p className="notice">Connect a signer to send. This build carries no keys and no signing endpoints.</p>}
      {error && <p className="bad">{error}</p>}
      {job && <JobStatus job={job} onResume={resume} />}
    </section>
  )
}
