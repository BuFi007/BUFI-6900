// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react'

import { ASSETS, POSITIONS, type PositionId } from '../shared/config'
import { shortAddr, usd } from './format'

export function Holdings({ balances, error, onRefresh }: { balances: Record<PositionId, number> | null; error: string | null; onRefresh: () => void }) {
  const [open, setOpen] = useState(false)
  const total = balances ? balances.evm + balances.solana : null
  return (
    <section className="panel">
      <div className="total">
        <span className="label">Treasury balance</span>
        <span className="amount">{total === null ? '—' : usd(total)}</span>
        <span className="unit">USDC</span>
        <button type="button" className="link" onClick={onRefresh}>
          refresh
        </button>
      </div>
      {error && <p className="bad">{error}</p>}

      <table className="assets">
        <tbody>
          {ASSETS.map((a) => (
            <tr key={a.symbol} data-disabled={!a.onGateway}>
              <td>
                <strong>{a.symbol}</strong> <span className="muted">{a.name}</span>
              </td>
              <td className="num">{a.onGateway ? (total === null ? '—' : usd(total)) : <span className="tag off">not on Gateway yet</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <button type="button" className="link" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} Where the USDC sits ({Object.keys(POSITIONS).length} positions)
      </button>
      {open && (
        <ul className="positions">
          {(Object.keys(POSITIONS) as PositionId[]).map((id) => {
            const p = POSITIONS[id]
            return (
              <li key={id}>
                <div className="row-between">
                  <span>
                    <strong>{p.label}</strong> <span className="muted">· {p.chain} · Gateway domain {p.domain}</span>
                  </span>
                  <span className="num">{balances ? usd(balances[id]) : '—'} USDC</span>
                </div>
                <div className="mono muted" title={p.depositor}>
                  depositor {shortAddr(p.depositor)} · sends mint on {p.destination.chain}
                </div>
                <div className="small muted">{p.enforcement}</div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
