/*
 * A fresh EOA owner gets a 1-of-1 weighted MSCA through `circle_getAddress`, then deploys it with a userOp that
 * carries `initCode` and moves SandboxUSDC — driven through viem's bundler client against the mock endpoint.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { encodeFunctionData, getAddress, parseEther, toHex } from 'viem'
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { createBundlerClient, getUserOperationHash, type UserOperation } from 'viem/account-abstraction'

import { entryPointAbi, sandboxUsdcAbi, upgradableMscaAbi } from '../src/abi.ts'
import { anvilSetBalance } from '../src/chain.ts'
import { CIRCLE_CANONICAL, DEFAULT_GAS_LIMITS, SCA_CORE } from '../src/config.ts'
import type { GetUserOperationGasPriceResponse, ModularWallet } from '../src/rpc/types.ts'
import { packUserOperation } from '../src/userop.ts'
import {
  bootSandbox,
  computeAddressLikeSdk,
  getAddressForEoa,
  mockTransport,
  MockRpcError,
  rpc,
  signUserOpAsWeightedEoa,
  splitInitCode,
  type Sandbox,
} from './helpers.ts'
import { SDK_STUB_SIGNATURE } from './sdk-constants.ts'

const USDC = (n: number) => BigInt(n) * 10n ** 6n

describe('mock Modular Wallets API — bundler', () => {
  let sandbox: Sandbox
  let owner: PrivateKeyAccount
  let wallet: ModularWallet

  beforeAll(async () => {
    sandbox = await bootSandbox()
    owner = privateKeyToAccount(generatePrivateKey())
    wallet = await getAddressForEoa(sandbox, owner)
  })
  afterAll(async () => {
    await sandbox?.stop()
  })

  test('rejects requests without a Bearer token and unknown methods', async () => {
    await expect(rpc(sandbox, 'eth_chainId', [], { key: null })).rejects.toMatchObject({ error: { code: -32001 } })
    await expect(rpc(sandbox, 'circle_doesNotExist')).rejects.toMatchObject({ error: { code: -32601 } })
    const health = (await (await fetch(`${sandbox.mock.url}/health`)).json()) as { ok: boolean; methods: string[] }
    expect(health.ok).toBe(true)
    expect(health.methods).toContain('circle_getAddress')
  })

  test('echoes the request id and proxies plain eth_* reads to anvil', async () => {
    const response = await fetch(sandbox.mock.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer anything' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'req-42', method: 'eth_chainId', params: [] }),
    })
    expect(await response.json()).toEqual({ jsonrpc: '2.0', id: 'req-42', result: '0x7a69' })
    expect(await rpc(sandbox, 'eth_blockNumber')).toMatch(/^0x[0-9a-f]+$/)
    expect(await rpc(sandbox, 'eth_getCode', [sandbox.deployment.entryPoint, 'latest'])).not.toBe('0x')
  })

  test('circle_getAddress returns a ModularWallet whose address matches the SDK offline derivation', async () => {
    expect(wallet.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(wallet.blockchain).toBe('ANVIL')
    expect(wallet.state).toBe('LIVE')
    expect(wallet.scaCore).toBe(SCA_CORE)
    expect(wallet.scaConfiguration.initialOwnershipConfiguration.ownershipContractAddress).toBe(
      CIRCLE_CANONICAL.weightedWebauthnMultisigPlugin,
    )
    expect(wallet.scaConfiguration.initialOwnershipConfiguration.weightedMultisig).toEqual({
      owners: [{ address: owner.address, weight: 1 }],
      thresholdWeight: 1,
    })
    expect(wallet.scaConfiguration.initCode.toLowerCase().startsWith(CIRCLE_CANONICAL.upgradableMscaFactory.toLowerCase())).toBe(true)
    // SDK `computeAddress(owner)` — CREATE2 over the SDK's own ERC1967Proxy creation code — must agree.
    expect(getAddress(wallet.address)).toBe(computeAddressLikeSdk(sandbox.deployment, owner.address))
    // stable across calls
    const again = await getAddressForEoa(sandbox, owner)
    expect(again.id).toBe(wallet.id)
    expect(again.address).toBe(wallet.address)
    // not deployed yet
    expect(await sandbox.publicClient.getCode({ address: wallet.address })).toBeUndefined()
  })

  test('address mappings: implicit from circle_getAddress, explicit via circle_createAddressMapping', async () => {
    const ownerRef = { type: 'EOAOWNER', identifier: { address: owner.address } }
    const implicit = await rpc<Array<{ walletAddress: string; blockchain: string }>>(sandbox, 'circle_getAddressMapping', [{ owner: ownerRef }])
    expect(implicit.map((m) => getAddress(m.walletAddress))).toEqual([getAddress(wallet.address)])
    const other = privateKeyToAccount(generatePrivateKey())
    const created = await rpc<Array<{ id: string; owner: unknown; walletAddress: string }>>(sandbox, 'circle_createAddressMapping', [
      { walletAddress: wallet.address, owners: [{ type: 'EOAOWNER', identifier: { address: other.address } }] },
    ])
    expect(created).toHaveLength(1)
    expect(created[0]!.owner).toEqual({ type: 'EOAOWNER', identifier: { address: other.address } })
    const fetched = await rpc<Array<{ id: string }>>(sandbox, 'circle_getAddressMapping', [
      { owner: { type: 'EOAOWNER', identifier: { address: other.address } } },
    ])
    expect(fetched[0]!.id).toBe(created[0]!.id)
  })

  test('circle_getUserOperationGasPrice exposes three tiers plus the SDK verification defaults', async () => {
    const price = await rpc<GetUserOperationGasPriceResponse>(sandbox, 'circle_getUserOperationGasPrice')
    for (const tier of [price.low, price.medium, price.high]) {
      expect(BigInt(tier.maxFeePerGas) >= BigInt(tier.maxPriorityFeePerGas)).toBe(true)
    }
    expect(BigInt(price.high.maxPriorityFeePerGas) > BigInt(price.low.maxPriorityFeePerGas)).toBe(true)
    expect(Number(price.deployed)).toBe(Number(DEFAULT_GAS_LIMITS.deployedVerificationGasLimit))
    expect(Number(price.notDeployed)).toBe(Number(DEFAULT_GAS_LIMITS.notDeployedVerificationGasLimit))
  })

  test('deploys the MSCA with initCode and transfers SandboxUSDC through EntryPoint.handleOps', async () => {
    const { deployment, deployer } = sandbox
    const recipient = privateKeyToAccount(generatePrivateKey()).address
    const usdc = deployment.tokens.usdc

    // fund the counterfactual account: 100 USDC to move, 1 ETH for the prefund
    const mintHash = await deployer.walletClient.writeContract({ address: usdc, abi: sandboxUsdcAbi, functionName: 'mint', args: [wallet.address, USDC(100)] })
    await sandbox.publicClient.waitForTransactionReceipt({ hash: mintHash })
    await anvilSetBalance(sandbox.rpcUrl, wallet.address, parseEther('1'))

    const bundler = createBundlerClient({ chain: sandbox.chain, transport: mockTransport(sandbox) })
    expect(await bundler.getSupportedEntryPoints()).toEqual([deployment.entryPoint])
    expect(await bundler.getChainId()).toBe(31337)

    const { factory, factoryData } = splitInitCode(wallet.scaConfiguration.initCode)
    const callData = encodeFunctionData({
      abi: upgradableMscaAbi,
      functionName: 'execute',
      args: [usdc, 0n, encodeFunctionData({ abi: sandboxUsdcAbi, functionName: 'transfer', args: [recipient, USDC(40)] })],
    })
    const nonce = await sandbox.publicClient.readContract({ address: deployment.entryPoint, abi: entryPointAbi, functionName: 'getNonce', args: [wallet.address, 0n] })
    expect(nonce).toBe(0n)
    const price = await rpc<GetUserOperationGasPriceResponse>(sandbox, 'circle_getUserOperationGasPrice')
    const fees = { maxFeePerGas: BigInt(price.medium.maxFeePerGas), maxPriorityFeePerGas: BigInt(price.medium.maxPriorityFeePerGas) }

    const gas = await bundler.estimateUserOperationGas({
      entryPointAddress: deployment.entryPoint,
      sender: wallet.address,
      nonce,
      factory,
      factoryData,
      callData,
      ...fees,
      signature: SDK_STUB_SIGNATURE,
    })
    expect(gas.verificationGasLimit).toBe(DEFAULT_GAS_LIMITS.verificationGasLimit)
    expect(gas.callGasLimit).toBe(DEFAULT_GAS_LIMITS.callGasLimit)
    expect(gas.preVerificationGas).toBe(DEFAULT_GAS_LIMITS.preVerificationGas)
    expect(gas.paymasterVerificationGasLimit).toBeUndefined()

    const unsigned: Omit<UserOperation<'0.7'>, 'signature'> = {
      sender: wallet.address,
      nonce,
      factory,
      factoryData,
      callData,
      callGasLimit: gas.callGasLimit,
      verificationGasLimit: gas.verificationGasLimit,
      preVerificationGas: gas.preVerificationGas,
      ...fees,
    }
    const userOpHash = getUserOperationHash({
      chainId: 31337,
      entryPointAddress: deployment.entryPoint,
      entryPointVersion: '0.7',
      userOperation: { ...unsigned, signature: '0x' },
    })
    // the mock hashes with the deployed EntryPoint; viem's local hash must agree
    const onChainHash = await sandbox.publicClient.readContract({
      address: deployment.entryPoint,
      abi: entryPointAbi,
      functionName: 'getUserOpHash',
      args: [
        packUserOperation({
          sender: wallet.address,
          nonce: toHex(nonce),
          factory,
          factoryData,
          callData,
          callGasLimit: toHex(gas.callGasLimit),
          verificationGasLimit: toHex(gas.verificationGasLimit),
          preVerificationGas: toHex(gas.preVerificationGas),
          maxFeePerGas: toHex(fees.maxFeePerGas),
          maxPriorityFeePerGas: toHex(fees.maxPriorityFeePerGas),
          signature: '0x',
        }),
      ],
    })
    expect(onChainHash).toBe(userOpHash)

    const signature = await signUserOpAsWeightedEoa(owner, userOpHash)
    const hash = await bundler.sendUserOperation({ entryPointAddress: deployment.entryPoint, ...unsigned, signature })
    expect(hash).toBe(userOpHash)

    const receipt = await bundler.waitForUserOperationReceipt({ hash, timeout: 30_000 })
    expect(receipt.success).toBe(true)
    expect(getAddress(receipt.sender)).toBe(getAddress(wallet.address))
    expect(BigInt(receipt.nonce)).toBe(0n) // viem passes the ERC-4337 hex quantity through untouched
    expect(receipt.actualGasUsed > 0n).toBe(true)
    expect(receipt.receipt.status).toBe('success')
    expect(receipt.logs.length).toBeGreaterThan(0)

    // the account exists now, with the weighted plugin installed at init, and the USDC moved
    expect(await sandbox.publicClient.getCode({ address: wallet.address })).not.toBeUndefined()
    const installed = await sandbox.publicClient.readContract({ address: wallet.address, abi: upgradableMscaAbi, functionName: 'getInstalledPlugins' })
    expect(installed.map(getAddress)).toContain(CIRCLE_CANONICAL.weightedWebauthnMultisigPlugin)
    expect(await sandbox.publicClient.readContract({ address: usdc, abi: sandboxUsdcAbi, functionName: 'balanceOf', args: [recipient] })).toBe(USDC(40))
    expect(await sandbox.publicClient.readContract({ address: usdc, abi: sandboxUsdcAbi, functionName: 'balanceOf', args: [wallet.address] })).toBe(USDC(60))

    const byHash = await bundler.getUserOperation({ hash })
    expect(getAddress(byHash.userOperation.sender)).toBe(getAddress(wallet.address))
    expect(byHash.transactionHash).toBe(receipt.receipt.transactionHash)
    expect(byHash.entryPoint).toBe(deployment.entryPoint)

    // a second submission of the same op is refused
    await expect(bundler.sendUserOperation({ entryPointAddress: deployment.entryPoint, ...unsigned, signature })).rejects.toThrow(/already submitted/)
  })

  test('a userOp signed by a stranger is rejected with the decoded FailedOp reason (AA24)', async () => {
    const { deployment } = sandbox
    const stranger = privateKeyToAccount(generatePrivateKey())
    const nonce = await sandbox.publicClient.readContract({ address: deployment.entryPoint, abi: entryPointAbi, functionName: 'getNonce', args: [wallet.address, 0n] })
    const price = await rpc<GetUserOperationGasPriceResponse>(sandbox, 'circle_getUserOperationGasPrice')
    const unsigned: Omit<UserOperation<'0.7'>, 'signature'> = {
      sender: wallet.address,
      nonce,
      callData: encodeFunctionData({ abi: upgradableMscaAbi, functionName: 'execute', args: [stranger.address, 0n, '0x'] }),
      callGasLimit: DEFAULT_GAS_LIMITS.callGasLimit,
      verificationGasLimit: DEFAULT_GAS_LIMITS.verificationGasLimit,
      preVerificationGas: DEFAULT_GAS_LIMITS.preVerificationGas,
      maxFeePerGas: BigInt(price.medium.maxFeePerGas),
      maxPriorityFeePerGas: BigInt(price.medium.maxPriorityFeePerGas),
    }
    const userOpHash = getUserOperationHash({ chainId: 31337, entryPointAddress: deployment.entryPoint, entryPointVersion: '0.7', userOperation: { ...unsigned, signature: '0x' } })
    const signature = await signUserOpAsWeightedEoa(stranger, userOpHash)
    const rpcOp = {
      sender: unsigned.sender,
      nonce: toHex(nonce),
      callData: unsigned.callData,
      callGasLimit: toHex(unsigned.callGasLimit),
      verificationGasLimit: toHex(unsigned.verificationGasLimit),
      preVerificationGas: toHex(unsigned.preVerificationGas),
      maxFeePerGas: toHex(unsigned.maxFeePerGas),
      maxPriorityFeePerGas: toHex(unsigned.maxPriorityFeePerGas),
      signature,
    }
    let caught: MockRpcError | undefined
    try {
      await rpc(sandbox, 'eth_sendUserOperation', [rpcOp, deployment.entryPoint])
    } catch (error) {
      caught = error as MockRpcError
    }
    expect(caught).toBeInstanceOf(MockRpcError)
    expect(caught!.error.code).toBe(-32507)
    expect(caught!.error.message).toMatch(/FailedOp\(0, "AA24 signature error"\)/)
    expect(caught!.error.data).toMatchObject({ errorName: 'FailedOp', opIndex: 0, reason: 'AA24 signature error' })
    // nothing was mined for it
    expect(await rpc(sandbox, 'eth_getUserOperationReceipt', [userOpHash])).toBeNull()
  })
})
