/*
 * Copyright (c) 2026 BUFI. Licensed under the Apache License, Version 2.0.
 *
 * BufiEarnModule: the module OWNER (anvil #0 in the sandbox) registers vault configs on the module; the account
 * adopts a config set by its hash at install (`encodeInstallEarnModule`, a raw-calldata management user operation)
 * and can later `changeConfigHash`; an authorized RELAYER (anvil #4) sweeps with a plain `autoEarn` transaction —
 * the deposit path is `executeFromPluginExternal`, so the vault does not need to be on the address book.
 */
import * as React from 'react'
import { type Address, formatUnits, isAddress } from 'viem'
import type { SmartAccount } from 'viem/account-abstraction'

import { computeEarnConfigHash, encodeChangeConfigHash, encodeInstallEarnModule, getEarnConfigs } from '@bufi/modular-wallets-core'

import {
  ANVIL,
  type OpOptions,
  EARN_ABI,
  USDC,
  USDC_ABI,
  USDC_DECIMALS,
  bundlerClient,
  chain,
  deployerWallet,
  deployment,
  formatError,
  isInstalled,
  loadMockVaultArtifact,
  relayerWallet,
  rpc,
  sendUserOp,
  short,
  usdc,
} from '../sandbox'
import type { AccountState } from '../state'
import { KEYS, useStoredString } from '../storage'
import { Field, Mono, OpStatus, Panel, Tag, useOp } from '../ui'

const parseConfigHash = (text: string): bigint => {
  const trimmed = text.trim()
  if (trimmed === '') throw new Error('enter the config hash (0x… or decimal), or deploy a vault with the dev button')
  return BigInt(trimmed)
}
const hex = (value: bigint): `0x${string}` => `0x${value.toString(16).padStart(64, '0')}`

export function EarnPanel(props: { account: SmartAccount; state: AccountState | undefined; ops: OpOptions; onChanged: () => void }) {
  const { account, state, ops, onChanged } = props
  const earn = deployment.bufiEarnModule?.address
  const active = state !== undefined && isInstalled(state.installed, earn)
  const { state: op, run, busy } = useOp(onChanged)
  const [configHash, setConfigHash] = React.useState('')
  const [vaultRaw, setVaultRaw] = useStoredString(KEYS.earnVault)
  const vault = vaultRaw && isAddress(vaultRaw) ? vaultRaw : undefined
  const [sweepAmount, setSweepAmount] = React.useState('1000')
  const [configs, setConfigs] = React.useState<readonly { token: Address; vault: Address }[]>()
  const [shares, setShares] = React.useState<bigint>()
  const [readError, setReadError] = React.useState<string>()

  React.useEffect(() => {
    if (!earn) return
    let cancelled = false
    ;(async () => {
      const list = active ? await getEarnConfigs(rpc, { plugin: earn, account: account.address }) : undefined
      const shareVault = list?.[0]?.vault ?? vault
      const balance = shareVault
        ? await rpc.readContract({ address: shareVault, abi: USDC_ABI, functionName: 'balanceOf', args: [account.address] })
        : undefined
      if (!cancelled) {
        setConfigs(list)
        setShares(balance)
        setReadError(undefined)
      }
    })().catch((error) => {
      if (!cancelled) setReadError(formatError(error))
    })
    return () => {
      cancelled = true
    }
  }, [earn, active, account.address, vault, state])

  const deployVault = () =>
    run('dev: deploy MockVault, setConfig on the module, authorize the relayer (anvil #0)', async () => {
      if (!earn) throw new Error('no earn module')
      const artifact = await loadMockVaultArtifact()
      const deployTx = await deployerWallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args: [usdc] })
      const deployed = (await rpc.waitForTransactionReceipt({ hash: deployTx })).contractAddress
      if (!deployed) throw new Error('vault deployment produced no contract address')
      const list = [{ chainId: BigInt(chain.id), token: usdc, vault: deployed }]
      const hash = computeEarnConfigHash(list)
      await rpc.waitForTransactionReceipt({
        hash: await deployerWallet.writeContract({ address: earn, abi: EARN_ABI, functionName: 'setConfig', args: [list] }),
      })
      const relayerOk = await rpc.readContract({ address: earn, abi: EARN_ABI, functionName: 'authorizedRelayers', args: [ANVIL.relayer.address] })
      if (!relayerOk)
        await rpc.waitForTransactionReceipt({
          hash: await deployerWallet.writeContract({ address: earn, abi: EARN_ABI, functionName: 'addAuthorizedRelayer', args: [ANVIL.relayer.address] }),
        })
      setVaultRaw(deployed)
      setConfigHash(hex(hash))
      return `vault ${deployed} registered on the module — config hash ${short(hex(hash))}; relayer ${short(ANVIL.relayer.address)} authorized`
    })

  const install = () =>
    run('installPlugin(BufiEarnModule)', () => {
      const call = encodeInstallEarnModule({ account: account.address, configHash: parseConfigHash(configHash), deployment })
      return sendUserOp(bundlerClient, { account, callData: call.data, ...ops })
    })
  const change = () =>
    run('changeConfigHash', () => {
      const call = encodeChangeConfigHash({ account: account.address, newConfigHash: parseConfigHash(configHash) })
      return sendUserOp(bundlerClient, { account, callData: call.data, ...ops })
    })
  const sweep = () =>
    run(`dev: relayer autoEarn(USDC, ${sweepAmount}) — plain tx from anvil #4`, async () => {
      const tx = await relayerWallet.writeContract({ address: account.address, abi: EARN_ABI, functionName: 'autoEarn', args: [usdc, USDC(sweepAmount)] })
      const receipt = await rpc.waitForTransactionReceipt({ hash: tx })
      return `autoEarn tx ${tx} → ${receipt.status}`
    })

  return (
    <Panel title="Earn" id="earn" badge={active ? <Tag kind="ok">BufiEarnModule installed</Tag> : <Tag kind="off">not installed</Tag>}>
      <p className="muted">
        <Mono>BufiEarnModule</Mono> at <Mono>{earn}</Mono>. The account adopts a config set by hash; the module owner
        must have registered that exact set (<Mono>setConfig</Mono>) or the install reverts.
      </p>
      <p>
        <button onClick={deployVault} disabled={busy} id="earn-deploy-vault">
          Deploy MockVault + setConfig + authorize relayer <Tag kind="dev">dev · anvil #0</Tag>
        </button>
        {vault && (
          <span className="muted">
            {' '}
            vault <Mono>{vault}</Mono>
          </span>
        )}
      </p>
      <div className="row">
        <Field label="Config hash (uint256, 0x… or decimal)">
          <input value={configHash} onChange={(e) => setConfigHash(e.target.value)} name="config-hash" placeholder="0x…" />
        </Field>
        {!active ? (
          <button className="primary" onClick={install} disabled={busy || !state?.deployed} id="earn-install">
            Install earn module
          </button>
        ) : (
          <button onClick={change} disabled={busy} id="earn-change">
            changeConfigHash
          </button>
        )}
      </div>
      {active && (
        <>
          <h3 className="muted">Adopted configs (getAllConfigs)</h3>
          {readError && <p className="error">RPC error: {readError}</p>}
          {configs && configs.length === 0 && <p className="muted">none</p>}
          {configs && configs.length > 0 && (
            <ul className="list">
              {configs.map((c) => (
                <li key={`${c.token}-${c.vault}`}>
                  token <Mono>{short(c.token)}</Mono> → vault <Mono>{c.vault}</Mono>
                </li>
              ))}
            </ul>
          )}
          <div className="row">
            <Field label="Sweep amount (USDC)">
              <input value={sweepAmount} onChange={(e) => setSweepAmount(e.target.value)} name="sweep-amount" />
            </Field>
            <button onClick={sweep} disabled={busy} id="earn-sweep">
              Relayer autoEarn <Tag kind="dev">dev · anvil #4 {short(ANVIL.relayer.address)}</Tag>
            </button>
          </div>
        </>
      )}
      {shares !== undefined && (
        <p>
          vault shares held by the account: <b id="earn-shares">{formatUnits(shares, USDC_DECIMALS)}</b>
        </p>
      )}
      <OpStatus state={op} />
    </Panel>
  )
}
