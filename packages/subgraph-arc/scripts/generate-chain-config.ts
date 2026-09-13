#!/usr/bin/env bun

/**
 * chain.config.json is GENERATED — never edit it by hand. In the product
 * monorepo the addresses come from `@bu/contracts/erc8004` and `@bu/env/ace`;
 * this standalone copy inlines the same truth below.
 * Start blocks are the contracts' creation blocks read from the Arc explorer on
 * 2026-09-13 (proxy creation transactions), pinned here because they are not
 * derivable from code. The mainnet escrow is unknown until Circle publishes it;
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
      identity: { address: chain.identityRegistry, startBlock: blocks.identity },
      reputation: { address: chain.reputationRegistry, startBlock: blocks.reputation },
      agenticCommerce: { address: escrowFor(key), startBlock: blocks.escrow },
    },
  };
}

await Bun.write(
  new URL('../chain.config.json', import.meta.url),
  `${JSON.stringify(config, null, 2)}\n`
);
console.log('chain.config.json written for', Object.keys(config).join(', '));
