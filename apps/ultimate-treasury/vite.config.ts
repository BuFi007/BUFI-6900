// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

import { devSigner } from './server/plugin'

const APP_DIR = fileURLToPath(new URL('.', import.meta.url))
const REPO_NODE_MODULES = fileURLToPath(new URL('../../node_modules', import.meta.url))

// devSigner() is `apply: 'serve'`: present under `vite` (dev), absent from `vite build` and `vite preview`.
export default defineConfig({
  plugins: [react(), devSigner()],
  server: {
    host: '127.0.0.1',
    port: Number(process.env.PORT ?? 5180),
    strictPort: false,
    // The dev signer must not be reachable cross-origin.
    cors: false,
    fs: {
      // Vite's default allow-list is the WORKSPACE root (this repo), which contains .sandbox/ with every owner key
      // and FROST share: /@fs/<repo>/.sandbox/ultimate-treasury/keys.json used to answer 200. Serve only this app
      // and the hoisted dependencies, and deny key material outright (deny wins over allow).
      strict: true,
      allow: [APP_DIR, REPO_NODE_MODULES],
      deny: ['.env', '.env.*', '*.{crt,pem,key}', '**/.sandbox/**', '**/.deployer-wallet.json', '**/keys.json', '**/share-*.json'],
    },
  },
  build: { sourcemap: false },
})
