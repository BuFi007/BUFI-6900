/*
 * Copyright (c) 2026 BUFI. Licensed under the Apache License, Version 2.0.
 *
 * Small presentational helpers shared by the panels (plain CSS, no UI library — like Circle's example).
 */
import * as React from 'react'

import { type UserOpOutcome, formatError } from './sandbox'

export interface OpState {
  pending?: string
  outcome?: UserOpOutcome
  note?: string
  error?: string
}

/**
 * Tracks one panel's last operation: what is running, the last user operation outcome, and the last RPC error.
 * `run` never throws — errors land in `state.error` so every panel shows the RPC error text.
 */
export function useOp(onDone?: () => void) {
  const [state, setState] = React.useState<OpState>({})
  const run = React.useCallback(
    async (label: string, fn: () => Promise<UserOpOutcome | string | void>) => {
      setState((s) => ({ ...s, pending: label, error: undefined }))
      try {
        const result = await fn()
        if (typeof result === 'string') setState({ note: result })
        else if (result) setState({ outcome: result, note: `${label}: ${result.success ? 'executed' : 'included but REVERTED on-chain (gas paid, no state change)'}` })
        else setState({ note: `${label}: done` })
        onDone?.()
      } catch (error) {
        setState({ error: formatError(error) })
        onDone?.()
      }
    },
    [onDone],
  )
  return { state, run, busy: state.pending !== undefined }
}

export function Panel(props: { title: string; badge?: React.ReactNode; children: React.ReactNode; id?: string }) {
  return (
    <section className="panel" id={props.id}>
      <h2>
        {props.title} {props.badge}
      </h2>
      {props.children}
    </section>
  )
}

export const Tag = (props: { kind: 'dev' | 'stub' | 'ok' | 'off' | 'info'; children: React.ReactNode }) => (
  <span className={`tag ${props.kind}`}>{props.children}</span>
)

export const Mono = (props: { children: React.ReactNode; title?: string }) => (
  <code className="mono" title={props.title}>
    {props.children}
  </code>
)

export function OpStatus({ state }: { state: OpState }) {
  return (
    <div className="op" aria-live="polite">
      {state.pending && <p className="pending">⏳ {state.pending}…</p>}
      {state.outcome && (
        <p>
          User Operation Hash: <Mono>{state.outcome.hash}</Mono>
          <br />
          receipt.success: <b className={state.outcome.success ? 'good' : 'bad'}>{String(state.outcome.success)}</b>
          {state.outcome.reason && <> · reason <Mono>{state.outcome.reason}</Mono></>}
          <br />
          Transaction Hash: <Mono>{state.outcome.txHash}</Mono>
        </p>
      )}
      {state.note && <p className="note">{state.note}</p>}
      {state.error && (
        <p className="error">
          RPC error: <span>{state.error}</span>
        </p>
      )}
    </div>
  )
}

export function Field(props: { label: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span>{props.label}</span>
      {props.children}
    </label>
  )
}
