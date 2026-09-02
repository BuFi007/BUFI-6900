/*
 * Copyright (c) 2026 BUFI. Licensed under the Apache License, Version 2.0.
 */
import type { AccountState } from '../state'
import { labelPlugin } from '../sandbox'
import { Mono, Panel, Tag } from '../ui'

export function InstalledPluginsPanel({ state }: { state: AccountState | undefined }) {
  return (
    <Panel title="Installed plugins" badge={<Tag kind="info">IAccountLoupe.getInstalledPlugins</Tag>} id="installed">
      {!state && <p className="muted">reading…</p>}
      {state?.error && <p className="error">RPC error: {state.error}</p>}
      {state && !state.deployed && (
        <p className="muted">Account not deployed yet — its first user operation deploys it (the mock supplies the factory initCode).</p>
      )}
      {state?.deployed && (
        <ul className="list">
          {state.installed.map((plugin) => (
            <li key={plugin}>
              <Mono>{plugin}</Mono> <span className="muted">{labelPlugin(plugin)}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}
