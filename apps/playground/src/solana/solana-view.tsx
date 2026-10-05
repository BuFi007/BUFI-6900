/*
 * Copyright (c) 2026 BUFI. Licensed under the Apache License, Version 2.0.
 *
 * The Solana half of the playground: one weighted-treasury spec → Squads Smart Account policies, driven step by
 * step against the live program, with every spend judged twice (the EVM weighted rule vs. what Squads did).
 */
import * as React from 'react'

import { Field, Mono, Panel, Tag } from '../ui'
import { DEVNET, LOCALNET, OWNER_IDS, short, useSquadsDemo } from './use-squads-demo'

export function SolanaView() {
  const demo = useSquadsDemo()
  const { store, keys, owners, compiled, chain, busy, message, attempts, actions, savedPlan } = demo
  const plan = compiled.squads
  const proposal = chain.proposal
  const approved = new Set(proposal?.approved ?? [])
  const policiesLive = chain.policies.length > 0 && chain.policies.every(Boolean)
  const [group, setGroup] = React.useState<string[]>(['A', 'B'])
  const [destination, setDestination] = React.useState<'R' | 'S'>('R')
  const [amount, setAmount] = React.useState(10)
  const [now, setNow] = React.useState(() => Math.floor(Date.now() / 1000))
  React.useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(t)
  }, [])

  const approvedAt = proposal?.status === 'Approved' ? proposal.timestamp : undefined
  const unlocksIn = approvedAt !== undefined ? Math.max(0, approvedAt + (chain.settings?.timeLock ?? store.timelock) - now) : undefined
  const tusd = (raw: bigint) => (Number(raw) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 })
  const disabled = busy !== undefined
  const explorer = (address: string) =>
    store.rpc === DEVNET
      ? `https://explorer.solana.com/address/${address}?cluster=devnet`
      : `https://explorer.solana.com/address/${address}?cluster=custom&customUrl=${encodeURIComponent(store.rpc)}`

  return (
    <>
      <div className="banner" id="solana-sandbox">
        <b>Solana</b> Squads Smart Account Program <Mono>SMRTzfY6…dunG</Mono> ·{' '}
        <select id="solana-rpc" aria-label="Cluster" value={store.rpc} onChange={(e) => actions.setRpc(e.target.value)}>
          <option value={LOCALNET}>localnet (mainnet program cloned)</option>
          <option value={DEVNET}>devnet</option>
        </select>{' '}
        {chain.online ? (
          chain.programDeployed ? <Tag kind="ok">program found</Tag> : <Tag kind="off">program missing</Tag>
        ) : (
          <Tag kind="off">cluster offline</Tag>
        )}
        <br />
        fee payer <Mono>{short(keys.payer!.publicKey.toBase58())}</Mono> · <span id="payer-sol">{chain.payerSol.toFixed(2)}</span> SOL{' '}
        <button id="airdrop" onClick={actions.airdrop} disabled={disabled || !chain.online}>
          Airdrop 10 SOL
        </button>
        {!chain.online && (
          <span className="muted">
            {' '}
            Start it with <Mono>bun run solana:sandbox</Mono> at the repo root.
          </span>
        )}
        <br />
        <span className="muted">
          Owners are browser keypairs standing in for Circle user-controlled Solana wallets (identical on-chain). They hold{' '}
          <b>0 SOL</b>: the payer covers every fee.
        </span>
      </div>

      {message && (
        <p className={message.kind === 'error' ? 'error' : 'note'} id="solana-message" role="status">
          {message.text}
        </p>
      )}
      {busy && <p className="pending">⏳ {busy}…</p>}

      <Panel title="1 · Spec" id="spec" badge={compiled.error ? <Tag kind="off">does not compile</Tag> : <Tag kind="ok">compiles to both</Tag>}>
        <p className="muted">One spec, two chains. Change a weight or the threshold and both compilers rerun.</p>
        <div className="row">
          <Field label="Owners">
            <select id="owner-count" value={store.ownerCount} onChange={(e) => actions.setOwnerCount(Number(e.target.value))}>
              {[2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Threshold weight">
            <input id="threshold" type="number" min={1} value={store.threshold} onChange={(e) => actions.setThreshold(Number(e.target.value))} />
          </Field>
          <Field label="Admin timelock (s)">
            <input id="timelock" type="number" min={0} value={store.timelock} onChange={(e) => actions.setTimelock(Number(e.target.value))} />
          </Field>
        </div>
        <table>
          <thead>
            <tr>
              <th>Owner</th>
              <th>Weight</th>
              <th>Solana key</th>
              <th>SOL</th>
            </tr>
          </thead>
          <tbody>
            {owners.map((id, i) => (
              <tr key={id}>
                <td>{id}</td>
                <td>
                  <input
                    id={`weight-${id}`}
                    aria-label={`Weight of ${id}`}
                    type="number"
                    min={1}
                    value={store.weights[i]}
                    onChange={(e) => actions.setWeight(i, Number(e.target.value))}
                    style={{ width: '5rem' }}
                  />
                </td>
                <td>
                  <Mono>{keys[id]!.publicKey.toBase58()}</Mono>
                </td>
                <td>{(chain.ownerSol[id] ?? 0).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted">
          Allowlist: <b>R</b> <Mono>{keys.R!.publicKey.toBase58()}</Mono>. Not on it: <b>S</b> <Mono>{keys.S!.publicKey.toBase58()}</Mono>
        </p>
        {compiled.error ? (
          <p className="error" id="compile-error">
            Refused: {compiled.error}
          </p>
        ) : (
          plan && (
            <div className="grid" id="compiled">
              <div>
                <h3>Squads (Solana)</h3>
                <ul className="list" id="coalitions">
                  {plan.policies.map((p) => (
                    <li key={p.coalition.join()}>
                      policy <b>{`{${p.coalition.join(', ')}}`}</b> · all {p.threshold} sign · pays only the allowlist
                    </li>
                  ))}
                </ul>
                <p className="muted">Settings: all {plan.settings.threshold} owners, {plan.settings.timeLock}s timelock.</p>
              </div>
              <div>
                <h3>Circle MSCA (EVM)</h3>
                <ul className="list">
                  {compiled.evm!.owners.map((o, i) => (
                    <li key={o.address}>
                      {OWNER_IDS[i]} weight {o.weight.toString()}
                    </li>
                  ))}
                  <li>threshold weight {compiled.evm!.thresholdWeight.toString()}</li>
                  <li>AddressBook: {compiled.evm!.allowlist.length} recipient</li>
                </ul>
                <p className="muted">EVM addresses here are illustrative.</p>
              </div>
            </div>
          )
        )}
      </Panel>

      <div className="grid">
        <Panel title="2 · Treasury" id="treasury" badge={chain.settings ? <Tag kind="ok">on-chain</Tag> : <Tag kind="off">not created</Tag>}>
          <button className="primary" id="create-treasury" onClick={actions.createTreasury} disabled={disabled || !plan || !chain.online}>
            Create smart account
          </button>
          <button id="fund-vault" onClick={actions.fundVault} disabled={disabled || !store.treasury}>
            Create test token, fund vault
          </button>
          <button id="reset" onClick={actions.reset} disabled={disabled}>
            Forget treasury
          </button>
          {store.treasury && (
            <dl className="kv">
              <dt>settings</dt>
              <dd>
                <a href={explorer(store.treasury.settings)} target="_blank" rel="noopener">
                  <Mono>{store.treasury.settings}</Mono>
                </a>
              </dd>
              <dt>vault</dt>
              <dd>
                <Mono>{store.treasury.vault}</Mono>
              </dd>
              {chain.settings && (
                <>
                  <dt>on-chain</dt>
                  <dd id="settings-onchain">
                    {chain.settings.signers.length} signers · threshold {chain.settings.threshold} · timelock {chain.settings.timeLock}s
                  </dd>
                </>
              )}
              <dt>balances</dt>
              <dd id="balances">
                vault {tusd(chain.balances.vault)} · R {tusd(chain.balances.R)} · S {tusd(chain.balances.S)} TUSD
              </dd>
            </dl>
          )}
        </Panel>

        <Panel
          title="3 · Admin: create policies"
          id="admin"
          badge={policiesLive ? <Tag kind="ok">policies live</Tag> : proposal ? <Tag kind="info">{proposal.status}</Tag> : <Tag kind="off">none</Tag>}
        >
          <p className="muted">Rule changes need every owner on Squads, then the timelock. On EVM the weighted quorum is enough.</p>
          <button id="propose" onClick={actions.propose} disabled={disabled || !store.token || !!store.admin}>
            Propose policies (as A)
          </button>
          <div>
            {owners.map((id) => {
              const key = keys[id]!.publicKey.toBase58()
              return (
                <button key={id} id={`approve-${id}`} onClick={() => actions.approve(id)} disabled={disabled || !proposal || approved.has(key) || policiesLive}>
                  {approved.has(key) ? `${id} approved ✓` : `Approve as ${id}`}
                </button>
              )
            })}
          </div>
          <button className="primary" id="execute" onClick={actions.execute} disabled={disabled || !proposal || policiesLive}>
            Execute
          </button>
          {proposal && (
            <p className="muted" id="proposal-status">
              Status <b>{proposal.status}</b> · {proposal.approved.length} of {owners.length} approved
              {unlocksIn !== undefined && !policiesLive && (unlocksIn > 0 ? ` · timelock ${unlocksIn}s left` : ' · timelock elapsed')}
            </p>
          )}
          {policiesLive && (
            <ul className="list" id="policies-onchain">
              {chain.policies.map((p, i) => (
                <li key={p!.address}>
                  {savedPlan ? `{${savedPlan.policies[i]!.coalition.join(',')}}` : ''} <Mono>{short(p!.address)}</Mono> · threshold {p!.threshold}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel title="4 · Spend" id="spend" badge={policiesLive ? <Tag kind="ok">ready</Tag> : <Tag kind="off">needs policies</Tag>}>
        <p className="muted">
          Pick who approves and where the money goes. The left column is what the EVM weighted multisig and AddressBook would
          allow. The right column is what the Squads program actually did.
        </p>
        <div className="row">
          <fieldset className="field" aria-label="Approving owners">
            <span>Approving owners</span>
            <div>
              {(savedPlan ? store.admin?.owners.map((o) => o.id) ?? owners : owners).map((id) => (
                <label key={id} className="inline" style={{ marginRight: '0.8rem' }}>
                  <input
                    type="checkbox"
                    id={`group-${id}`}
                    checked={group.includes(id)}
                    onChange={(e) => setGroup((g) => (e.target.checked ? [...g, id].sort() : g.filter((x) => x !== id)))}
                  />{' '}
                  {id}
                </label>
              ))}
            </div>
          </fieldset>
          <Field label="Destination">
            <select id="destination" value={destination} onChange={(e) => setDestination(e.target.value as 'R' | 'S')}>
              <option value="R">R (allowlisted)</option>
              <option value="S">S (not allowlisted)</option>
            </select>
          </Field>
          <Field label="Amount (TUSD)">
            <input id="amount" type="number" min={0.000001} step="any" value={amount} onChange={(e) => setAmount(Number(e.target.value))} />
          </Field>
        </div>
        <button className="primary" id="send" onClick={() => actions.spend(group, destination, amount)} disabled={disabled || !policiesLive || group.length === 0 || !(amount > 0)}>
          Send
        </button>
        {attempts.length > 0 && (
          <table id="attempts">
            <thead>
              <tr>
                <th>Group</th>
                <th>To</th>
                <th>EVM rule says</th>
                <th>Squads did</th>
                <th>Same?</th>
              </tr>
            </thead>
            <tbody>
              {attempts.map((a) => (
                <tr key={a.id}>
                  <td>
                    {`{${a.group.join(',')}}`}
                    <br />
                    <span className="muted">{a.policy}</span>
                  </td>
                  <td>
                    {a.destination} · {a.amount}
                  </td>
                  <td className={a.expected.pass ? 'good' : 'bad'}>
                    {a.expected.pass ? 'allow' : 'refuse'}
                    <br />
                    <span className="muted">{a.expected.why}</span>
                  </td>
                  <td className={a.actual.pass ? 'good' : 'bad'}>
                    {a.actual.pass ? 'paid' : 'rejected'}
                    <br />
                    <span className="muted">{a.actual.detail}</span>
                  </td>
                  <td className={a.expected.pass === a.actual.pass ? 'good' : 'bad'}>{a.expected.pass === a.actual.pass ? '✓' : '✗ MISMATCH'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  )
}
