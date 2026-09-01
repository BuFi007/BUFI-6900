/*
 * Circle's stack lands on Circle's addresses, with Circle's manifest hashes, on a fresh anvil.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { getAddress, parseEther } from 'viem'

import { factoryAbi, sandboxUsdcAbi, sponsorPaymasterAbi } from '../src/abi.ts'
import { ANVIL_ACCOUNTS, CIRCLE_CANONICAL, silentLogger } from '../src/config.ts'
import { deployStack } from '../src/deploy.ts'
import { getManifestHash } from '../src/manifest.ts'
import { bootSandbox, type Sandbox } from './helpers.ts'

describe('deployStack', () => {
  let sandbox: Sandbox

  beforeAll(async () => {
    sandbox = await bootSandbox()
  })
  afterAll(async () => {
    await sandbox?.stop()
  })

  test('lands Circle contracts on the canonical production addresses', async () => {
    const d = sandbox.deployment
    expect(d.chainId).toBe(31337)
    expect(d.entryPoint).toBe(CIRCLE_CANONICAL.entryPoint)
    expect(d.create2Deployer).toBe(CIRCLE_CANONICAL.create2Deployer)
    expect(d.pluginManager).toBe(CIRCLE_CANONICAL.pluginManager)
    expect(d.upgradableMscaFactory).toBe(CIRCLE_CANONICAL.upgradableMscaFactory)
    expect(d.upgradableMscaImpl).toBe(CIRCLE_CANONICAL.upgradableMscaImpl)
    expect(d.plugins.weightedWebauthnMultisig.address).toBe(CIRCLE_CANONICAL.weightedWebauthnMultisigPlugin)
    expect(d.plugins.coldStorageAddressBook.address).toBe(CIRCLE_CANONICAL.coldStorageAddressBookPlugin)
    for (const address of [
      d.entryPoint,
      d.create2Deployer,
      d.pluginManager,
      d.upgradableMscaFactory,
      d.upgradableMscaImpl,
      d.plugins.weightedWebauthnMultisig.address,
      d.plugins.coldStorageAddressBook.address,
      d.tokens.usdc,
      d.paymaster!.address,
    ]) {
      const code = await sandbox.publicClient.getCode({ address })
      expect(code && code !== '0x', `code at ${address}`).toBe(true)
    }
    const impl = await sandbox.publicClient.readContract({
      address: d.upgradableMscaFactory,
      abi: factoryAbi,
      functionName: 'ACCOUNT_IMPLEMENTATION',
    })
    expect(getAddress(impl)).toBe(CIRCLE_CANONICAL.upgradableMscaImpl)
    const entryPoint = await sandbox.publicClient.readContract({
      address: d.upgradableMscaFactory,
      abi: factoryAbi,
      functionName: 'ENTRY_POINT',
    })
    expect(getAddress(entryPoint)).toBe(CIRCLE_CANONICAL.entryPoint)
  })

  test('manifest hashes equal the ones Circle publishes (and the SDK pins)', async () => {
    const d = sandbox.deployment
    expect(d.plugins.weightedWebauthnMultisig.manifestHash).toBe(CIRCLE_CANONICAL.manifestHashes.weightedWebauthnMultisig)
    expect(d.plugins.coldStorageAddressBook.manifestHash).toBe(CIRCLE_CANONICAL.manifestHashes.coldStorageAddressBook)
    // recomputed from the chain, not read back from the file
    expect(await getManifestHash(sandbox.publicClient, d.plugins.weightedWebauthnMultisig.address)).toBe(
      CIRCLE_CANONICAL.manifestHashes.weightedWebauthnMultisig,
    )
    expect(await getManifestHash(sandbox.publicClient, d.plugins.coldStorageAddressBook.address)).toBe(
      CIRCLE_CANONICAL.manifestHashes.coldStorageAddressBook,
    )
  })

  test('factory is owned by Circle and allowlists every deployed plugin', async () => {
    const d = sandbox.deployment
    const owner = await sandbox.publicClient.readContract({ address: d.upgradableMscaFactory, abi: factoryAbi, functionName: 'owner' })
    expect(getAddress(owner)).toBe(CIRCLE_CANONICAL.factoryOwner)
    const plugins = [
      d.plugins.coldStorageAddressBook.address,
      d.plugins.weightedWebauthnMultisig.address,
      d.plugins.bufiSessionKey?.address,
      d.plugins.bufiEarnModule?.address,
    ].filter((a): a is `0x${string}` => Boolean(a))
    for (const plugin of plugins) {
      const allowed = await sandbox.publicClient.readContract({
        address: d.upgradableMscaFactory,
        abi: factoryAbi,
        functionName: 'isPluginAllowed',
        args: [plugin],
      })
      expect(allowed, `${plugin} allowed`).toBe(true)
    }
  })

  test('SponsorPaymaster proxy is initialised, staked and funded', async () => {
    const pm = sandbox.deployment.paymaster!
    expect(pm.signer).toBe(ANVIL_ACCOUNTS.paymasterSigner.address)
    const signers = await sandbox.publicClient.readContract({ address: pm.address, abi: sponsorPaymasterAbi, functionName: 'getAllSigners' })
    expect(signers.map(getAddress)).toContain(pm.signer)
    const owner = await sandbox.publicClient.readContract({ address: pm.address, abi: sponsorPaymasterAbi, functionName: 'owner' })
    expect(getAddress(owner)).toBe(ANVIL_ACCOUNTS.deployer.address)
    const entryPoint = await sandbox.publicClient.readContract({ address: pm.address, abi: sponsorPaymasterAbi, functionName: 'ENTRY_POINT' })
    expect(getAddress(entryPoint)).toBe(CIRCLE_CANONICAL.entryPoint)
    const info = await sandbox.publicClient.readContract({ address: pm.address, abi: sponsorPaymasterAbi, functionName: 'getDepositInfo' })
    expect(info.staked).toBe(true)
    expect(info.stake).toBe(parseEther('1'))
    expect(info.unstakeDelaySec).toBe(86_400)
    expect(info.deposit).toBe(parseEther('10'))
  })

  test('SandboxUSDC minted 1,000,000 USDC to the deployer', async () => {
    const balance = await sandbox.publicClient.readContract({
      address: sandbox.deployment.tokens.usdc,
      abi: sandboxUsdcAbi,
      functionName: 'balanceOf',
      args: [ANVIL_ACCOUNTS.deployer.address],
    })
    expect(balance).toBe(1_000_000n * 10n ** 6n)
    const decimals = await sandbox.publicClient.readContract({ address: sandbox.deployment.tokens.usdc, abi: sandboxUsdcAbi, functionName: 'decimals' })
    expect(decimals).toBe(6)
  })

  test('local.json has the shape toStackDeployment parses', async () => {
    const json = (await Bun.file(sandbox.deploymentsPath).json()) as Record<string, unknown>
    expect(Object.keys(json).sort()).toEqual(
      [
        'accounts',
        'chainId',
        'create2Deployer',
        'entryPoint',
        'paymaster',
        'pluginManager',
        'plugins',
        'rpcUrl',
        'tokens',
        'upgradableMscaFactory',
        'upgradableMscaImpl',
      ].sort(),
    )
    expect(Object.keys(json.plugins as object).sort()).toEqual(['bufiEarnModule', 'bufiSessionKey', 'coldStorageAddressBook', 'weightedWebauthnMultisig'])
    expect(json.accounts).toEqual({
      deployer: ANVIL_ACCOUNTS.deployer.address,
      bundler: ANVIL_ACCOUNTS.bundler.address,
      factoryOwner: CIRCLE_CANONICAL.factoryOwner,
    })
    expect(json.rpcUrl).toBe(sandbox.rpcUrl)
  })

  test('re-running is a no-op that reproduces the same deployment', async () => {
    const before = await sandbox.publicClient.getBlockNumber()
    const again = await deployStack({ rpcUrl: sandbox.rpcUrl, deploymentsPath: sandbox.deploymentsPath, write: false, log: silentLogger })
    expect(again).toEqual(sandbox.deployment)
    // idempotent = no transactions were sent
    expect(await sandbox.publicClient.getBlockNumber()).toBe(before)
  })
})
