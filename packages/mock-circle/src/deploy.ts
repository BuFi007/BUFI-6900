/*
 * @bufi/mock-circle — recreates Circle's production ERC-6900 v0.7 stack at Circle's canonical addresses on a local
 * anvil chain, then adds the sandbox pieces (SponsorPaymaster, SandboxUSDC, BUFI plugins) and writes
 * `contracts/deployments/local.json`. Every step is idempotent: whatever already has code is skipped.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import { encodeAbiParameters, encodeFunctionData, getAddress, type Abi, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { factoryAbi, sandboxUsdcAbi, sponsorPaymasterAbi } from './abi.ts'
import { artifactPath, ensureForgeArtifacts, loadArtifact, requireArtifact } from './artifacts.ts'
import { anvilSetCode, createClients, hasCode, sendAsImpersonated, type Clients } from './chain.ts'
import { ANVIL_ACCOUNTS, CIRCLE_CANONICAL, consoleLogger, envConfig, SANDBOX_SALT, type Logger } from './config.ts'
import { deployCreate2 } from './create2.ts'
import { formatDeploymentSummary, writeDeployment, type LocalDeployment, type PluginDeployment } from './deployments.ts'
import { getManifestHash } from './manifest.ts'
import { isRpcListening } from './anvil.ts'

type AbiConstructor = Extract<Abi[number], { type: 'constructor' }>

export interface DeployOptions {
  /** anvil JSON-RPC URL (default `ANVIL_RPC_URL` / http://127.0.0.1:8545). */
  rpcUrl?: string
  /** Where local.json goes (default `DEPLOYMENTS_PATH` / contracts/deployments/local.json). */
  deploymentsPath?: string
  deployerKey?: Hex
  bundlerKey?: Hex
  paymasterSignerKey?: Hex
  /** Set false to skip writing local.json. */
  write?: boolean
  log?: Logger
}

const ONE_ETH = 10n ** 18n
const PAYMASTER_STAKE = ONE_ETH
const PAYMASTER_UNSTAKE_DELAY_SECS = 86_400
const PAYMASTER_DEPOSIT = 10n * ONE_ETH
const USDC_MINT = 1_000_000n * 10n ** 6n

export async function deployStack(options: DeployOptions = {}): Promise<LocalDeployment> {
  const cfg = envConfig()
  const rpcUrl = options.rpcUrl ?? cfg.anvilRpcUrl
  const deploymentsPath = options.deploymentsPath ?? cfg.deploymentsPath
  const log = options.log ?? consoleLogger
  const bundler = privateKeyToAccount(options.bundlerKey ?? ANVIL_ACCOUNTS.bundler.key)
  const paymasterSigner = privateKeyToAccount(options.paymasterSignerKey ?? ANVIL_ACCOUNTS.paymasterSigner.key)

  if (!(await isRpcListening(rpcUrl))) {
    throw new Error(`no JSON-RPC node at ${rpcUrl} — start anvil (\`bun run anvil\`) or set ANVIL_RPC_URL`)
  }
  await ensureForgeArtifacts(['EntryPoint', 'SponsorPaymaster', 'ERC1967Proxy', 'SandboxUSDC'], log)
  const clients = await createClients(rpcUrl, options.deployerKey ?? ANVIL_ACCOUNTS.deployer.key)
  log(`anvil ${rpcUrl} chainId=${clients.chain.id} deployer=${clients.account.address}`)

  await ensureCreate2Deployer(clients, log)
  const entryPoint = await deployEntryPoint(clients, log)
  const circle = await deployCircleStack(clients, entryPoint, log)
  const usdc = await deploySandboxUsdc(clients, log)
  const paymaster = await deploySponsorPaymaster(clients, entryPoint, paymasterSigner.address, log)
  const ctorContext: ConstructorContext = {
    entryPoint,
    deployer: clients.account.address,
    bundler: bundler.address,
    weightedPlugin: circle.weighted.address,
    addressBookPlugin: circle.addressBook.address,
    pluginManager: circle.pluginManager,
    factory: circle.factory,
    usdc,
    chainId: BigInt(clients.chain.id),
  }
  const bufiSessionKey = await deployBufiPlugin(clients, 'BufiSessionKeyPlugin', ctorContext, log)
  const bufiEarnModule = await deployBufiPlugin(clients, 'BufiEarnModule', ctorContext, log)
  await allowlistPlugins(
    clients,
    circle.factory,
    [circle.addressBook.address, circle.weighted.address, bufiSessionKey?.address, bufiEarnModule?.address].filter(
      (a): a is Address => Boolean(a),
    ),
    log,
  )

  const deployment: LocalDeployment = {
    chainId: clients.chain.id,
    rpcUrl,
    entryPoint,
    create2Deployer: CIRCLE_CANONICAL.create2Deployer,
    pluginManager: circle.pluginManager,
    upgradableMscaFactory: circle.factory,
    upgradableMscaImpl: circle.impl,
    plugins: {
      weightedWebauthnMultisig: circle.weighted,
      coldStorageAddressBook: circle.addressBook,
      bufiSessionKey,
      bufiEarnModule,
    },
    paymaster,
    tokens: { usdc },
    accounts: {
      deployer: clients.account.address,
      bundler: bundler.address,
      factoryOwner: CIRCLE_CANONICAL.factoryOwner,
    },
  }
  if (options.write !== false) {
    await writeDeployment(deploymentsPath, deployment)
    log(`wrote ${deploymentsPath}`)
  }
  return deployment
}

async function ensureCreate2Deployer(clients: Clients, log: Logger): Promise<void> {
  if (await hasCode(clients.publicClient, CIRCLE_CANONICAL.create2Deployer)) return
  await anvilSetCode(clients.rpcUrl, CIRCLE_CANONICAL.create2Deployer, CIRCLE_CANONICAL.create2DeployerRuntime)
  log(`CREATE2 deployer: installed at ${CIRCLE_CANONICAL.create2Deployer} via anvil_setCode`)
}

/**
 * EntryPoint v0.7 from the pinned eth-infinitism release, placed at the canonical address. Our forge profile
 * (0.8.24 / via-ir) does not reproduce the canonical CREATE2 bytecode, so it is deployed normally — its constructor
 * creates the immutable SenderCreator — and the runtime code is copied over with anvil_setCode.
 */
async function deployEntryPoint(clients: Clients, log: Logger): Promise<Address> {
  const canonical = CIRCLE_CANONICAL.entryPoint
  if (await hasCode(clients.publicClient, canonical)) {
    log(`EntryPoint v0.7: already at ${canonical}`)
    return canonical
  }
  const artifact = await requireArtifact('forge', 'EntryPoint')
  const hash = await clients.walletClient.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object })
  const receipt = await clients.publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error(`EntryPoint deployment reverted (${hash})`)
  const code = await clients.publicClient.getCode({ address: receipt.contractAddress })
  if (!code || code === '0x') throw new Error('EntryPoint deployed with empty runtime code')
  await anvilSetCode(clients.rpcUrl, canonical, code)
  log(`EntryPoint v0.7: deployed at ${receipt.contractAddress}, runtime copied to ${canonical}`)
  return canonical
}

interface CircleStack {
  pluginManager: Address
  factory: Address
  impl: Address
  weighted: PluginDeployment
  addressBook: PluginDeployment
}

/** Circle's four contracts from Circle's shipped creation bytecode, salts and constructor args. */
async function deployCircleStack(clients: Clients, entryPoint: Address, log: Logger): Promise<CircleStack> {
  const pluginManagerArtifact = await requireArtifact('circle', 'PluginManager')
  const factoryArtifact = await requireArtifact('circle', 'UpgradableMSCAFactory')
  const addressBookArtifact = await requireArtifact('circle', 'ColdStorageAddressBookPlugin')
  const weightedArtifact = await requireArtifact('circle', 'WeightedWebauthnMultisigPlugin')

  const pluginManager = await deployCreate2(
    clients,
    {
      label: 'PluginManager',
      salt: CIRCLE_CANONICAL.salts.pluginManager,
      creationCode: pluginManagerArtifact.bytecode.object,
      expected: CIRCLE_CANONICAL.pluginManager,
    },
    log,
  )
  const factory = await deployCreate2(
    clients,
    {
      label: 'UpgradableMSCAFactory',
      salt: CIRCLE_CANONICAL.salts.upgradableMscaFactory,
      creationCode: factoryArtifact.bytecode.object,
      constructorArgs: encodeAbiParameters(
        [{ type: 'address' }, { type: 'address' }, { type: 'address' }],
        [CIRCLE_CANONICAL.factoryOwner, entryPoint, pluginManager.address],
      ),
      expected: CIRCLE_CANONICAL.upgradableMscaFactory,
    },
    log,
  )
  const addressBook = await deployCreate2(
    clients,
    {
      label: 'ColdStorageAddressBookPlugin',
      salt: CIRCLE_CANONICAL.salts.coldStorageAddressBookPlugin,
      creationCode: addressBookArtifact.bytecode.object,
      expected: CIRCLE_CANONICAL.coldStorageAddressBookPlugin,
    },
    log,
  )
  const weighted = await deployCreate2(
    clients,
    {
      label: 'WeightedWebauthnMultisigPlugin',
      salt: CIRCLE_CANONICAL.salts.weightedWebauthnMultisigPlugin,
      creationCode: weightedArtifact.bytecode.object,
      constructorArgs: encodeAbiParameters([{ type: 'address' }], [entryPoint]),
      expected: CIRCLE_CANONICAL.weightedWebauthnMultisigPlugin,
    },
    log,
  )

  const impl = await clients.publicClient.readContract({
    address: factory.address,
    abi: factoryAbi,
    functionName: 'ACCOUNT_IMPLEMENTATION',
  })
  if (getAddress(impl) !== getAddress(CIRCLE_CANONICAL.upgradableMscaImpl)) {
    throw new Error(`UpgradableMSCA implementation is ${impl}, expected ${CIRCLE_CANONICAL.upgradableMscaImpl}`)
  }
  log(`UpgradableMSCA (impl): ${impl}`)

  const weightedHash = await getManifestHash(clients.publicClient, weighted.address)
  const addressBookHash = await getManifestHash(clients.publicClient, addressBook.address)
  if (weightedHash !== CIRCLE_CANONICAL.manifestHashes.weightedWebauthnMultisig) {
    throw new Error(`WeightedWebauthnMultisigPlugin manifest hash ${weightedHash} ≠ ${CIRCLE_CANONICAL.manifestHashes.weightedWebauthnMultisig}`)
  }
  if (addressBookHash !== CIRCLE_CANONICAL.manifestHashes.coldStorageAddressBook) {
    throw new Error(`ColdStorageAddressBookPlugin manifest hash ${addressBookHash} ≠ ${CIRCLE_CANONICAL.manifestHashes.coldStorageAddressBook}`)
  }
  log(`manifest hashes: weighted ${weightedHash}, addressBook ${addressBookHash}`)

  return {
    pluginManager: pluginManager.address,
    factory: factory.address,
    impl: getAddress(impl),
    weighted: { address: weighted.address, manifestHash: weightedHash },
    addressBook: { address: addressBook.address, manifestHash: addressBookHash },
  }
}

async function deploySandboxUsdc(clients: Clients, log: Logger): Promise<Address> {
  const artifact = await requireArtifact('forge', 'SandboxUSDC')
  const { address } = await deployCreate2(clients, { label: 'SandboxUSDC', salt: SANDBOX_SALT, creationCode: artifact.bytecode.object }, log)
  const balance = await clients.publicClient.readContract({
    address,
    abi: sandboxUsdcAbi,
    functionName: 'balanceOf',
    args: [clients.account.address],
  })
  if (balance === 0n) {
    const hash = await clients.walletClient.writeContract({
      address,
      abi: sandboxUsdcAbi,
      functionName: 'mint',
      args: [clients.account.address, USDC_MINT],
    })
    await clients.publicClient.waitForTransactionReceipt({ hash })
    log(`SandboxUSDC: minted 1,000,000 USDC to ${clients.account.address}`)
  }
  return address
}

/**
 * Circle's SponsorPaymaster is UUPS (`_disableInitializers()` in the constructor), so it is deployed as
 * implementation + ERC1967Proxy with `initialize(owner = deployer, [verifyingSigner])` as the proxy init call.
 * Both use the sandbox CREATE2 salt so the proxy address is stable across anvil restarts.
 */
async function deploySponsorPaymaster(
  clients: Clients,
  entryPoint: Address,
  signer: Address,
  log: Logger,
): Promise<{ address: Address; signer: Address }> {
  const implArtifact = await requireArtifact('forge', 'SponsorPaymaster')
  const proxyArtifact = await requireArtifact('forge', 'ERC1967Proxy')
  const impl = await deployCreate2(
    clients,
    {
      label: 'SponsorPaymaster (impl)',
      salt: SANDBOX_SALT,
      creationCode: implArtifact.bytecode.object,
      constructorArgs: encodeAbiParameters([{ type: 'address' }], [entryPoint]),
    },
    log,
  )
  const initData = encodeFunctionData({
    abi: sponsorPaymasterAbi,
    functionName: 'initialize',
    args: [clients.account.address, [signer]],
  })
  const proxy = await deployCreate2(
    clients,
    {
      label: 'SponsorPaymaster (ERC1967Proxy)',
      salt: SANDBOX_SALT,
      creationCode: proxyArtifact.bytecode.object,
      constructorArgs: encodeAbiParameters([{ type: 'address' }, { type: 'bytes' }], [impl.address, initData]),
    },
    log,
  )
  const address = proxy.address
  const read = <T>(fn: () => Promise<T>) => fn()

  const signers = await read(() =>
    clients.publicClient.readContract({ address, abi: sponsorPaymasterAbi, functionName: 'getAllSigners' }),
  )
  if (!signers.some((s) => s.toLowerCase() === signer.toLowerCase())) {
    const hash = await clients.walletClient.writeContract({
      address,
      abi: sponsorPaymasterAbi,
      functionName: 'addVerifyingSigners',
      args: [[signer]],
    })
    await clients.publicClient.waitForTransactionReceipt({ hash })
    log(`SponsorPaymaster: added verifying signer ${signer}`)
  }

  const info = await clients.publicClient.readContract({ address, abi: sponsorPaymasterAbi, functionName: 'getDepositInfo' })
  if (info.stake === 0n) {
    const hash = await clients.walletClient.writeContract({
      address,
      abi: sponsorPaymasterAbi,
      functionName: 'addStake',
      args: [PAYMASTER_UNSTAKE_DELAY_SECS],
      value: PAYMASTER_STAKE,
    })
    await clients.publicClient.waitForTransactionReceipt({ hash })
    log(`SponsorPaymaster: staked 1 ETH (unstake delay ${PAYMASTER_UNSTAKE_DELAY_SECS}s)`)
  }
  if (info.deposit < PAYMASTER_DEPOSIT) {
    const hash = await clients.walletClient.writeContract({
      address,
      abi: sponsorPaymasterAbi,
      functionName: 'deposit',
      value: PAYMASTER_DEPOSIT - info.deposit,
    })
    await clients.publicClient.waitForTransactionReceipt({ hash })
    log(`SponsorPaymaster: deposited ${Number(PAYMASTER_DEPOSIT - info.deposit) / 1e18} ETH into the EntryPoint`)
  }
  return { address, signer }
}

interface ConstructorContext {
  entryPoint: Address
  deployer: Address
  bundler: Address
  weightedPlugin: Address
  addressBookPlugin: Address
  pluginManager: Address
  factory: Address
  usdc: Address
  chainId: bigint
}

/** Maps constructor input names of BUFI plugins to sandbox values (owner / relayer = deployer, EntryPoint = canonical …). */
function resolveConstructorArgs(name: string, abi: Abi, ctx: ConstructorContext): Hex {
  const ctor = abi.find((item): item is AbiConstructor => item.type === 'constructor')
  if (!ctor || ctor.inputs.length === 0) return '0x'
  const byName: Record<string, unknown> = {
    entrypoint: ctx.entryPoint,
    entrypointaddr: ctx.entryPoint,
    entrypointaddress: ctx.entryPoint,
    newentrypoint: ctx.entryPoint,
    owner: ctx.deployer,
    initialowner: ctx.deployer,
    newowner: ctx.deployer,
    admin: ctx.deployer,
    authorizedrelayer: ctx.deployer,
    relayer: ctx.deployer,
    executor: ctx.deployer,
    bundler: ctx.bundler,
    weightedplugin: ctx.weightedPlugin,
    weightedmultisigplugin: ctx.weightedPlugin,
    weightedwebauthnmultisigplugin: ctx.weightedPlugin,
    multisigplugin: ctx.weightedPlugin,
    ownerplugin: ctx.weightedPlugin,
    ownershipplugin: ctx.weightedPlugin,
    addressbook: ctx.addressBookPlugin,
    addressbookplugin: ctx.addressBookPlugin,
    coldstorageaddressbookplugin: ctx.addressBookPlugin,
    pluginmanager: ctx.pluginManager,
    factory: ctx.factory,
    mscafactory: ctx.factory,
    usdc: ctx.usdc,
    token: ctx.usdc,
    stablecoin: ctx.usdc,
    chainid: ctx.chainId,
  }
  const values = ctor.inputs.map((input) => {
    const key = (input.name ?? '').replace(/^_+/, '').toLowerCase()
    const value = byName[key]
    if (value === undefined) {
      const signature = ctor.inputs.map((i) => `${i.type} ${i.name ?? ''}`.trim()).join(', ')
      throw new Error(
        `${name}: cannot resolve constructor argument "${input.name ?? '?'}" (${input.type}) — constructor(${signature}). ` +
          'Add it to resolveConstructorArgs in packages/mock-circle/src/deploy.ts',
      )
    }
    return value
  })
  return encodeAbiParameters(ctor.inputs, values)
}

/** BUFI plugins are written in parallel: deploy when the artifact exists, otherwise record `null`. */
async function deployBufiPlugin(clients: Clients, name: string, ctx: ConstructorContext, log: Logger): Promise<PluginDeployment | null> {
  const artifact = await loadArtifact('forge', name)
  if (!artifact) {
    log(`${name}: not built yet (${artifactPath('forge', name)} missing) — skipping`)
    return null
  }
  const constructorArgs = resolveConstructorArgs(name, artifact.abi, ctx)
  const { address } = await deployCreate2(
    clients,
    { label: name, salt: SANDBOX_SALT, creationCode: artifact.bytecode.object, constructorArgs },
    log,
  )
  const manifestHash = await getManifestHash(clients.publicClient, address)
  log(`${name}: manifest ${manifestHash}`)
  return { address, manifestHash }
}

/** Step 105 of Circle's runbook, as Circle's factory owner (impersonated): allowlist plugins for init-time install. */
async function allowlistPlugins(clients: Clients, factory: Address, plugins: Address[], log: Logger): Promise<void> {
  const missing: Address[] = []
  for (const plugin of plugins) {
    const allowed = await clients.publicClient.readContract({ address: factory, abi: factoryAbi, functionName: 'isPluginAllowed', args: [plugin] })
    if (!allowed) missing.push(plugin)
  }
  if (missing.length === 0) {
    log(`factory allowlist: ${plugins.length} plugin(s) already allowed`)
    return
  }
  const data = encodeFunctionData({
    abi: factoryAbi,
    functionName: 'setPlugins',
    args: [missing, missing.map(() => true)],
  })
  await sendAsImpersonated(clients, CIRCLE_CANONICAL.factoryOwner, { to: factory, data })
  log(`factory allowlist: ${CIRCLE_CANONICAL.factoryOwner} (impersonated) allowed ${missing.join(', ')}`)
}

if (import.meta.main) {
  const cfg = envConfig()
  const deployment = await deployStack({ rpcUrl: cfg.anvilRpcUrl, deploymentsPath: cfg.deploymentsPath })
  console.log(`\nBUFI-6900 sandbox stack\n${formatDeploymentSummary(deployment)}\n\n  wrote ${cfg.deploymentsPath}\n`)
}
