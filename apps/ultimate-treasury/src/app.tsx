// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useState } from 'react'

import type { PositionId } from '../shared/config'
import type { TreasuryPolicy } from '../shared/types'
import { loadBalances, loadPolicy, signerCompiledIn, signerStatus } from './api'
import { Holdings } from './holdings'
import { RefusalDemo } from './refusal-demo'
import { SendPanel } from './send-panel'

export function App() {
  const [signer, setSigner] = useState<boolean | null>(signerCompiledIn ? null : false)
  const [policy, setPolicy] = useState<TreasuryPolicy | null>(null)
  const [balances, setBalances] = useState<Record<PositionId, number> | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    loadBalances()
      .then((b) => {
        setBalances(b)
        setError(null)
      })
      .catch((e: Error) => setError(`Balances unavailable: ${e.message}`))
  }, [])

  useEffect(() => {
    signerStatus().then((s) => setSigner(!!s))
    loadPolicy()
      .then(setPolicy)
      .catch((e: Error) => setError(`Policy unavailable: ${e.message}`))
    refresh()
  }, [refresh])

  return (
    <main>
      <header className="row-between">
        <h1>Ultimate Treasury</h1>
        {signer === null ? (
          <span className="tag off">checking signer…</span>
        ) : signer ? (
          <span className="tag dev">dev signer · testnet</span>
        ) : (
          <span className="tag off">connect a signer</span>
        )}
      </header>
      <Holdings balances={balances} error={error} onRefresh={refresh} />
      {policy && (
        <>
          <SendPanel policy={policy} balances={balances} signer={!!signer} onSettled={refresh} />
          <RefusalDemo policy={policy} signer={!!signer} onSettled={refresh} />
        </>
      )}
    </main>
  )
}
