// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react'

import { POSITIONS, type PositionId } from '../shared/config'
import type { TreasuryPolicy } from '../shared/types'
import { JobStatus } from './job-status'
import { useSend } from './use-send'

export function RefusalDemo({ policy, signer, onSettled }: { policy: TreasuryPolicy; signer: boolean; onSettled: () => void }) {
  const [source, setSource] = useState<PositionId>('evm')
  const { job, error, submit, resume, busy } = useSend(onSettled)
  const allowed = policy.allowlist[0]?.address ?? ''
  const run = (recipient: string, signers: string[]) =>
    submit({ asset: 'USDC', amount: '0.25', recipient, signers, source, expectRefusal: true })

  return (
    <section className="panel">
      <h2>Refusal demo</h2>
      <p className="small muted">
        Each request is signed for real and submitted. The policy must refuse it; the signer will not run a request that would
        succeed.
      </p>
      <div className="row">
        <label className="field">
          <span>From</span>
          <select value={source} onChange={(e) => setSource(e.target.value as PositionId)}>
            {(Object.keys(POSITIONS) as PositionId[]).map((id) => (
              <option key={id} value={id}>
                {POSITIONS[id].label}
              </option>
            ))}
          </select>
        </label>
        <button type="button" disabled={!signer || busy} onClick={() => run(policy.outsider.address, ['A', 'B'])}>
          A+B to {policy.outsider.id} (not on allowlist)
        </button>
        <button type="button" disabled={!signer || busy || !allowed} onClick={() => run(allowed, ['B', 'C'])}>
          B+C only (weight 2 of {policy.thresholdWeight})
        </button>
      </div>
      {error && <p className="bad">{error}</p>}
      {job && <JobStatus job={job} onResume={resume} />}
    </section>
  )
}
