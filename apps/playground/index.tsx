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

// Entry point of Circle's examples/circle-smart-account, kept at the package root like upstream. The `Example`
// component moved to src/app.tsx so the BUFI panels can live next to it.
import * as React from 'react'
import * as ReactDOM from 'react-dom/client'

import { Example } from './src/app'
import './src/styles.css'

// BUFI: two chains, one spec. `#solana` opens the Squads view; it is lazy-loaded so the EVM page never pulls in
// web3.js / the Squads SDK.
const SolanaView = React.lazy(() => import('./src/solana/solana-view').then((m) => ({ default: m.SolanaView })))

function Root() {
  const [hash, setHash] = React.useState(() => window.location.hash)
  React.useEffect(() => {
    const onHash = () => setHash(window.location.hash)
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  const solana = hash === '#solana'
  return (
    <>
      <nav className="chains" aria-label="Chain">
        <a href="#evm" aria-current={solana ? undefined : 'page'}>
          EVM · Circle MSCA
        </a>
        <a href="#solana" aria-current={solana ? 'page' : undefined}>
          Solana · Squads
        </a>
      </nav>
      {solana ? (
        <React.Suspense fallback={<p>Loading the Solana view…</p>}>
          <SolanaView />
        </React.Suspense>
      ) : (
        <Example />
      )}
    </>
  )
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(<Root />)
