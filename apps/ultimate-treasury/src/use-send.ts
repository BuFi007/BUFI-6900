// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState } from 'react'

import type { Job, SendRequest } from '../shared/types'
import { pollJob, resumeMint, startSend } from './api'

/** Start a send and poll its job until it settles. */
export function useSend(onSettled: () => void) {
  const [job, setJob] = useState<Job | null>(null)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [])

  const follow = useCallback(
    async (start: () => Promise<Job>) => {
      setError(null)
      try {
        let j = await start()
        setJob(j)
        while (j.status === 'running') {
          await new Promise((r) => {
            timer.current = setTimeout(r, 1500)
          })
          j = await pollJob(j.id)
          setJob(j)
        }
        onSettled()
      } catch (err) {
        setError((err as Error).message)
      }
    },
    [onSettled],
  )
  const submit = useCallback((req: SendRequest) => follow(() => startSend(req)), [follow])
  const resume = useCallback((id: string) => follow(() => resumeMint(id)), [follow])
  return { job, error, submit, resume, busy: job?.status === 'running' }
}
