/*
 * ERC-7677 sponsorship through Circle's SponsorPaymaster: an account with zero ETH deploys itself and moves USDC
 * because the mock signs `pm_getPaymasterData` with the paymaster's verifying key.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { concatHex, encodeFunctionData, getAddress, pad, recoverMessageAddress, toHex } from 'viem'
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { createBundlerClient, createPaymasterClient, getUserOperationHash, type UserOperation } from 'viem/account-abstraction'

import { entryPointAbi, sandboxUsdcAbi, sponsorPaymasterAbi, upgradableMscaAbi } from '../src/abi.ts'
import { DEFAULT_GAS_LIMITS, SPONSOR_NAME } from '../src/config.ts'
import type { GetUserOperationGasPriceResponse, ModularWallet } from '../src/rpc/types.ts'
import { packUserOperation } from '../src/userop.ts'
import { bootSandbox, getAddressForEoa, mockTransport, rpc, signUserOpAsWeightedEoa, splitInitCode, type Sandbox } from './helpers.ts'
import { SDK_STUB_SIGNATURE } from './sdk-constants.ts'

const USDC = (n: number) => BigInt(n) * 10n ** 6n

describe('mock Modular Wallets API — SponsorPaymaster (ERC-7677)', () => {
  let sandbox: Sandbox
  let owner: PrivateKeyAccount
  let wallet: ModularWallet

  beforeAll(async () => {
    sandbox = await bootSandbox()
    owner = privateKeyToAccount(generatePrivateKey())
    wallet = await getAddressForEoa(sandbox, owner, 'sponsored wallet')
  })
  afterAll(async () => {
    await sandbox?.stop()
  })

  test('sponsors a userOp for an account holding no ETH at all', async () => {
    const { deployment, deployer } = sandbox
    const paymasterAddress = deployment.paymaster!.address
    const usdc = deployment.tokens.usdc
    const recipient = privateKeyToAccount(generatePrivateKey()).address

    const mintHash = await deployer.walletClient.writeContract({ address: usdc, abi: sandboxUsdcAbi, functionName: 'mint', args: [wallet.address, USDC(25)] })
    await sandbox.publicClient.waitForTransactionReceipt({ hash: mintHash })
    expect(await sandbox.publicClient.getBalance({ address: wallet.address })).toBe(0n)

    const transport = mockTransport(sandbox)
    const bundler = createBundlerClient({ chain: sandbox.chain, transport })
    const paymaster = createPaymasterClient({ transport })

    const { factory, factoryData } = splitInitCode(wallet.scaConfiguration.initCode)
    const callData = encodeFunctionData({
      abi: upgradableMscaAbi,
      functionName: 'execute',
      args: [usdc, 0n, encodeFunctionData({ abi: sandboxUsdcAbi, functionName: 'transfer', args: [recipient, USDC(25)] })],
    })
    const nonce = await sandbox.publicClient.readContract({ address: deployment.entryPoint, abi: entryPointAbi, functionName: 'getNonce', args: [wallet.address, 0n] })
    const price = await rpc<GetUserOperationGasPriceResponse>(sandbox, 'circle_getUserOperationGasPrice')
    const fees = { maxFeePerGas: BigInt(price.high.maxFeePerGas), maxPriorityFeePerGas: BigInt(price.high.maxPriorityFeePerGas) }
    const base = { sender: wallet.address, nonce, factory, factoryData, callData, ...fees }

    // 1. stub data → gas estimation
    const stub = await paymaster.getPaymasterStubData({ chainId: 31337, entryPointAddress: deployment.entryPoint, ...base })
    expect(getAddress(stub.paymaster!)).toBe(getAddress(paymasterAddress))
    expect(stub.isFinal).toBe(false)
    expect(stub.sponsor).toEqual({ name: SPONSOR_NAME })
    expect(stub.paymasterVerificationGasLimit).toBe(DEFAULT_GAS_LIMITS.paymasterVerificationGasLimit)
    expect(stub.paymasterPostOpGasLimit).toBe(DEFAULT_GAS_LIMITS.paymasterPostOpGasLimit)
    expect((stub.paymasterData!.length - 2) / 2).toBe(64 + 65)

    const gas = await bundler.estimateUserOperationGas({
      entryPointAddress: deployment.entryPoint,
      ...base,
      paymaster: stub.paymaster,
      paymasterData: stub.paymasterData,
      paymasterVerificationGasLimit: stub.paymasterVerificationGasLimit,
      paymasterPostOpGasLimit: stub.paymasterPostOpGasLimit,
      signature: SDK_STUB_SIGNATURE,
    })
    expect(gas.paymasterVerificationGasLimit).toBe(DEFAULT_GAS_LIMITS.paymasterVerificationGasLimit)
    expect(gas.paymasterPostOpGasLimit).toBe(DEFAULT_GAS_LIMITS.paymasterPostOpGasLimit)

    // 2. real data, signed by the verifying signer
    const withGas = {
      ...base,
      callGasLimit: gas.callGasLimit,
      verificationGasLimit: gas.verificationGasLimit,
      preVerificationGas: gas.preVerificationGas,
    }
    const sponsored = await paymaster.getPaymasterData({ chainId: 31337, entryPointAddress: deployment.entryPoint, ...withGas })
    expect((sponsored as unknown as { isFinal?: boolean }).isFinal).toBe(true)
    expect(getAddress(sponsored.paymaster!)).toBe(getAddress(paymasterAddress))

    const unsigned: Omit<UserOperation<'0.7'>, 'signature'> = {
      ...withGas,
      paymaster: sponsored.paymaster!,
      paymasterData: sponsored.paymasterData!,
      paymasterVerificationGasLimit: sponsored.paymasterVerificationGasLimit!,
      paymasterPostOpGasLimit: sponsored.paymasterPostOpGasLimit!,
    }

    // 2b. the paymasterAndData the contract will parse recovers to the deployment's signer
    const rpcOp = packUserOperation({
      sender: unsigned.sender,
      nonce: toHex(nonce),
      factory,
      factoryData,
      callData,
      callGasLimit: toHex(unsigned.callGasLimit),
      verificationGasLimit: toHex(unsigned.verificationGasLimit),
      preVerificationGas: toHex(unsigned.preVerificationGas),
      maxFeePerGas: toHex(fees.maxFeePerGas),
      maxPriorityFeePerGas: toHex(fees.maxPriorityFeePerGas),
      paymaster: unsigned.paymaster,
      paymasterData: unsigned.paymasterData,
      paymasterVerificationGasLimit: toHex(unsigned.paymasterVerificationGasLimit!),
      paymasterPostOpGasLimit: toHex(unsigned.paymasterPostOpGasLimit!),
      signature: '0x',
    })
    expect(rpcOp.paymasterAndData.toLowerCase()).toBe(
      concatHex([
        paymasterAddress,
        pad(toHex(unsigned.paymasterVerificationGasLimit!), { size: 16 }),
        pad(toHex(unsigned.paymasterPostOpGasLimit!), { size: 16 }),
        sponsored.paymasterData!,
      ]).toLowerCase(),
    )
    const [pmVerGas, pmPostOpGas, validUntil, validAfter, signature] = await sandbox.publicClient.readContract({
      address: paymasterAddress,
      abi: sponsorPaymasterAbi,
      functionName: 'parsePaymasterAndData',
      args: [rpcOp.paymasterAndData],
    })
    expect(pmVerGas).toBe(unsigned.paymasterVerificationGasLimit!)
    expect(pmPostOpGas).toBe(unsigned.paymasterPostOpGasLimit!)
    expect(validAfter).toBe(0)
    const latest = await sandbox.publicClient.getBlock()
    expect(validUntil).toBeGreaterThan(Number(latest.timestamp))
    const hash = await sandbox.publicClient.readContract({
      address: paymasterAddress,
      abi: sponsorPaymasterAbi,
      functionName: 'getHash',
      args: [rpcOp, pmVerGas, pmPostOpGas, validUntil, validAfter],
    })
    expect(await recoverMessageAddress({ message: { raw: hash }, signature })).toBe(deployment.paymaster!.signer)

    // 3. sign as the account owner, submit, verify on-chain effects
    const userOpHash = getUserOperationHash({ chainId: 31337, entryPointAddress: deployment.entryPoint, entryPointVersion: '0.7', userOperation: { ...unsigned, signature: '0x' } })
    const depositBefore = await sandbox.publicClient.readContract({ address: paymasterAddress, abi: sponsorPaymasterAbi, functionName: 'getDeposit' })
    const opHash = await bundler.sendUserOperation({
      entryPointAddress: deployment.entryPoint,
      ...unsigned,
      signature: await signUserOpAsWeightedEoa(owner, userOpHash),
    })
    expect(opHash).toBe(userOpHash)
    const receipt = await bundler.waitForUserOperationReceipt({ hash: opHash, timeout: 30_000 })
    expect(receipt.success).toBe(true)
    expect(getAddress(receipt.paymaster!)).toBe(getAddress(paymasterAddress))
    expect(receipt.actualGasCost > 0n).toBe(true)

    const depositAfter = await sandbox.publicClient.readContract({ address: paymasterAddress, abi: sponsorPaymasterAbi, functionName: 'getDeposit' })
    expect(depositBefore - depositAfter).toBe(receipt.actualGasCost)
    expect(await sandbox.publicClient.getBalance({ address: wallet.address })).toBe(0n)
    expect(await sandbox.publicClient.readContract({ address: usdc, abi: sandboxUsdcAbi, functionName: 'balanceOf', args: [recipient] })).toBe(USDC(25))
    expect(await sandbox.publicClient.getCode({ address: wallet.address })).not.toBeUndefined()
  })

  test('a tampered paymaster signature is rejected as AA34', async () => {
    const { deployment } = sandbox
    const paymasterAddress = deployment.paymaster!.address
    const nonce = await sandbox.publicClient.readContract({ address: deployment.entryPoint, abi: entryPointAbi, functionName: 'getNonce', args: [wallet.address, 0n] })
    const price = await rpc<GetUserOperationGasPriceResponse>(sandbox, 'circle_getUserOperationGasPrice')
    const base = {
      sender: wallet.address,
      nonce,
      callData: encodeFunctionData({ abi: upgradableMscaAbi, functionName: 'execute', args: [wallet.address, 0n, '0x'] }),
      callGasLimit: DEFAULT_GAS_LIMITS.callGasLimit,
      verificationGasLimit: DEFAULT_GAS_LIMITS.verificationGasLimit,
      preVerificationGas: DEFAULT_GAS_LIMITS.preVerificationGas,
      maxFeePerGas: BigInt(price.medium.maxFeePerGas),
      maxPriorityFeePerGas: BigInt(price.medium.maxPriorityFeePerGas),
    }
    const paymaster = createPaymasterClient({ transport: mockTransport(sandbox) })
    const sponsored = await paymaster.getPaymasterData({ chainId: 31337, entryPointAddress: deployment.entryPoint, ...base })
    // flip the last byte of the signature
    const tampered = `${sponsored.paymasterData!.slice(0, -2)}${sponsored.paymasterData!.endsWith('1b') ? '1c' : '1b'}` as `0x${string}`
    const unsigned: Omit<UserOperation<'0.7'>, 'signature'> = {
      ...base,
      paymaster: paymasterAddress,
      paymasterData: tampered,
      paymasterVerificationGasLimit: sponsored.paymasterVerificationGasLimit!,
      paymasterPostOpGasLimit: sponsored.paymasterPostOpGasLimit!,
    }
    const userOpHash = getUserOperationHash({ chainId: 31337, entryPointAddress: deployment.entryPoint, entryPointVersion: '0.7', userOperation: { ...unsigned, signature: '0x' } })
    const bundler = createBundlerClient({ chain: sandbox.chain, transport: mockTransport(sandbox) })
    await expect(
      bundler.sendUserOperation({ entryPointAddress: deployment.entryPoint, ...unsigned, signature: await signUserOpAsWeightedEoa(owner, userOpHash) }),
    ).rejects.toThrow(/AA34 signature error/)
  })
})
