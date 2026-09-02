/*
 * Copyright (c) 2026, Circle Internet Group, Inc. All rights reserved.
 * Modifications Copyright (c) 2026 BUFI. Licensed under the Apache License, Version 2.0.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Circle's `Example` component (examples/circle-smart-account/index.tsx) pointed at the sandbox. The passkey
// Register / Login flow is upstream's; BUFI adds an EOA-owner dev mode (for browsers without an authenticator), a
// paymaster toggle, and the plugin panels rendered under the account.
import * as React from 'react'
import type { Hex, LocalAccount } from 'viem'
import {
  type P256Credential,
  type SmartAccount,
  type WebAuthnAccount,
  toWebAuthnAccount,
} from 'viem/account-abstraction'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

import { WebAuthnMode, toCircleSmartAccount, toWebAuthnCredential } from '@bufi/modular-wallets-core'

import { AddressBookPanel } from './panels/address-book'
import { AgentSpendPanel } from './panels/agent-spend'
import { AgentPanel } from './panels/agent'
import { EarnPanel } from './panels/earn'
import { InstalledPluginsPanel } from './panels/installed-plugins'
import { OwnerPanel } from './panels/owner'
import {
  MOCK_URL,
  type OpOptions,
  PASSKEY_VERIFICATION_GAS_LIMIT,
  RPC_URL,
  chain,
  client,
  deployment,
  formatError,
  passkeyTransport,
} from './sandbox'
import { useAccountState } from './state'
import { KEYS, useStoredString } from './storage'
import { Mono, Tag } from './ui'

export type OwnerMode = 'passkey' | 'eoa'

export function Example() {
  const [modeRaw, setMode] = useStoredString(KEYS.ownerMode)
  const mode: OwnerMode = modeRaw === 'eoa' ? 'eoa' : 'passkey'
  const [credentialJson, setCredentialJson] = useStoredString(KEYS.credential)
  const [username, setUsername] = useStoredString(KEYS.username)
  const [eoaKey, setEoaKey] = useStoredString(KEYS.ownerEoaKey)
  const [agentKey, setAgentKey] = useStoredString(KEYS.agentKey)
  const [sponsorRaw, setSponsorRaw] = useStoredString(KEYS.sponsor)
  const sponsor = sponsorRaw !== 'off'

  const [account, setAccount] = React.useState<SmartAccount>()
  const [accountError, setAccountError] = React.useState<string>()
  const [authError, setAuthError] = React.useState<string>()
  const [refreshKey, setRefreshKey] = React.useState(0)
  const refresh = React.useCallback(() => setRefreshKey((k) => k + 1), [])
  const state = useAccountState(account?.address, refreshKey)

  const owner = React.useMemo<LocalAccount | WebAuthnAccount | undefined>(() => {
    if (mode === 'eoa') return eoaKey ? privateKeyToAccount(eoaKey as Hex) : undefined
    if (!credentialJson) return undefined
    return toWebAuthnAccount({ credential: JSON.parse(credentialJson) as P256Credential }) as WebAuthnAccount
  }, [mode, eoaKey, credentialJson])
  const agent = React.useMemo(() => (agentKey ? privateKeyToAccount(agentKey as Hex) : undefined), [agentKey])
  // Owner-side ops: sponsor flag + the passkey verificationGasLimit workaround (see OpOptions in sandbox.ts).
  const ops = React.useMemo<OpOptions>(
    () => ({ sponsor, verificationGasLimit: owner?.type === 'webAuthn' ? PASSKEY_VERIFICATION_GAS_LIMIT : undefined }),
    [sponsor, owner],
  )

  React.useEffect(() => {
    setAccount(undefined)
    setAccountError(undefined)
    if (!owner) return
    let cancelled = false
    // Create a circle smart account (the address is resolved through circle_getAddress on the mock)
    toCircleSmartAccount({ client, owner, name: username ?? undefined, deployment })
      .then((created) => {
        if (!cancelled) setAccount(created)
      })
      .catch((error) => {
        if (!cancelled) setAccountError(formatError(error))
      })
    return () => {
      cancelled = true
    }
  }, [owner, username])

  const register = async () => {
    setAuthError(undefined)
    try {
      const name = (document.getElementById('username') as HTMLInputElement).value
      const credential = await toWebAuthnCredential({
        transport: passkeyTransport,
        mode: WebAuthnMode.Register,
        username: name,
      })
      setCredentialJson(JSON.stringify(credential))
      setUsername(name)
    } catch (error) {
      setAuthError(formatError(error))
    }
  }

  const login = async () => {
    setAuthError(undefined)
    try {
      const credential = await toWebAuthnCredential({ transport: passkeyTransport, mode: WebAuthnMode.Login })
      setCredentialJson(JSON.stringify(credential))
    } catch (error) {
      setAuthError(formatError(error))
    }
  }

  const forgetOwner = () => {
    setCredentialJson(null)
    setUsername(null)
    setEoaKey(null)
  }

  const banner = (
    <div className="banner" id="sandbox">
      <b>Sandbox</b> chainId <Mono>{chain.id}</Mono> · Modular Wallets API mock <Mono>{MOCK_URL}</Mono> · anvil{' '}
      <Mono>{RPC_URL}</Mono>
      <br />
      factory <Mono>{deployment.upgradableMscaFactory}</Mono> · session key plugin{' '}
      <Mono>{deployment.bufiSessionKey?.address ?? '— not deployed'}</Mono> · earn module{' '}
      <Mono>{deployment.bufiEarnModule?.address ?? '— not deployed'}</Mono>
      <br />
      <label className="inline">
        <input
          type="checkbox"
          name="sponsor"
          checked={sponsor}
          onChange={(event) => setSponsorRaw(event.target.checked ? 'on' : 'off')}
        />{' '}
        sponsor gas with the sandbox paymaster (<Mono>paymaster: true</Mono> → <Mono>pm_getPaymasterData</Mono>);
        unchecked = the account pays from its own ETH
      </label>
    </div>
  )

  if (!owner)
    return (
      <>
        {banner}
        <section className="panel" id="owner-login">
          <h2>Owner</h2>
          {mode === 'passkey' ? (
            <>
              <p className="muted">
                Register or log in with a passkey, exactly like Circle's example.{' '}
                <Tag kind="stub">rp_* verification stubbed</Tag> the mock returns real WebAuthn options (rpId{' '}
                <Mono>localhost</Mono>) and verifies nothing; the P-256 owner signature is still checked on-chain by
                the WeightedWebauthnMultisigPlugin on every user operation.
              </p>
              <input id="username" name="username" placeholder="Username" defaultValue={username ?? ''} />
              <br />
              <button onClick={register}>Register</button>
              <button onClick={login}>Login</button>
              <p className="muted">
                No authenticator (headless browser, CI)?{' '}
                <button onClick={() => setMode('eoa')}>
                  Use an EOA owner instead <Tag kind="dev">dev</Tag>
                </button>
              </p>
            </>
          ) : (
            <>
              <p className="muted">
                <Tag kind="dev">dev</Tag> A random private key kept in this browser's localStorage is the 1-of-1
                weighted owner (the same path the headless e2e uses). Nothing about the plugins changes; only the
                owner signature scheme does.
              </p>
              <button className="primary" onClick={() => setEoaKey(generatePrivateKey())}>
                Generate owner key
              </button>
              <button onClick={() => setMode('passkey')}>Back to passkeys</button>
            </>
          )}
          {authError && (
            <p className="error">
              RPC error: <span>{authError}</span>
            </p>
          )}
        </section>
      </>
    )

  if (!account)
    return (
      <>
        {banner}
        {accountError ? (
          <section className="panel">
            <p className="error">
              RPC error: <span>{accountError}</span>
            </p>
            <p className="muted">
              Is the sandbox up? <Mono>bun run mock:circle</Mono> at the repo root.
            </p>
            <button onClick={forgetOwner}>Forget owner</button>
          </section>
        ) : (
          <p>Loading...</p>
        )}
      </>
    )

  return (
    <>
      {banner}
      <OwnerPanel
        account={account}
        owner={owner}
        ownerMode={mode}
        username={username}
        state={state}
        ops={ops}
        onChanged={refresh}
        onForgetOwner={forgetOwner}
      />
      <InstalledPluginsPanel state={state} />
      <div className="grid">
        <AddressBookPanel account={account} state={state} ops={ops} onChanged={refresh} />
        <AgentPanel
          account={account}
          state={state}
          ops={ops}
          onChanged={refresh}
          agent={agent}
          onGenerateAgent={() => setAgentKey(generatePrivateKey())}
        />
        <AgentSpendPanel account={account} state={state} sponsor={sponsor} onChanged={refresh} agent={agent} />
        {deployment.bufiEarnModule && (
          <EarnPanel account={account} state={state} ops={ops} onChanged={refresh} />
        )}
      </div>
    </>
  )
}
