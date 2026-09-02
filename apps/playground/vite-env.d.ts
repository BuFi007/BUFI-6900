/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Modular Wallets API URL. Defaults to the local mock, http://127.0.0.1:8788/v1/rpc/w3s/buidl. */
  readonly VITE_CLIENT_URL?: string
  /** Client key. The mock accepts any non-empty key. */
  readonly VITE_CLIENT_KEY?: string
  /** The chain RPC used for direct reads and the dev-only anvil buttons. Defaults to http://127.0.0.1:8545. */
  readonly VITE_ANVIL_RPC_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
