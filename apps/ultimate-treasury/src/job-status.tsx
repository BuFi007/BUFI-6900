// SPDX-License-Identifier: Apache-2.0
import type { Job } from '../shared/types'
import { shortAddr } from './format'

const ICON = { pending: '○', running: '◐', done: '●', failed: '✕', skipped: '–' } as const

export function JobStatus({ job, onResume }: { job: Job; onResume?: (id: string) => void }) {
  return (
    <div className="job" data-status={job.status}>
      <div className="row-between">
        <strong>
          {job.request.amount} USDC → {shortAddr(job.request.recipient)}
        </strong>
        <span className={`tag ${job.status === 'minted' ? 'ok' : job.status === 'running' ? 'info' : 'bad'}`}>{job.status}</span>
      </div>
      <ol className="steps">
        {job.steps.map((s) => (
          <li key={s.key} data-state={s.state}>
            <span className="icon">{ICON[s.state]}</span>
            <span>
              {s.label}
              {s.detail && <div className="small muted">{s.detail}</div>}
              {s.txHash && (
                <div className="mono small">
                  {s.link ? (
                    <a href={s.link} target="_blank" rel="noreferrer">
                      {s.txHash}
                    </a>
                  ) : (
                    s.txHash
                  )}
                </div>
              )}
            </span>
          </li>
        ))}
      </ol>
      {job.refusal && (
        <div className="refusal">
          <div className="small muted">Refusal, verbatim:</div>
          <pre>{job.refusal}</pre>
        </div>
      )}
      {job.error && <p className="bad small">{job.error}</p>}
      {job.resumable && onResume && (
        <button type="button" onClick={() => onResume(job.id)}>
          Resume mint (same attestation)
        </button>
      )}
      <div className="small muted">
        Source: {job.source === 'evm' ? 'Treasury contract' : 'Squads vault'} · delivered on {job.destinationChain}
      </div>
    </div>
  )
}
