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

import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// BUFI: the Solana view uses @sqds/smart-account built from source at a pinned commit
// (`bun run --cwd packages/weighted-treasury squads:sdk`). The aliases point web3.js / spl-token / bn.js / buffer
// at the SDK's own node_modules so there is exactly one copy of each (PublicKey instanceof checks).
const squadsSdk = fileURLToPath(new URL('../../packages/weighted-treasury/.squads-sdk/sdk/smart-account/', import.meta.url))
const sdkModules = `${squadsSdk}node_modules/`

// https://vitejs.dev/config/
// BUFI: the deployment file (contracts/deployments/local.json) and the forge artifacts (contracts/out) live
// outside this package; Vite already allows the whole bun workspace, so plain imports / import.meta.glob work
// in both `vite` and `vite build`.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@sqds/smart-account': `${squadsSdk}lib/index.mjs`,
      '@solana/web3.js': `${sdkModules}@solana/web3.js`,
      '@solana/spl-token': `${sdkModules}@solana/spl-token`,
      'bn.js': `${sdkModules}bn.js`,
      buffer: `${sdkModules}buffer`,
    },
  },
  define: { 'process.env.NODE_DEBUG': 'false' },
  optimizeDeps: { include: ['@solana/web3.js', '@solana/spl-token', 'bn.js', 'buffer'] },
  server: {
    host: 'localhost',
    port: 5173,
  },
})
