import { replaySafeEoaTypedDataFor } from '@bu/circle-kit/replay-safe-eoa';
import type { AuthorizationEnvelopeV1, AuthorizationTarget } from '@bu/wallets/authorization';
import type { TypedData } from '@ledgerhq/device-signer-kit-ethereum';
import { Alert, Platform } from 'react-native';
import {
  createPublicClient,
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  type Hex,
  hashTypedData,
  hexToBytes,
  hexToString,
  http,
  isAddress,
  keccak256,
  parseAbi,
  recoverMessageAddress,
  recoverTransactionAddress,
  recoverTypedDataAddress,
  serializeTransaction,
  type TransactionSerializable,
  toHex,
} from 'viem';
import {
  getChainId,
  prepareTransactionRequest,
  sendRawTransaction,
  waitForTransactionReceipt,
} from 'viem/actions';

import { getPrimaryBlockchain, getWebsiteUrl } from '@/constants';
import { formatLedgerSignature } from '@/services/ledger-signature';

const swapApprovalAbi = [
  ...erc20Abi,
  ...parseAbi(['function increaseAllowance(address spender, uint256 addedValue) returns (bool)']),
] as const;
const ETHEREUM_PATH = "44'/60'/0'/0/0";
const SCAN_TIMEOUT_MS = 30_000;

type LedgerStatus = (message: string) => void;

type LedgerConnection = {
  address: Hex;
  close: () => Promise<void>;
  signMessage: (message: string | Uint8Array) => Promise<Hex>;
  signTypedData: (data: TypedData) => Promise<Hex>;
  signTransaction: (transaction: Hex) => Promise<{ r: Hex; s: Hex; v: number }>;
};

let dmkPromise: Promise<import('@ledgerhq/device-management-kit').DeviceManagementKit> | null =
  null;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Ledger did not complete the request.';
}

async function runDeviceAction<T>(action: {
  observable: import('rxjs').Observable<{
    status: import('@ledgerhq/device-management-kit').DeviceActionStatus;
    output?: T;
    error?: unknown;
  }>;
  cancel(): void;
}): Promise<T> {
  const { DeviceActionStatus } = await import('@ledgerhq/device-management-kit');
  return new Promise<T>((resolve, reject) => {
    let subscription: { unsubscribe(): void } | undefined;
    subscription = action.observable.subscribe({
      next: state => {
        if (state.status === DeviceActionStatus.Completed && state.output !== undefined) {
          subscription?.unsubscribe();
          resolve(state.output);
        } else if (state.status === DeviceActionStatus.Error) {
          subscription?.unsubscribe();
          reject(new Error(errorMessage(state.error)));
        } else if (state.status === DeviceActionStatus.Stopped) {
          subscription?.unsubscribe();
          reject(new Error('Ledger request was canceled.'));
        }
      },
      error: reject,
    });
  });
}

async function getDmk() {
  if (!dmkPromise) {
    dmkPromise = Promise.all([
      import('@ledgerhq/device-management-kit'),
      import('@ledgerhq/device-transport-kit-react-native-ble'),
    ]).then(async ([{ DeviceManagementKitBuilder }, { RNBleTransportFactory }]) => {
      const builder = new DeviceManagementKitBuilder().addTransport(RNBleTransportFactory);
      if (Platform.OS === 'android') {
        const { RNHidTransportFactory } = await import(
          '@ledgerhq/device-transport-kit-react-native-hid'
        );
        builder.addTransport(RNHidTransportFactory);
      }
      return builder.build();
    });
  }
  return dmkPromise;
}

async function connectLedger(onStatus?: LedgerStatus): Promise<LedgerConnection> {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') {
    throw new Error('Ledger mobile support requires the BUFI iOS or Android app.');
  }

  const [{ SignerEthBuilder }, { filter, firstValueFrom, timeout }] = await Promise.all([
    import('@ledgerhq/device-signer-kit-ethereum'),
    import('rxjs'),
  ]);
  let transport: import('@ledgerhq/device-management-kit').TransportIdentifier | undefined;
  if (Platform.OS === 'android') {
    const [{ rnHidTransportIdentifier }, { rnBleTransportIdentifier }] = await Promise.all([
      import('@ledgerhq/device-transport-kit-react-native-hid'),
      import('@ledgerhq/device-transport-kit-react-native-ble'),
    ]);
    transport = await new Promise((resolve, reject) => {
      const cancel = () => reject(new Error('Ledger connection was canceled.'));
      Alert.alert(
        'Connect Ledger',
        'Choose how to connect your Ledger.',
        [
          { text: 'USB', onPress: () => resolve(rnHidTransportIdentifier) },
          { text: 'Bluetooth', onPress: () => resolve(rnBleTransportIdentifier) },
          { text: 'Cancel', style: 'cancel', onPress: cancel },
        ],
        { cancelable: true, onDismiss: cancel }
      );
    });
  }
  const usb = transport === 'RN_HID';
  const dmk = await getDmk();
  if (!dmk.isEnvironmentSupported()) {
    throw new Error('Ledger connections are not supported on this device.');
  }

  onStatus?.(
    usb
      ? 'Connect your Ledger by USB, unlock it, and open Ethereum.'
      : 'Unlock your Ledger, enable Bluetooth, and keep it nearby.'
  );
  const devices = await firstValueFrom(
    dmk.listenToAvailableDevices({ transport }).pipe(
      filter(found => found.length > 0),
      timeout({ first: SCAN_TIMEOUT_MS })
    )
  )
    .catch(error => {
      throw new Error(
        `No Ledger found. ${usb ? 'Check the USB cable and allow the connection on your phone.' : 'Unlock it and enable Bluetooth.'} ${errorMessage(error)}`
      );
    })
    .finally(() => dmk.stopDiscovering().catch(() => undefined));

  // ponytail: nearest-device selection; add a chooser when multi-device telemetry
  // warrants it. The address still has to be confirmed on the selected device.
  const device = [...devices].sort((a, b) => (b.rssi ?? -Infinity) - (a.rssi ?? -Infinity))[0]!;
  const sessionId = await dmk.connect({ device });
  const signer = new SignerEthBuilder({
    dmk,
    sessionId,
    originToken: process.env.EXPO_PUBLIC_LEDGER_ORIGIN_TOKEN || undefined,
  }).build();

  try {
    onStatus?.('Open the Ethereum app and confirm the address on your Ledger.');
    const account = await runDeviceAction(
      signer.getAddress(ETHEREUM_PATH, { checkOnDevice: true })
    );
    if (!isAddress(account.address)) throw new Error('Ledger returned an invalid address.');

    return {
      address: account.address,
      close: () => dmk.disconnect({ sessionId }).catch(() => undefined),
      signTypedData: async data => {
        onStatus?.('Review and approve the authorization on your Ledger.');
        return formatLedgerSignature(
          await runDeviceAction(signer.signTypedData(ETHEREUM_PATH, data))
        );
      },
      signTransaction: async transaction => {
        onStatus?.('Review this testnet swap transaction on your Ledger.');
        return runDeviceAction(signer.signTransaction(ETHEREUM_PATH, hexToBytes(transaction)));
      },
      signMessage: async message => {
        onStatus?.('Review and approve the message on your Ledger.');
        return formatLedgerSignature(
          await runDeviceAction(signer.signMessage(ETHEREUM_PATH, message))
        );
      },
    };
  } catch (error) {
    await dmk.disconnect({ sessionId }).catch(() => undefined);
    throw error;
  }
}

async function primaryChainId() {
  const { resolveChainConfig } = await import('@bu/circle/modular/client');
  return resolveChainConfig(getPrimaryBlockchain()).chain.id;
}

export async function createLedgerEthereumProvider(onStatus?: LedgerStatus) {
  const connection = await connectLedger(onStatus);
  const chainId = await primaryChainId();
  const provider = {
    address: connection.address,
    on: () => undefined,
    removeListener: () => undefined,
    request: async ({ method, params }: { method: string; params?: unknown }) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') {
        return [connection.address];
      }
      if (method === 'eth_chainId') return toHex(chainId);
      if (method === 'personal_sign') {
        const values = Array.isArray(params) ? params : [];
        const message = values[0];
        const requestedAddress = values[1];
        if (
          typeof message !== 'string' ||
          typeof requestedAddress !== 'string' ||
          requestedAddress.toLowerCase() !== connection.address.toLowerCase()
        ) {
          throw new Error('Ledger sign-in request did not match the connected account.');
        }
        return connection.signMessage(
          message.startsWith('0x') ? hexToString(message as Hex) : message
        );
      }
      throw new Error(`Ledger does not support ${method}.`);
    },
  };
  return {
    address: connection.address,
    close: connection.close,
    provider,
  };
}

async function registerLedger(input: {
  authToken: string;
  challengeUrl: string;
  registerUrl: string;
  onStatus?: LedgerStatus;
  inviteCode?: string;
}) {
  const headers = {
    Authorization: `Bearer ${input.authToken}`,
    'Content-Type': 'application/json',
  };
  const challengeResponse = await fetch(input.challengeUrl, {
    method: 'POST',
    headers,
  });
  const challenge = (await challengeResponse.json().catch(() => null)) as {
    challengeToken?: string;
    ledgerMessage?: string;
    message?: string;
    error?: string;
  } | null;
  const message = challenge?.ledgerMessage || challenge?.message;
  if (!challengeResponse.ok || !challenge?.challengeToken || !message) {
    throw new Error(challenge?.error || 'Could not prepare Ledger verification.');
  }

  const connection = await connectLedger(input.onStatus);
  try {
    const signature = await connection.signMessage(message);
    const response = await fetch(input.registerUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        type: 'ledger',
        address: connection.address,
        ownerAddress: connection.address,
        signature,
        challengeToken: challenge.challengeToken,
        providerName: 'Ledger',
        providerRdns: 'com.ledger',
        ...(input.inviteCode ? { inviteCode: input.inviteCode } : {}),
      }),
    });
    const result = (await response.json().catch(() => null)) as {
      success?: boolean;
      error?: string;
    } | null;
    if (!response.ok || !result?.success) {
      throw new Error(result?.error || 'Ledger registration failed.');
    }
    return result;
  } finally {
    await connection.close();
  }
}

export function registerPersonalLedger(input: { authToken: string; onStatus?: LedgerStatus }) {
  const website = (getWebsiteUrl() || 'https://desk.bu.finance').replace(/\/$/, '');
  return registerLedger({
    ...input,
    challengeUrl: `${website}/api/wallet/personal/ledger/challenge`,
    registerUrl: `${website}/api/wallet/personal/ledger/register`,
  });
}

export function registerTreasuryLedger(input: {
  authToken: string;
  teamId: string;
  onStatus?: LedgerStatus;
  inviteCode?: string;
}) {
  const website = (getWebsiteUrl() || 'https://desk.bu.finance').replace(/\/$/, '');
  const query = `teamId=${encodeURIComponent(input.teamId)}&walletPurpose=treasury`;
  return registerLedger({
    ...input,
    challengeUrl: `${website}/api/team-wallet/signers/challenge?${query}`,
    registerUrl: `${website}/api/team-wallet/signers/register?${query}`,
  });
}

/** Ledger uses EIP-191 for userOps and EIP-712 for the treasury's ERC-1271 rail. */
export async function signLedgerAuthorizationTarget(input: {
  signerAddress: Hex;
  target: AuthorizationTarget;
  replaySafe?: Extract<AuthorizationEnvelopeV1['signing'], { kind: 'raw-hash-1271' }>;
  onStatus?: LedgerStatus;
}) {
  if (!isAddress(input.signerAddress) || !/^0x[0-9a-f]{64}$/i.test(input.target.digest))
    throw new Error('The Ledger authorization target is invalid.');
  if (input.replaySafe && input.replaySafe.digest !== input.target.digest)
    throw new Error('The Ledger authorization digest changed. Refresh before signing.');
  const typed = input.replaySafe
    ? replaySafeEoaTypedDataFor({
        ...input.replaySafe,
        account: input.replaySafe.account as Hex,
        digest: input.replaySafe.digest as Hex,
        ...(input.replaySafe.innerDigest ? { inner: input.replaySafe.innerDigest as Hex } : {}),
      })
    : null;
  const connection = await connectLedger(input.onStatus);
  try {
    if (connection.address.toLowerCase() !== input.signerAddress.toLowerCase())
      throw new Error(
        'This Ledger account is not the registered crew signer. Connect the correct account.'
      );
    const signature = typed
      ? await connection.signTypedData({
          domain: { ...typed.domain },
          types: { [typed.primaryType]: [...typed.types.CircleWeightedWebauthnMultisigMessage] },
          primaryType: typed.primaryType,
          message: { ...typed.message },
        })
      : await connection.signMessage(hexToBytes(input.target.digest as Hex));
    const recovered = typed
      ? await recoverTypedDataAddress({ ...typed, signature })
      : await recoverMessageAddress({ message: { raw: input.target.digest as Hex }, signature });
    if (recovered.toLowerCase() !== input.signerAddress.toLowerCase())
      throw new Error('The Ledger signature does not match the registered crew signer.');
    return { signerAddress: input.signerAddress, signature, userOpSigType: '0x00' as const };
  } finally {
    await connection.close();
  }
}

type LedgerSwapExecution = Extract<
  import('@bu/swap/types').SwapExecuteResponse,
  { mode: 'unsigned-tx' | 'unsigned-order' }
>;
type LedgerSwapTransaction = { to: Hex; data: Hex; value?: bigint };
type LedgerSwapTypedData = {
  domain: Record<string, unknown>;
  types: Record<string, readonly { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
};

/** Device authority is limited to one reviewed testnet swap, never arbitrary wallet calls. */
export async function createLedgerSwapSigner(input: {
  review: import('@/features/swaps/swap-model').NativeSwapReview;
  execution: LedgerSwapExecution;
  onStatus?: LedgerStatus;
  assertActive?: () => Promise<unknown>;
}) {
  const [
    { SWAP_CHAINS },
    { getTokenAddress },
    { getBlockchainFromChainId },
    { personalWalletKindFromRow },
    { assertSwapQuote, swapAtomic },
    { supabase },
    { getWalletFaces },
  ] = await Promise.all([
    import('@bu/swap/chains'),
    import('@bu/swap/tokens'),
    import('@bu/transfer-core/chain-constants'),
    import('@bu/wallets/wallet-setup/personal-wallet-setup'),
    import('@/features/swaps/swap-model'),
    import('@/config/supabase'),
    import('@/services/wallet-faces.service'),
  ]);
  // Keep internal copies: editing a form or a provider response cannot expand this authority.
  const { review, execution } = JSON.parse(
    JSON.stringify({ review: input.review, execution: input.execution }, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value
    )
  ) as { review: typeof input.review; execution: LedgerSwapExecution };
  const { draft, wallet } = review;
  const meta = SWAP_CHAINS[review.chain];
  const owner = wallet.wallet_address;
  const userId = wallet.user_id;
  const registeredLedger = (row: typeof wallet) =>
    personalWalletKindFromRow({
      custodyModel: row.custody_model,
      walletProvider:
        typeof row.metadata?.wallet_provider === 'string'
          ? row.metadata.wallet_provider
          : undefined,
    }) === 'ledger';
  if (
    !meta?.isTestnet ||
    meta.kind !== 'evm' ||
    draft.face !== 'personal' ||
    draft.walletId !== wallet.id ||
    wallet.main_type !== 'individual' ||
    !userId ||
    !owner ||
    !isAddress(owner) ||
    !registeredLedger(wallet)
  )
    throw new Error('Choose a registered Personal Ledger wallet on testnet for this swap.');
  const blockchain = getBlockchainFromChainId(meta.chainId);
  if (!blockchain || (wallet.blockchain !== blockchain && wallet.blockchain !== 'EVM'))
    throw new Error('The reviewed Ledger wallet does not match this testnet.');
  function assertReview() {
    assertSwapQuote(review.quote, draft, review.chain);
    assertSwapQuote(execution.quote, draft, review.chain);
    if (
      execution.quote.provider !== review.quote.provider ||
      swapAtomic(execution.quote.amountOutMin, draft.tokenOut) <
        swapAtomic(review.quote.amountOutMin, draft.tokenOut) ||
      execution.quote.fees.providerBps + execution.quote.fees.platformBps >
        review.quote.fees.providerBps + review.quote.fees.platformBps ||
      (execution.mode === 'unsigned-order' &&
        (!Number.isFinite(execution.order.deadline) ||
          execution.order.deadline * 1000 <= Date.now()))
    )
      throw new Error('The swap terms changed. Review a fresh quote before signing.');
  }
  assertReview();
  const steps: LedgerSwapTransaction[] = [];
  let expectedOrder: LedgerSwapTypedData | null = null;
  let expectedOrderHash: Hex | null = null;
  if (execution.mode === 'unsigned-tx') {
    if (execution.chainKind !== 'evm' || execution.tx.kind !== 'evm')
      throw new Error('This Ledger swap requires EVM transactions.');
    for (const tx of [execution.approval, execution.tx]) {
      if (!tx) continue;
      if (
        tx.chainId !== meta.chainId ||
        !isAddress(tx.to) ||
        !/^0x(?:[0-9a-f]{2})*$/i.test(tx.data) ||
        !/^(0|[1-9][0-9]*)$/.test(tx.value)
      )
        throw new Error('The swap transaction does not match the reviewed testnet.');
      steps.push({ to: tx.to, data: tx.data, value: BigInt(tx.value) });
    }
    if (execution.approval) {
      const approval = decodeFunctionData({ abi: swapApprovalAbi, data: execution.approval.data });
      if (
        (approval.functionName !== 'approve' && approval.functionName !== 'increaseAllowance') ||
        execution.approval.to.toLowerCase() !==
          getTokenAddress(review.chain, draft.tokenIn)?.toLowerCase() ||
        approval.args[0].toLowerCase() !== execution.tx.to.toLowerCase() ||
        approval.args[1] !== swapAtomic(draft.amountIn, draft.tokenIn) ||
        execution.approval.value !== '0' ||
        encodeFunctionData({
          abi: swapApprovalAbi,
          functionName: approval.functionName,
          args: approval.args,
        }).toLowerCase() !== execution.approval.data.toLowerCase()
      )
        throw new Error('The approval must match this swap input, amount and recipient.');
    }
  } else if (execution.mode === 'unsigned-order') {
    expectedOrder = execution.order.permitData as LedgerSwapTypedData;
    if (
      !expectedOrder?.domain ||
      Number(expectedOrder.domain.chainId) !== meta.chainId ||
      !expectedOrder.types ||
      !expectedOrder.primaryType ||
      !expectedOrder.message
    )
      throw new Error('The swap order does not match the reviewed testnet.');
    expectedOrderHash = hashTypedData(expectedOrder);
  } else {
    throw new Error('This swap does not require a Ledger signature.');
  }

  async function assertOwner() {
    await input.assertActive?.();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session?.access_token || session.user.id !== userId)
      throw new Error('Your Ledger wallet session changed. Reopen this wallet.');
    const faces = await getWalletFaces(session.access_token);
    const rows = faces.personal.wallets.filter(
      row =>
        row.id === wallet.id &&
        row.user_id === userId &&
        row.main_type === 'individual' &&
        row.wallet_address?.toLowerCase() === owner.toLowerCase() &&
        row.blockchain === wallet.blockchain &&
        registeredLedger(row)
    );
    if (rows.length !== 1)
      throw new Error('This wallet is no longer your registered Personal Ledger.');
    const current = await supabase.auth.getSession();
    if (current.data.session?.user.id !== userId)
      throw new Error('Your Ledger wallet session changed. Reopen this wallet.');
  }
  await assertOwner();
  const { resolveChainConfig } = await import('@bu/circle/modular/client');
  const { chain } = resolveChainConfig(blockchain);
  if (chain.id !== meta.chainId || !chain.testnet)
    throw new Error('Ledger swaps require the matching testnet chain configuration.');
  const client = createPublicClient({ chain, transport: http() });
  async function assertChain() {
    if ((await getChainId(client)) !== meta.chainId)
      throw new Error('The RPC network changed. Reopen this testnet swap.');
  }
  let connection: LedgerConnection | null = null;
  let busy = false;
  let closed = false;
  let nextStep = 0;
  let attempted = -1;
  let orderAttempted = false;
  let pending: { hash: Hex; step: number } | null = null;

  async function device() {
    if (!connection) connection = await connectLedger(input.onStatus);
    if (connection.address.toLowerCase() !== owner.toLowerCase()) {
      await connection.close();
      connection = null;
      throw new Error('Connect the Ledger account registered for this Personal wallet.');
    }
    return connection;
  }
  async function enter() {
    if (closed || busy) throw new Error('The Ledger swap is closed or already awaiting approval.');
    busy = true;
    try {
      assertReview();
      await assertOwner();
      await assertChain();
      assertReview();
      if (closed) throw new Error('The Ledger swap was closed. Review it again before signing.');
    } catch (error) {
      busy = false;
      throw error;
    }
  }
  async function confirmPending() {
    if (!pending) return null;
    const current = pending;
    const receipt = await waitForTransactionReceipt(client, {
      hash: current.hash,
      timeout: 120_000,
    });
    if (receipt.transactionHash.toLowerCase() !== current.hash.toLowerCase())
      throw new Error('The swap receipt does not match the submitted transaction.');
    pending = null;
    if (receipt.status !== 'success') throw new Error('The Ledger swap transaction reverted.');
    nextStep = current.step + 1;
    return current.hash;
  }
  return {
    async sendTransaction(tx: LedgerSwapTransaction): Promise<Hex> {
      const expected = steps[nextStep];
      if (
        !expected ||
        tx.to.toLowerCase() !== expected.to.toLowerCase() ||
        tx.data.toLowerCase() !== expected.data.toLowerCase() ||
        (tx.value ?? 0n) !== expected.value
      )
        throw new Error('Only the next transaction in this reviewed swap may be signed.');
      if (pending || attempted === nextStep)
        throw new Error(
          'This swap step was already requested. Check its transaction before retrying.'
        );
      await enter();
      try {
        attempted = nextStep;
        const ledger = await device();
        const prepared = await prepareTransactionRequest(client, {
          account: owner,
          chain,
          to: expected.to,
          data: expected.data,
          value: expected.value,
        });
        if (
          prepared.chainId !== meta.chainId ||
          prepared.to?.toLowerCase() !== expected.to.toLowerCase() ||
          prepared.data?.toLowerCase() !== expected.data.toLowerCase() ||
          prepared.value !== expected.value ||
          !['legacy', 'eip2930', 'eip1559'].includes(prepared.type ?? '')
        )
          throw new Error('The prepared transaction changed the reviewed swap.');
        const transaction = prepared as TransactionSerializable;
        const signature = await ledger.signTransaction(serializeTransaction(transaction));
        // Ledger emits one byte for v, including legacy EIP-155 chain ids. Recover parity,
        // then let Viem reconstruct the full chain-bound signature before verifying its owner.
        if (!Number.isInteger(signature.v) || signature.v < 0 || signature.v > 255)
          throw new Error('Ledger returned an invalid transaction recovery id.');
        const parity = signature.v <= 1 ? signature.v : (signature.v + 1) % 2;
        const serializedTransaction = serializeTransaction(transaction, {
          r: signature.r,
          s: signature.s,
          v: 27n + BigInt(parity),
        });
        if (
          (await recoverTransactionAddress({ serializedTransaction })).toLowerCase() !==
          owner.toLowerCase()
        )
          throw new Error('The swap signature does not match the registered Ledger.');
        if (closed) throw new Error('The Ledger swap was closed. Review it again before signing.');
        assertReview();
        await assertOwner();
        await assertChain();
        if (closed) throw new Error('The Ledger swap was closed. Review it again before signing.');
        assertReview();
        pending = { hash: keccak256(serializedTransaction), step: nextStep };
        const hash = await sendRawTransaction(client, { serializedTransaction });
        if (hash.toLowerCase() !== pending.hash.toLowerCase())
          throw new Error(
            'The RPC returned a different transaction hash. Check the saved transaction.'
          );
        return (await confirmPending())!;
      } finally {
        busy = false;
      }
    },
    async signTypedData(data: LedgerSwapTypedData): Promise<Hex> {
      if (!expectedOrder || !expectedOrderHash || hashTypedData(data) !== expectedOrderHash)
        throw new Error('Only the original reviewed swap order may be signed.');
      if (orderAttempted)
        throw new Error('This swap order was already requested. Review a fresh quote to retry.');
      await enter();
      try {
        orderAttempted = true;
        const ledger = await device();
        const signature = await ledger.signTypedData({
          ...expectedOrder,
          types: Object.fromEntries(
            Object.entries(expectedOrder.types).map(([name, fields]) => [name, [...fields]])
          ),
        });
        if (
          (await recoverTypedDataAddress({ ...expectedOrder, signature })).toLowerCase() !==
          owner.toLowerCase()
        )
          throw new Error('The swap signature does not match the registered Ledger.');
        if (closed) throw new Error('The Ledger swap was closed. Review it again before signing.');
        assertReview();
        await assertOwner();
        if (closed) throw new Error('The Ledger swap was closed. Review it again before signing.');
        assertReview();
        return signature;
      } finally {
        busy = false;
      }
    },
    getPendingTransaction: () => pending?.hash ?? null,
    // Receipt-only recovery is valid after quote expiry: it can never sign or send again.
    async resumeTransaction(): Promise<Hex | null> {
      if (busy) throw new Error('The Ledger swap is still awaiting approval.');
      if (!pending) return null;
      busy = true;
      try {
        await assertOwner();
        await assertChain();
        return await confirmPending();
      } finally {
        busy = false;
      }
    },
    async close() {
      closed = true;
      if (connection) await connection.close();
      connection = null;
    },
  };
}
