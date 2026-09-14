/**
 * In-memory stand-in for `@bufi6900/treasury-kit`, selected with `AGENT_KIT=stub`.
 *
 * It honours the kit contract (`kit-contract.ts`) closely enough to drive the
 * whole demo story without a chain: deterministic treasury/agent addresses,
 * real ECDSA signatures from the owner keys, the real `intentNonce` hash and
 * `execute` calldata, balances that move on submit, and a used-nonce check so a
 * second submit of the same approval is refused. Nothing here touches a network.
 */
import {
  concatHex,
  encodeAbiParameters,
  encodeFunctionData,
  formatUnits,
  getAddress,
  keccak256,
  parseAbi,
  toHex,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAddress, sign } from 'viem/accounts'
import type {
  AgentGrant,
  ApprovedConduitRequest,
  BuildEarnDepositRequestInput,
  BuildFromPodsBytecodeInput,
  BuildSwapRequestInput,
  ConduitFacts,
  ConduitIntent,
  ConduitReceipt,
  ConduitRequest,
  DeployAgentFaceInput,
  DeployedAgentFace,
  DeployTreasuryInput,
  DeployTreasuryResult,
  KitEnv,
  OwnerSigner,
  Quorum,
  SubmitVia,
  TreasuryChain,
  TreasuryChainKey,
  TreasuryKit,
  TreasuryOwner,
  TreasuryStatusReport,
} from './kit-contract.js'

// ─── chains ─────────────────────────────────────────────────────────────────

/** A deterministic placeholder address, so stub chains look like chains. */
function placeholder(label: string): Address {
  return getAddress(`0x${keccak256(toHex(`bufi6900-stub:${label}`)).slice(26)}`)
}

function chain(
  key: TreasuryChainKey,
  chainId: number,
  modularPath: string | null,
  extra: Partial<TreasuryChain> = {},
): TreasuryChain {
  return {
    key,
    chainId,
    modularPath,
    rpcUrl: '',
    deploymentFile: `contracts/deployments/${key.toLowerCase()}.json`,
    usdc: placeholder(`${key}:usdc`),
    eurc: placeholder(`${key}:eurc`),
    erc3009Domain: { USDC: { name: 'USDC', version: '2' }, EURC: { name: 'EURC', version: '2' } },
    conduit: placeholder(`${key}:conduit`),
    targets: { router: placeholder(`${key}:router`), vault: placeholder(`${key}:vault`) },
    ...extra,
  }
}

/** The stub's chain table. LOCAL mirrors the sandbox USDC address; everything else is a placeholder. */
export const STUB_CHAINS: Record<TreasuryChainKey, TreasuryChain> = {
  LOCAL: chain('LOCAL', 31337, null, { usdc: '0x38B45856e28E86985560f9c4B87113E8Eb86b0AD' }),
  'ARC-TESTNET': chain('ARC-TESTNET', 5042002, '/arcTestnet'),
  'AVAX-FUJI': chain('AVAX-FUJI', 43113, '/avalancheFuji'),
  'ARB-SEPOLIA': chain('ARB-SEPOLIA', 421614, '/arbitrumSepolia'),
  'BASE-SEPOLIA': chain('BASE-SEPOLIA', 84532, '/baseSepolia'),
  ARC: chain('ARC', 5042, '/arc', { conduit: null, targets: {} }),
  AVAX: chain('AVAX', 43114, '/avalanche', { conduit: null, targets: {} }),
}

function getChain(key: TreasuryChainKey): TreasuryChain {
  const found = STUB_CHAINS[key]
  if (!found) throw new Error(`unknown chain ${key}`)
  return found
}

function withConduit(base: TreasuryChain, conduit: Address, targets: Record<string, Address>): TreasuryChain {
  return { ...base, conduit, targets: { ...base.targets, ...targets } }
}

// ─── signing ────────────────────────────────────────────────────────────────

function localKeySigner(privateKey: Hex): OwnerSigner {
  return {
    address: privateKeyToAddress(privateKey),
    signDigest: (digest) => sign({ hash: digest, privateKey, to: 'hex' }),
  }
}

function sortedOwners(owners: readonly OwnerSigner[]): OwnerSigner[] {
  return [...owners].sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1))
}

// ─── conduit encoding (same algorithm as TreasuryConduit.sol) ───────────────

const INTENT_TYPEHASH = keccak256(
  toHex(
    'Intent(address target,bytes data,address tokenIn,uint256 amountIn,address tokenOut,uint256 minOut,address beneficiary,uint256 deadline)',
  ),
)

/** `TreasuryConduit.intentNonce` reproduced client-side. */
export function intentNonce(intent: ConduitIntent): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'address' },
        { type: 'bytes32' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'address' },
        { type: 'uint256' },
      ],
      [
        INTENT_TYPEHASH,
        intent.target,
        keccak256(intent.data),
        intent.tokenIn,
        intent.amountIn,
        intent.tokenOut,
        intent.minOut,
        intent.beneficiary,
        intent.deadline,
      ],
    ),
  )
}

const CONDUIT_ABI = parseAbi([
  'struct Authorization { address token; address from; uint256 value; uint256 validAfter; uint256 validBefore; bytes32 nonce; }',
  'struct Intent { address target; bytes data; address tokenIn; uint256 amountIn; address tokenOut; uint256 minOut; address beneficiary; uint256 deadline; }',
  'function execute(Authorization auth, bytes quorumSignature, Intent intent)',
])

// ─── in-memory ledger ───────────────────────────────────────────────────────

interface StubTreasury {
  owners: TreasuryOwner[]
  thresholdWeight: bigint
  allowlist: Address[]
  /** token address (lowercase) → atomic */
  balances: Map<string, bigint>
}

const treasuries = new Map<string, StubTreasury>()
const usedNonces = new Set<string>()
let txCounter = 0

function ledgerKey(chainKey: TreasuryChainKey, treasury: Address): string {
  return `${chainKey}:${treasury.toLowerCase()}`
}

/** Forget everything the stub deployed or executed. Tests call this between cases. */
export function resetStub(): void {
  treasuries.clear()
  usedNonces.clear()
  txCounter = 0
}

/** Seed the stub with a demo balance: 1,000 USDC on every treasury it deploys. */
const SEED_USDC = 1_000_000_000n

function symbolOf(c: TreasuryChain, token: Address): string {
  if (token.toLowerCase() === c.usdc.toLowerCase()) return 'USDC'
  if (c.eurc && token.toLowerCase() === c.eurc.toLowerCase()) return 'EURC'
  if (c.targets.vault && token.toLowerCase() === c.targets.vault.toLowerCase()) return 'shares'
  return 'tokens'
}

function tokenOf(c: TreasuryChain, symbol: 'USDC' | 'EURC'): Address {
  if (symbol === 'USDC') return c.usdc
  if (!c.eurc) throw new Error(`${c.key} has no EURC`)
  return c.eurc
}

function conduitOf(c: TreasuryChain): Address {
  if (!c.conduit) throw new Error(`${c.key} has no TreasuryConduit deployed`)
  return c.conduit
}

// ─── treasury ───────────────────────────────────────────────────────────────

function deriveTreasury(input: DeployTreasuryInput): Address {
  const seed = concatHex([
    input.salt ?? '0x00',
    ...input.owners.map((o) => o.address),
    toHex(input.thresholdWeight),
  ])
  return placeholder(`treasury:${keccak256(seed)}`)
}

async function deployTreasury(input: DeployTreasuryInput, _env: KitEnv): Promise<DeployTreasuryResult> {
  const address = deriveTreasury(input)
  const deployed = input.chains.map((key) => {
    const c = getChain(key)
    treasuries.set(ledgerKey(key, address), {
      owners: [...input.owners],
      thresholdWeight: input.thresholdWeight,
      allowlist: [...input.allowlist],
      balances: new Map([[c.usdc.toLowerCase(), SEED_USDC]]),
    })
    return {
      chain: key,
      address,
      owners: input.owners,
      thresholdWeight: input.thresholdWeight,
      allowlist: input.allowlist,
      userOpHashes: [keccak256(toHex(`${key}:create`)), keccak256(toHex(`${key}:address-book`))],
    }
  })
  return { deployed, failed: [] }
}

async function treasuryStatus(key: TreasuryChainKey, treasury: Address, _env: KitEnv): Promise<TreasuryStatusReport> {
  const c = getChain(key)
  const t = treasuries.get(ledgerKey(key, treasury))
  if (!t) return { deployed: false, owners: [], thresholdWeight: 0n, allowlist: [], balances: {} }
  const balances: Record<string, bigint> = {}
  for (const [token, amount] of t.balances) balances[symbolOf(c, getAddress(token))] = amount
  return { deployed: true, owners: t.owners, thresholdWeight: t.thresholdWeight, allowlist: t.allowlist, balances }
}

// ─── agent face ─────────────────────────────────────────────────────────────

/** `TreasuryConduit.execute` selector. */
const EXECUTE_SELECTOR: Hex = '0x' + keccak256(toHex('execute((address,address,uint256,uint256,uint256,bytes32),bytes,(address,bytes,address,uint256,address,uint256,address,uint256))')).slice(2, 10) as Hex

function conduitExecutorGrant(input: {
  conduit: Address
  validUntil: number
  gasBudget?: { limit: bigint; refreshIntervalSeconds: number }
}): AgentGrant {
  return {
    allow: [{ target: input.conduit, selectors: [EXECUTE_SELECTOR] }],
    gasBudget: input.gasBudget,
    validUntil: input.validUntil,
  }
}

async function deployAgentFace(input: DeployAgentFaceInput, _env: KitEnv): Promise<DeployedAgentFace> {
  if (!treasuries.has(ledgerKey(input.chain, input.treasury))) {
    throw new Error(`no treasury ${input.treasury} on ${input.chain}`)
  }
  const address = placeholder(`agent:${input.chain}:${input.treasury}:${input.sessionKey}:${input.salt ?? ''}`)
  return {
    chain: input.chain,
    address,
    sessionKey: input.sessionKey,
    grant: input.grant,
    userOpHashes: [keccak256(toHex(`${address}:create`)), keccak256(toHex(`${address}:session-key`))],
  }
}

// ─── conduit requests ───────────────────────────────────────────────────────

function nowSeconds(): bigint {
  return BigInt(Math.floor(Date.now() / 1000))
}

function human(amount: bigint, decimals = 6): string {
  return formatUnits(amount, decimals)
}

function assemble(
  c: TreasuryChain,
  treasury: Address,
  kind: ConduitFacts['kind'],
  intent: Omit<ConduitIntent, 'beneficiary' | 'deadline'>,
  receiveSymbol: string,
  lines: readonly string[],
  validForSeconds: number,
): ConduitRequest {
  const deadline = nowSeconds() + BigInt(validForSeconds)
  const full: ConduitIntent = { ...intent, beneficiary: treasury, deadline }
  const nonce = intentNonce(full)
  const spendSymbol = symbolOf(c, intent.tokenIn)
  const facts: ConduitFacts = {
    kind,
    chain: c.key,
    treasury,
    target: intent.target,
    spend: { token: intent.tokenIn, symbol: spendSymbol, amount: human(intent.amountIn) },
    receive: { token: intent.tokenOut, symbol: receiveSymbol, minimum: human(intent.minOut) },
    deadline: new Date(Number(deadline) * 1000).toISOString(),
    lines: [
      ...lines,
      `Treasury ${treasury} signs an ERC-3009 authorization for ${human(intent.amountIn)} ${spendSymbol} to the conduit ${conduitOf(c)}`,
      `Nonce ${nonce} binds the signature to this exact intent; it cannot be replayed`,
      `Everything returns to the treasury; the conduit holds nothing after the transaction`,
      `Valid until ${new Date(Number(deadline) * 1000).toISOString()}`,
    ],
  }
  return {
    chain: c.key,
    intent: full,
    authorization: {
      token: intent.tokenIn,
      from: treasury,
      value: intent.amountIn,
      validAfter: 0n,
      validBefore: deadline,
      nonce,
    },
    facts,
  }
}

function buildSwapRequest(input: BuildSwapRequestInput): ConduitRequest {
  const c = getChain(input.chain)
  if (input.tokenIn === input.tokenOut) throw new Error('tokenIn and tokenOut must differ')
  return assemble(
    c,
    input.treasury,
    'swap',
    {
      target: input.route.target,
      data: input.route.data,
      tokenIn: tokenOf(c, input.tokenIn),
      amountIn: input.amountIn,
      tokenOut: tokenOf(c, input.tokenOut),
      minOut: input.minOut,
    },
    input.tokenOut,
    [
      `Swap ${human(input.amountIn)} ${input.tokenIn} for at least ${human(input.minOut)} ${input.tokenOut} on ${c.key}`,
      `Route: ${input.route.label} at ${input.route.target}`,
    ],
    input.validForSeconds ?? 3600,
  )
}

const ERC4626_ABI = parseAbi(['function deposit(uint256 assets, address receiver) returns (uint256 shares)'])

function buildEarnDepositRequest(input: BuildEarnDepositRequestInput): ConduitRequest {
  const c = getChain(input.chain)
  return assemble(
    c,
    input.treasury,
    'earn-deposit',
    {
      target: input.vault,
      data: encodeFunctionData({ abi: ERC4626_ABI, functionName: 'deposit', args: [input.amountIn, input.treasury] }),
      tokenIn: tokenOf(c, input.token),
      amountIn: input.amountIn,
      tokenOut: input.vault,
      minOut: input.minShares,
    },
    'shares',
    [
      `Deposit ${human(input.amountIn)} ${input.token} into the ERC-4626 vault ${input.vault} on ${c.key}`,
      `The treasury must receive at least ${human(input.minShares)} vault shares`,
    ],
    input.validForSeconds ?? 3600,
  )
}

function buildFromPodsBytecode(input: BuildFromPodsBytecodeInput): ConduitRequest {
  if (input.destinationAddress.toLowerCase() !== input.treasury.toLowerCase()) {
    throw new Error(
      `Pods destinationAddress ${input.destinationAddress} is not the treasury ${input.treasury}: Pods maps it to onBehalfOf/to, so the position would belong to someone else`,
    )
  }
  const c = getChain(input.chain)
  return assemble(
    c,
    input.treasury,
    'custom',
    {
      target: input.to,
      data: input.bytecode,
      tokenIn: input.tokenIn,
      amountIn: input.amountIn,
      tokenOut: input.tokenOut,
      minOut: input.minOut,
    },
    symbolOf(c, input.tokenOut),
    [
      `Pods ${input.action}: ${human(input.amountIn)} ${symbolOf(c, input.tokenIn)} through ${input.to} on ${c.key}`,
      `Calldata is Pods' bytecode, reviewed as-is (${input.bytecode.length / 2 - 1} bytes)`,
    ],
    input.validForSeconds ?? 3600,
  )
}

// ─── approve + submit ───────────────────────────────────────────────────────

function authorizationDigest(request: ConduitRequest): Hex {
  const a = request.authorization
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'string' },
        { type: 'address' },
        { type: 'address' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'bytes32' },
      ],
      [
        `${request.chain}:ReceiveWithAuthorization`,
        conduitOf(getChain(request.chain)),
        a.token,
        a.from,
        a.value,
        a.validAfter,
        a.validBefore,
        a.nonce,
      ],
    ),
  )
}

async function approveWithQuorum(request: ConduitRequest, quorum: Quorum, _env: KitEnv): Promise<ApprovedConduitRequest> {
  const t = treasuries.get(ledgerKey(request.chain, request.intent.beneficiary))
  if (!t) throw new Error(`no treasury ${request.intent.beneficiary} on ${request.chain}`)
  const weight = quorum.owners.reduce((sum, o) => {
    const owner = t.owners.find((x) => x.address.toLowerCase() === o.address.toLowerCase())
    if (!owner) throw new Error(`${o.address} is not an owner of the treasury`)
    return sum + owner.weight
  }, 0n)
  if (weight < t.thresholdWeight) throw new Error(`quorum weight ${weight} is under the threshold ${t.thresholdWeight}`)
  const digest = authorizationDigest(request)
  const parts = await Promise.all(sortedOwners(quorum.owners).map((o) => o.signDigest(digest)))
  const quorumSignature = concatHex(parts)
  const calldata = encodeFunctionData({
    abi: CONDUIT_ABI,
    functionName: 'execute',
    args: [request.authorization, quorumSignature, request.intent],
  })
  return { ...request, quorumSignature, calldata }
}

/** The stub's venue: 1 USDC → 0.80 EURC, 1 EURC → 1.25 USDC, vaults mint 1:1. */
function simulateGain(c: TreasuryChain, intent: ConduitIntent, kind: ConduitFacts['kind']): bigint {
  if (kind !== 'swap') return intent.amountIn
  const inSym = symbolOf(c, intent.tokenIn)
  const outSym = symbolOf(c, intent.tokenOut)
  if (inSym === 'USDC' && outSym === 'EURC') return (intent.amountIn * 8000n) / 10000n
  if (inSym === 'EURC' && outSym === 'USDC') return (intent.amountIn * 12500n) / 10000n
  return intent.amountIn
}

async function submitApproved(approved: ApprovedConduitRequest, via: SubmitVia, _env: KitEnv): Promise<ConduitReceipt> {
  const c = getChain(approved.chain)
  const nonceKey = `${approved.chain}:${approved.authorization.nonce}`
  if (usedNonces.has(nonceKey)) throw new Error('authorization already used: this intent was executed once')
  if (nowSeconds() > approved.intent.deadline) throw new Error('intent expired')
  if (via.kind === 'agent' && !via.sessionKey.address) throw new Error('agent submit needs a session key')
  const t = treasuries.get(ledgerKey(approved.chain, approved.intent.beneficiary))
  if (!t) throw new Error(`no treasury on ${approved.chain}`)
  const inKey = approved.intent.tokenIn.toLowerCase()
  const have = t.balances.get(inKey) ?? 0n
  if (have < approved.intent.amountIn) throw new Error(`insufficient ${symbolOf(c, approved.intent.tokenIn)}: have ${human(have)}`)
  const gained = simulateGain(c, approved.intent, approved.facts.kind)
  if (gained < approved.intent.minOut) throw new Error(`BelowFloor: venue would return ${human(gained)}, floor is ${human(approved.intent.minOut)}`)
  usedNonces.add(nonceKey)
  t.balances.set(inKey, have - approved.intent.amountIn)
  const outKey = approved.intent.tokenOut.toLowerCase()
  t.balances.set(outKey, (t.balances.get(outKey) ?? 0n) + gained)
  txCounter += 1
  return {
    chain: approved.chain,
    txHash: keccak256(concatHex([approved.calldata, toHex(txCounter)])),
    gained,
    tokenOut: approved.intent.tokenOut,
  }
}

/** The stub bound to the kit contract. */
export const stubKit: TreasuryKit = {
  CHAINS: STUB_CHAINS,
  getChain,
  withConduit,
  localKeySigner,
  deployTreasury,
  treasuryStatus,
  conduitExecutorGrant,
  deployAgentFace,
  intentNonce,
  buildSwapRequest,
  buildEarnDepositRequest,
  buildFromPodsBytecode,
  approveWithQuorum,
  submitApproved,
}
