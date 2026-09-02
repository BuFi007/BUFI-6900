/*
 * Copyright (c) 2026 BUFI. Licensed under the Apache License, Version 2.0.
 *
 * The on-chain state every panel keys off: deployed?, AccountLoupe's installed plugins (the only source of truth for
 * installed state), the registered session keys, and the balances. Re-read whenever `refreshKey` changes.
 */
import * as React from 'react'
import type { Address } from 'viem'

import { getInstalledPlugins, getSessionKeys } from '@bufi/modular-wallets-core'

import { USDC_ABI, deployment, formatError, isInstalled, rpc, usdc } from './sandbox'

export interface AccountState {
  deployed: boolean
  installed: readonly Address[]
  sessionKeys: readonly Address[]
  usdcBalance: bigint
  ethBalance: bigint
  error?: string
}

const EMPTY: AccountState = { deployed: false, installed: [], sessionKeys: [], usdcBalance: 0n, ethBalance: 0n }

export function useAccountState(address: Address | undefined, refreshKey: number): AccountState | undefined {
  const [state, setState] = React.useState<AccountState>()

  React.useEffect(() => {
    if (!address) return
    let cancelled = false
    ;(async () => {
      const code = await rpc.getCode({ address })
      const deployed = code !== undefined && code !== '0x'
      const [usdcBalance, ethBalance] = await Promise.all([
        rpc.readContract({ address: usdc, abi: USDC_ABI, functionName: 'balanceOf', args: [address] }),
        rpc.getBalance({ address }),
      ])
      const installed = deployed ? await getInstalledPlugins(rpc, { account: address }) : []
      const sessionKeyPlugin = deployment.bufiSessionKey?.address
      const sessionKeys =
        deployed && sessionKeyPlugin && isInstalled(installed, sessionKeyPlugin)
          ? await getSessionKeys(rpc, { plugin: sessionKeyPlugin, account: address })
          : []
      if (!cancelled) setState({ deployed, installed, sessionKeys, usdcBalance, ethBalance })
    })().catch((error) => {
      if (!cancelled) setState((s) => ({ ...(s ?? EMPTY), error: formatError(error) }))
    })
    return () => {
      cancelled = true
    }
  }, [address, refreshKey])

  return state
}
