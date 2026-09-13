import { toReplaySafeHash } from '@bu/circle-kit/erc1271-plugin-signature';
import { getTokenAddress } from '@bu/swap/tokens';
import { from, of } from 'rxjs';
import {
  encodeFunctionData,
  erc20Abi,
  type Hex,
  hashMessage,
  keccak256,
  parseAbi,
  parseSignature,
  parseTransaction,
  recoverMessageAddress,
  recoverTransactionAddress,
  recoverTypedDataAddress,
  stringToHex,
  toHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createLedgerEthereumProvider,
  createLedgerSwapSigner,
  signLedgerAuthorizationTarget,
} from './ledger-native.service';
import { formatLedgerSignature } from './ledger-signature';

const hardware = vi.hoisted(() => ({
  getAddress: vi.fn(),
  signMessage: vi.fn(),
  signTypedData: vi.fn(),
  signTransaction: vi.fn(),
  disconnect: vi.fn(),
  scan: vi.fn(),
  transports: vi.fn(),
  connection: 'USB',
  platform: { OS: 'android' },
}));
vi.mock('react-native', () => ({
  Platform: hardware.platform,
  Alert: {
    alert: (_title: string, _message: string, buttons: { text: string; onPress: () => void }[]) =>
      buttons.find(b => b.text === hardware.connection)!.onPress(),
  },
}));
vi.mock('@/constants', () => ({
  getPrimaryBlockchain: () => 'ARC-TESTNET',
  getWebsiteUrl: () => 'http://localhost:3000',
}));
vi.mock('@bu/circle/modular/client', () => ({
  resolveChainConfig: () => ({
    chain: {
      id: 5042002,
      name: 'Arc Testnet',
      testnet: true,
      nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
      rpcUrls: { default: { http: ['https://offline.invalid'] } },
    },
  }),
}));
vi.mock('@ledgerhq/device-transport-kit-react-native-ble', () => ({
  RNBleTransportFactory: 'ble-factory',
  rnBleTransportIdentifier: 'RN_BLE',
}));
vi.mock('@ledgerhq/device-transport-kit-react-native-hid', () => ({
  RNHidTransportFactory: 'hid-factory',
  rnHidTransportIdentifier: 'RN_HID',
}));
vi.mock('@ledgerhq/device-management-kit', () => ({
  DeviceActionStatus: { Completed: 'completed', Error: 'error', Stopped: 'stopped' },
  DeviceManagementKitBuilder: class {
    addTransport(factory: unknown) {
      hardware.transports(factory);
      return this;
    }
    build() {
      return {
        isEnvironmentSupported: () => true,
        listenToAvailableDevices: hardware.scan,
        stopDiscovering: async () => {},
        connect: async () => 'fixture-session',
        disconnect: hardware.disconnect,
      };
    }
  },
}));
vi.mock('@ledgerhq/device-signer-kit-ethereum', () => ({
  SignerEthBuilder: class {
    build() {
      return hardware;
    }
  },
}));

const rpc = vi.hoisted(() => ({
  session: vi.fn(),
  faces: vi.fn(),
  chain: vi.fn(),
  prepare: vi.fn(),
  send: vi.fn(),
  receipt: vi.fn(),
}));
vi.mock('@/config/supabase', () => ({ supabase: { auth: { getSession: rpc.session } } }));
vi.mock('@/services/wallet-faces.service', () => ({ getWalletFaces: rpc.faces }));
vi.mock('viem/actions', async original => ({
  ...(await original<typeof import('viem/actions')>()),
  getChainId: rpc.chain,
  prepareTransactionRequest: rpc.prepare,
  sendRawTransaction: rpc.send,
  waitForTransactionReceipt: rpc.receipt,
}));

const account = privateKeyToAccount(`0x${'1'.padStart(64, '0')}`);
const digest = `0x${'ab'.repeat(32)}` as Hex;
function action(output: Promise<unknown>) {
  return {
    observable: from(output.then(output => ({ status: 'completed', output }))),
    cancel: vi.fn(),
  };
}
async function ledgerSignature(signature: Promise<Hex>) {
  const value = parseSignature(await signature);
  return { ...value, v: Number(value.v) };
}
beforeEach(() => {
  vi.clearAllMocks();
  hardware.connection = 'USB';
  hardware.platform.OS = 'android';
  hardware.scan.mockReturnValue(of([{ rssi: -10 }]));
  hardware.disconnect.mockResolvedValue(undefined);
  hardware.getAddress.mockImplementation(() =>
    action(Promise.resolve({ address: account.address }))
  );
  hardware.signMessage.mockImplementation((_path, message) =>
    action(
      ledgerSignature(
        account.signMessage(
          typeof message === 'string' ? { message } : { message: { raw: message } }
        )
      )
    )
  );
  hardware.signTypedData.mockImplementation((_path, data) =>
    action(ledgerSignature(account.signTypedData(data)))
  );
});

describe('formatLedgerSignature', () => {
  it('normalizes Ledger recovery ids into a canonical 65-byte EVM signature', () => {
    const signature = formatLedgerSignature({
      r: `0x${'11'.repeat(32)}`,
      s: `0x${'22'.repeat(32)}`,
      v: 1,
    });

    expect(signature).toBe(`0x${'11'.repeat(32)}${'22'.repeat(32)}1c`);
    expect(signature).toHaveLength(132);
  });
});

it('signs exact raw userOp bytes and replay-safe EIP-712, verifies recovery, and closes each connection', async () => {
  await expect(
    signLedgerAuthorizationTarget({ signerAddress: account.address, target: { digest } })
  ).resolves.toMatchObject({ signerAddress: account.address, userOpSigType: '0x00' });
  expect(hardware.transports.mock.calls.map(([factory]) => factory)).toEqual([
    'ble-factory',
    'hid-factory',
  ]);
  expect(hardware.signMessage.mock.calls[0]![1]).toBeInstanceOf(Uint8Array);
  expect(hardware.signMessage.mock.calls[0]![1]).toHaveLength(32);
  const replaySafe = {
    kind: 'raw-hash-1271' as const,
    method: 'eoa' as const,
    chainId: 5042002,
    account: `0x${'22'.repeat(20)}` as Hex,
    message: 'BUFI test session',
    purpose: 'hinkal-session' as const,
    digest: '' as Hex,
  };
  replaySafe.digest = toReplaySafeHash({
    address: replaySafe.account,
    chainId: replaySafe.chainId,
    hash: hashMessage(replaySafe.message),
  });
  await expect(
    signLedgerAuthorizationTarget({
      signerAddress: account.address,
      target: { digest: replaySafe.digest },
      replaySafe,
    })
  ).resolves.toMatchObject({ signerAddress: account.address });
  expect(hardware.signMessage).toHaveBeenCalledOnce();
  expect(hardware.signTypedData).toHaveBeenCalledOnce();
  expect(hardware.disconnect).toHaveBeenCalledTimes(2);
});
it('refuses a different Ledger account before signing and closes rejected requests', async () => {
  await expect(
    signLedgerAuthorizationTarget({ signerAddress: `0x${'22'.repeat(20)}`, target: { digest } })
  ).rejects.toThrow('not the registered');
  expect(hardware.signMessage).not.toHaveBeenCalled();
  expect(hardware.disconnect).toHaveBeenCalledOnce();
  hardware.signMessage.mockImplementation(() => action(Promise.reject(new Error('User canceled'))));
  await expect(
    signLedgerAuthorizationTarget({ signerAddress: account.address, target: { digest } })
  ).rejects.toThrow('canceled');
  expect(hardware.disconnect).toHaveBeenCalledTimes(2);
});

it('binds the native login provider to the device account and signs the exact login message', async () => {
  const connection = await createLedgerEthereumProvider();
  const message = 'BUFI login verification fixture, no funds or permissions';
  try {
    await expect(
      connection.provider.request({
        method: 'personal_sign',
        params: [stringToHex(message), `0x${'22'.repeat(20)}`],
      })
    ).rejects.toThrow('did not match');
    expect(hardware.signMessage).not.toHaveBeenCalled();
    const signature = (await connection.provider.request({
      method: 'personal_sign',
      params: [stringToHex(message), account.address],
    })) as Hex;
    expect(await recoverMessageAddress({ message, signature })).toBe(account.address);
    expect(hardware.signMessage.mock.calls[0]![1]).toBe(message);
  } finally {
    await connection.close();
  }
  expect(hardware.disconnect).toHaveBeenCalledOnce();
});

it('uses only the chosen Android transport, supports cancellation, and keeps iOS on Bluetooth', async () => {
  for (const connection of ['USB', 'Bluetooth']) {
    hardware.connection = connection;
    const ledger = await createLedgerEthereumProvider();
    expect(hardware.scan).toHaveBeenLastCalledWith({
      transport: connection === 'USB' ? 'RN_HID' : 'RN_BLE',
    });
    await ledger.close();
  }
  hardware.connection = 'Cancel';
  hardware.scan.mockClear();
  await expect(createLedgerEthereumProvider()).rejects.toThrow('canceled');
  expect(hardware.scan).not.toHaveBeenCalled();
  vi.resetModules();
  hardware.platform.OS = 'ios';
  hardware.transports.mockClear();
  const ios = await (await import('./ledger-native.service')).createLedgerEthereumProvider();
  expect(hardware.transports).toHaveBeenCalledExactlyOnceWith('ble-factory');
  expect(hardware.scan).toHaveBeenLastCalledWith({ transport: undefined });
  await ios.close();
});

type Review = Parameters<typeof createLedgerSwapSigner>[0]['review'];
type Execution = Parameters<typeof createLedgerSwapSigner>[0]['execution'];
const swapTarget = `0x${'44'.repeat(20)}` as Hex;
let review: Review;
let execution: Extract<Execution, { mode: 'unsigned-tx' }>;

function swapTx() {
  return {
    to: execution.tx.kind === 'evm' ? execution.tx.to : swapTarget,
    data: execution.tx.kind === 'evm' ? execution.tx.data : ('0x' as Hex),
    value: 0n,
  };
}
function approvalTx() {
  return { ...execution.approval!, value: BigInt(execution.approval!.value) };
}
function orderExecution(): Extract<Execution, { mode: 'unsigned-order' }> {
  return {
    mode: 'unsigned-order',
    quote: execution.quote,
    quoteId: 'fixture-order',
    order: {
      encodedOrder: '0x1234',
      orderHash: digest,
      deadline: Math.floor(Date.now() / 1000) + 60,
      reactor: swapTarget,
      permitData: {
        domain: { name: 'Reviewed swap fixture', chainId: 5042002, verifyingContract: swapTarget },
        types: {
          Order: [
            { name: 'owner', type: 'address' },
            { name: 'amount', type: 'uint256' },
          ],
        },
        primaryType: 'Order',
        message: { owner: account.address, amount: '1000000' },
      },
    },
  };
}
beforeEach(() => {
  const quote = {
    provider: 'circle-appkit' as const,
    chain: 'Arc_Testnet' as const,
    amountIn: '1',
    amountOut: '1.01',
    amountOutMin: '0.99',
    fees: { providerBps: 0, platformBps: 0, gasless: false },
    expiresAt: Date.now() + 60_000,
    reason: 'offline signing fixture',
  };
  review = {
    draft: {
      face: 'personal',
      walletId: 'ledger-arc',
      tokenIn: 'USDC',
      tokenOut: 'EURC',
      amountIn: '1',
      slippageBps: 50,
    },
    wallet: {
      id: 'ledger-arc',
      circle_wallet_id: '',
      balances: { USDC: '1', EURC: '0' },
      supportedCurrencies: ['USDC', 'EURC'],
      user_id: 'ledger-user',
      blockchain: 'ARC-TESTNET',
      main_type: 'individual',
      wallet_address: account.address,
      custody_model: 'external',
      metadata: { wallet_provider: 'ledger' },
    } as Review['wallet'],
    chain: 'Arc_Testnet',
    quote,
  };
  execution = {
    mode: 'unsigned-tx',
    chainKind: 'evm',
    quote: { ...quote },
    quoteId: 'fixture-swap',
    tx: { kind: 'evm', to: swapTarget, data: '0x1234', value: '0', chainId: 5042002 },
    approval: {
      to: getTokenAddress('Arc_Testnet', 'USDC') as Hex,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [swapTarget, 1000000n],
      }),
      value: '0',
      chainId: 5042002,
    },
  };
  rpc.session.mockImplementation(async () => ({
    data: { session: { user: { id: 'ledger-user' }, access_token: 'fixture' } },
  }));
  rpc.faces.mockImplementation(async () => ({ personal: { wallets: [{ ...review.wallet }] } }));
  rpc.chain.mockResolvedValue(5042002);
  rpc.prepare.mockImplementation(async (_client, transaction) => ({
    ...transaction,
    chainId: 5042002,
    type: 'eip1559',
    nonce: rpc.prepare.mock.calls.length - 1,
    gas: 100000n,
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 1n,
  }));
  rpc.send.mockImplementation(async (_client, { serializedTransaction }) =>
    keccak256(serializedTransaction)
  );
  rpc.receipt.mockImplementation(async (_client, { hash }) => ({
    status: 'success',
    transactionHash: hash,
  }));
  hardware.signTransaction.mockImplementation((_path, bytes: Uint8Array) =>
    action(
      account.signTransaction(parseTransaction(toHex(bytes))).then(serialized => {
        const signed = parseTransaction(serialized);
        return {
          r: signed.r,
          s: signed.s,
          v: signed.v === undefined ? signed.yParity : Number(signed.v % 256n),
        };
      })
    )
  );
});

describe('reviewed testnet Ledger swaps', () => {
  it('rejects mainnet, non-Ledger metadata, ownerless and team wallets before device or RPC use', async () => {
    for (const change of [
      { chain: 'Base' },
      { wallet: { ...review.wallet, metadata: { wallet_provider: 'browser' } } },
      { wallet: { ...review.wallet, user_id: null } },
      { draft: { ...review.draft, face: 'treasury' } },
    ]) {
      await expect(
        createLedgerSwapSigner({ review: { ...review, ...change } as Review, execution })
      ).rejects.toThrow('registered Personal Ledger');
    }
    expect(hardware.scan).not.toHaveBeenCalled();
    expect(rpc.chain).not.toHaveBeenCalled();
  });

  it('accepts only the original approval then swap, recovers the device signatures, and requires successful receipts', async () => {
    const signer = await createLedgerSwapSigner({ review, execution });
    await expect(signer.sendTransaction(swapTx())).rejects.toThrow('next transaction');
    await expect(signer.sendTransaction({ ...approvalTx(), value: 1n })).rejects.toThrow(
      'next transaction'
    );
    expect(hardware.signTransaction).not.toHaveBeenCalled();
    const approval = await signer.sendTransaction(approvalTx());
    expect(rpc.receipt).toHaveBeenCalledWith(expect.anything(), {
      hash: approval,
      timeout: 120_000,
    });
    const hash = await signer.sendTransaction(swapTx());
    const submitted = rpc.send.mock.calls[1]![1].serializedTransaction as Parameters<
      typeof recoverTransactionAddress
    >[0]['serializedTransaction'];
    expect(await recoverTransactionAddress({ serializedTransaction: submitted })).toBe(
      account.address
    );
    expect(hash).toBe(keccak256(submitted));
    await expect(signer.sendTransaction(swapTx())).rejects.toThrow('next transaction');
    expect(hardware.signTransaction).toHaveBeenCalledTimes(2);
    expect(signer.getPendingTransaction()).toBeNull();
    await signer.close();
    expect(hardware.disconnect).toHaveBeenCalledOnce();
  });

  it('keeps the original snapshot and rejects larger approvals, worse minimums and mismatched testnet RPCs', async () => {
    const signer = await createLedgerSwapSigner({ review, execution });
    execution.approval!.data = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [swapTarget, 2000000n],
    });
    await expect(signer.sendTransaction(approvalTx())).rejects.toThrow('next transaction');
    await expect(createLedgerSwapSigner({ review, execution })).rejects.toThrow(
      'approval must match'
    );
    execution.approval = undefined;
    execution.quote.amountOutMin = '0.98';
    await expect(createLedgerSwapSigner({ review, execution })).rejects.toThrow('terms changed');
    execution.quote.amountOutMin = '0.99';
    rpc.chain.mockResolvedValue(1);
    const other = await createLedgerSwapSigner({ review, execution });
    await expect(other.sendTransaction(swapTx())).rejects.toThrow('RPC network changed');
    expect(hardware.scan).not.toHaveBeenCalled();
  });

  it('refuses a changed login or registration and a mismatched device before signing', async () => {
    const signer = await createLedgerSwapSigner({ review, execution });
    rpc.session.mockResolvedValue({
      data: { session: { user: { id: 'other-user' }, access_token: 'fixture' } },
    });
    await expect(signer.sendTransaction(approvalTx())).rejects.toThrow('session changed');
    rpc.session.mockResolvedValue({
      data: { session: { user: { id: 'ledger-user' }, access_token: 'fixture' } },
    });
    rpc.faces.mockResolvedValue({ personal: { wallets: [] } });
    await expect(signer.sendTransaction(approvalTx())).rejects.toThrow('no longer');
    rpc.faces.mockResolvedValue({ personal: { wallets: [review.wallet] } });
    hardware.getAddress.mockImplementation(() => action(Promise.resolve({ address: swapTarget })));
    await expect(signer.sendTransaction(approvalTx())).rejects.toThrow(
      'Connect the Ledger account'
    );
    expect(hardware.signTransaction).not.toHaveBeenCalled();
    expect(rpc.send).not.toHaveBeenCalled();
  });

  it('retains a computed transaction hash after an uncertain broadcast and resumes by reading only', async () => {
    const signer = await createLedgerSwapSigner({ review, execution });
    rpc.send.mockRejectedValueOnce(new Error('RPC response lost'));
    await expect(signer.sendTransaction(approvalTx())).rejects.toThrow('response lost');
    const saved = signer.getPendingTransaction();
    expect(saved).toMatch(/^0x[0-9a-f]{64}$/);
    await expect(signer.sendTransaction(approvalTx())).rejects.toThrow('already requested');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000);
    try {
      await expect(signer.resumeTransaction()).resolves.toBe(saved);
    } finally {
      clock.mockRestore();
    }
    expect(rpc.send).toHaveBeenCalledOnce();
    expect(hardware.signTransaction).toHaveBeenCalledOnce();
    expect(signer.getPendingTransaction()).toBeNull();
    await signer.close();
  });

  it('requires receipt success and keeps a failed step consumed', async () => {
    const signer = await createLedgerSwapSigner({ review, execution });
    rpc.receipt.mockImplementationOnce(async (_client, { hash }) => ({
      status: 'reverted',
      transactionHash: hash,
    }));
    await expect(signer.sendTransaction(approvalTx())).rejects.toThrow('reverted');
    await expect(signer.sendTransaction(approvalTx())).rejects.toThrow('already requested');
    expect(signer.getPendingTransaction()).toBeNull();
    expect(rpc.send).toHaveBeenCalledOnce();
  });

  it('does not broadcast if the quote expires during the device ceremony', async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const signer = await createLedgerSwapSigner({ review, execution });
      const original = hardware.signTransaction.getMockImplementation()!;
      hardware.signTransaction.mockImplementation((...args) => {
        clock.mockReturnValue(now + 120_000);
        return original(...args);
      });
      await expect(signer.sendTransaction(approvalTx())).rejects.toThrow('expired');
      expect(rpc.send).not.toHaveBeenCalled();
      await signer.close();
    } finally {
      clock.mockRestore();
    }
  });

  it('rejects a signature made by a different key before broadcast', async () => {
    const wrong = privateKeyToAccount(`0x${'2'.padStart(64, '0')}`);
    hardware.signTransaction.mockImplementation((_path, bytes: Uint8Array) =>
      action(
        wrong.signTransaction(parseTransaction(toHex(bytes))).then(serialized => {
          const tx = parseTransaction(serialized);
          return { r: tx.r, s: tx.s, v: tx.yParity };
        })
      )
    );
    const signer = await createLedgerSwapSigner({ review, execution });
    await expect(signer.sendTransaction(approvalTx())).rejects.toThrow('signature does not match');
    expect(rpc.send).not.toHaveBeenCalled();
  });

  it('reconstructs a legacy EIP-155 signature from the Ledger low-byte recovery id on Arc Testnet', async () => {
    rpc.prepare.mockImplementation(async (_client, tx) => ({
      ...tx,
      chainId: 5042002,
      type: 'legacy',
      nonce: 0,
      gas: 100000n,
      gasPrice: 2n,
    }));
    const signer = await createLedgerSwapSigner({ review, execution });
    await signer.sendTransaction(approvalTx());
    const serialized = rpc.send.mock.calls[0]![1].serializedTransaction as Parameters<
      typeof recoverTransactionAddress
    >[0]['serializedTransaction'];
    expect(parseTransaction(serialized).chainId).toBe(5042002);
    expect(await recoverTransactionAddress({ serializedTransaction: serialized })).toBe(
      account.address
    );
  });

  it('signs only the exact original order on its testnet and permits one attempt', async () => {
    const order = orderExecution();
    const signer = await createLedgerSwapSigner({ review, execution: order });
    const data = order.order.permitData as Parameters<typeof signer.signTypedData>[0];
    await expect(
      signer.signTypedData({ ...data, message: { ...data.message, amount: '2000000' } })
    ).rejects.toThrow('original reviewed');
    const signature = await signer.signTypedData(data);
    expect(await recoverTypedDataAddress({ ...data, signature })).toBe(account.address);
    await expect(signer.signTypedData(data)).rejects.toThrow('already requested');
    await expect(signer.sendTransaction(swapTx())).rejects.toThrow('next transaction');
    expect(rpc.send).not.toHaveBeenCalled();
    expect(hardware.signTypedData).toHaveBeenCalledOnce();
    await signer.close();
  });
});

it('does not broadcast if ownership is revoked while the Ledger is signing', async () => {
  const signer = await createLedgerSwapSigner({ review, execution });
  const original = hardware.signTransaction.getMockImplementation()!;
  hardware.signTransaction.mockImplementation((...args) => {
    rpc.faces.mockResolvedValue({ personal: { wallets: [] } });
    return original(...args);
  });
  await expect(signer.sendTransaction(approvalTx())).rejects.toThrow('no longer');
  expect(rpc.send).not.toHaveBeenCalled();
  await signer.close();
});

it('does not broadcast a signed step after the swap is closed', async () => {
  const signer = await createLedgerSwapSigner({ review, execution });
  const original = hardware.signTransaction.getMockImplementation()!;
  hardware.signTransaction.mockImplementation((...args) => {
    void signer.close();
    return original(...args);
  });
  await expect(signer.sendTransaction(approvalTx())).rejects.toThrow('closed');
  expect(rpc.send).not.toHaveBeenCalled();
});

it('rejects a prepared transaction whose target differs from the reviewed swap', async () => {
  const signer = await createLedgerSwapSigner({ review, execution });
  rpc.prepare.mockImplementation(async (_client, tx) => ({
    ...tx,
    to: swapTarget,
    chainId: 5042002,
    type: 'eip1559',
    nonce: 0,
    gas: 100000n,
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 1n,
  }));
  await expect(signer.sendTransaction(approvalTx())).rejects.toThrow(
    'prepared transaction changed'
  );
  expect(hardware.signTransaction).not.toHaveBeenCalled();
  expect(rpc.send).not.toHaveBeenCalled();
  await signer.close();
});

it('signs only the reviewed exact increaseAllowance before the swap and verifies both receipts', async () => {
  execution.approval!.data = encodeFunctionData({
    abi: parseAbi([
      'function increaseAllowance(address spender, uint256 addedValue) returns (bool)',
    ]),
    functionName: 'increaseAllowance',
    args: [swapTarget, 1000000n],
  });
  const signer = await createLedgerSwapSigner({ review, execution });
  const approvalHash = await signer.sendTransaction(approvalTx());
  const swapHash = await signer.sendTransaction(swapTx());
  expect(approvalHash).not.toBe(swapHash);
  expect(rpc.receipt).toHaveBeenCalledTimes(2);
  expect(hardware.signTransaction).toHaveBeenCalledTimes(2);
  await expect(signer.sendTransaction(approvalTx())).rejects.toThrow('next transaction');
  await signer.close();
});

it.each([
  'token',
  'spender',
  'increment',
  'value',
  'chain',
  'trailing-data',
])('rejects increaseAllowance with a changed %s before hardware or broadcast', async mismatch => {
  execution.approval!.data = encodeFunctionData({
    abi: parseAbi([
      'function increaseAllowance(address spender, uint256 addedValue) returns (bool)',
    ]),
    functionName: 'increaseAllowance',
    args: [
      mismatch === 'spender' ? account.address : swapTarget,
      mismatch === 'increment' ? 1000001n : 1000000n,
    ],
  });
  if (mismatch === 'token') execution.approval!.to = swapTarget;
  if (mismatch === 'value') execution.approval!.value = '1';
  if (mismatch === 'chain') execution.approval!.chainId = 43113;
  if (mismatch === 'trailing-data') execution.approval!.data = `${execution.approval!.data}00`;
  await expect(createLedgerSwapSigner({ review, execution })).rejects.toThrow();
  expect(hardware.scan).not.toHaveBeenCalled();
  expect(hardware.signTransaction).not.toHaveBeenCalled();
  expect(rpc.send).not.toHaveBeenCalled();
});
