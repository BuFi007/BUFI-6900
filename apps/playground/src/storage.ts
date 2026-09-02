/*
 * Copyright (c) 2026 BUFI. Licensed under the Apache License, Version 2.0.
 *
 * localStorage-backed state. `credential` / `username` are the keys Circle's example uses, so a passkey registered
 * against the upstream example on the same origin keeps working here; the BUFI keys are namespaced.
 */
import * as React from 'react'

export const KEYS = {
  credential: 'credential',
  username: 'username',
  ownerMode: 'bufi6900.owner.mode',
  ownerEoaKey: 'bufi6900.owner.eoaKey',
  agentKey: 'bufi6900.agent.key',
  sponsor: 'bufi6900.sponsor',
  earnVault: 'bufi6900.earn.vault',
} as const

export function useStoredString(key: string): [string | null, (next: string | null) => void] {
  const [value, setValue] = React.useState<string | null>(() => localStorage.getItem(key))
  const set = React.useCallback(
    (next: string | null) => {
      if (next === null) localStorage.removeItem(key)
      else localStorage.setItem(key, next)
      setValue(next)
    },
    [key],
  )
  return [value, set]
}
