#!/usr/bin/env bun

/**
 * chain.config.json is GENERATED — never edit it by hand. In the product
 * monorepo the addresses come from `@bu/contracts/erc8004` and `@bu/env/ace`;
 * this standalone copy inlines the same truth below.
 * Start blocks are the contracts' creation blocks read from the Arc explorer on
 * 2026-09-13 (proxy creation transactions), pinned here because they are not
 * derivable from code. A chain may also carry an INDEX FLOOR, which is what the
 * manifest actually uses — see `INDEX_FLOOR` below. The mainnet escrow is unknown until Circle publishes it;
 * a chain with an empty escrow address is skipped by scripts/deploy.ts.
 */

/**
 * Standalone copy: in the product monorepo these come from `@bu/contracts/erc8004`
 * and `@bu/env/ace`. ERC-8004 registries are per NETWORK TYPE (one testnet pair,
 * one mainnet pair, ERC-1967 proxies); the ERC-8183 escrow is Circle's Arc
 * deployment. Arc mainnet chain id per The Graph's networks registry.
 */
const ERC8004_CHAINS = {
  'arc-testnet': {
    chainId: 5042002,
    identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
    reputationRegistry: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
  },
  arc: {
    chainId: 5042,
    identityRegistry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
    reputationRegistry: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
  },
} as const;
const ESCROW: Record<'arc-testnet' | 'arc', string> = {
  'arc-testnet': '0x0747EEf0706327138c69792bF28Cd525089e4583',
  // Unknown until Circle publishes the mainnet AgenticCommerce address.
  arc: '',
};

const START_BLOCKS: Record<string, { identity: number; reputation: number; escrow: number }> = {
  'arc-testnet': { identity: 29241340, reputation: 29241344, escrow: 33908011 },
  // Arc mainnet (eip155:5042) — registries per Space Object's reconnaissance,
  // escrow unknown; both must be re-verified against the explorer at launch.
  arc: { identity: 13344062, reputation: 13344072, escrow: 0 },
};

/**
 * The earliest block the index actually reads, when it is later than a
 * contract's creation block.
 *
 * Arc testnet's registries are SHARED, and between their creation (29.2M) and
 * 2026-08-30 they accumulated a hackathon's worth of third-party traffic —
 * dense enough that `eth_getLogs` refuses a 10,000-block window around block
 * 52M, and measured at ~600 blocks/minute of indexing through it. Syncing that
 * stretch takes roughly two weeks and yields nothing of BUFI's: every BUFI
 * identity was minted on or after 2026-08-30 03:25 UTC and the first BUFI job
 * the same day, both above block 59.5M.
 *
 * 59,400,000 is 2026-08-29, a few hours of margin before the first mint. The
 * index therefore holds all of BUFI's history plus every third party active
 * since then, and reaches the chain head in about an hour.
 *
 * Raising this is cheap and lowering it is not: a lower floor is a full
 * re-sync. If BUFI ever needs the older third-party agents for discovery,
 * deploy that as a SEPARATE Studio subgraph rather than re-cutting this one,
 * so the live one keeps serving while the deep one catches up.
 */
const INDEX_FLOOR: Record<string, number> = {
  'arc-testnet': 59_400_000,
};

function startBlock(chainKey: string, creationBlock: number): number {
  const floor = INDEX_FLOOR[chainKey];
  return floor === undefined ? creationBlock : Math.max(creationBlock, floor);
}

/** Arc settles in USDC; on Arc it is the native gas token exposed at this address. */
const ARC_USDC = '0x3600000000000000000000000000000000000000';

function escrowFor(key: 'arc-testnet' | 'arc'): string {
  return ESCROW[key];
}

const config: Record<string, unknown> = {};
for (const key of ['arc-testnet', 'arc'] as const) {
  const chain = ERC8004_CHAINS[key];
  const blocks = START_BLOCKS[key];
  if (!blocks) throw new Error(`no start blocks recorded for ${key}`);
  config[key] = {
    network: key,
    chainId: chain.chainId,
    paymentToken: ARC_USDC,
    contracts: {
      identity: { address: chain.identityRegistry, startBlock: startBlock(key, blocks.identity) },
      reputation: { address: chain.reputationRegistry, startBlock: startBlock(key, blocks.reputation) },
      agenticCommerce: { address: escrowFor(key), startBlock: startBlock(key, blocks.escrow) },
    },
  };
}

await Bun.write(
  new URL('../chain.config.json', import.meta.url),
  `${JSON.stringify(config, null, 2)}\n`
);
console.log('chain.config.json written for', Object.keys(config).join(', '));
