#!/usr/bin/env bun

/**
 * Generate the manifest for one chain from subgraph.template.yaml +
 * chain.config.json, run codegen + build, and (unless --build-only) deploy it
 * to Subgraph Studio.
 *
 *   bun run build                                      # arc-testnet, build only
 *   bun run deploy -- arc-testnet=bufi-arc-testnet --version v0.1.0
 *
 * `graph auth <deploy key>` must have run once on this machine. Adapted from
 * Space Object's hackathon deploy script (used with permission).
 */

import chains from '../chain.config.json';

const DEFAULT_CHAIN = 'arc-testnet';
const options = parseArgs(Bun.argv.slice(2));

for (const target of options.targets) {
  const chain = requireChain(target.chain, options.buildOnly);
  const manifest = await generateManifest(target.chain, chain);

  console.log(`\nBuilding ${target.chain} (${chain.chainId})`);
  await run(['bunx', 'graph', 'codegen', manifest]);
  await run(['bunx', 'graph', 'build', manifest]);

  if (options.buildOnly) continue;

  console.log(`Deploying ${target.chain} to ${target.slug}`);
  await run([
    'bunx',
    'graph',
    'deploy',
    target.slug,
    manifest,
    '--node',
    'https://api.studio.thegraph.com/deploy/',
    '--version-label',
    options.version,
  ]);
}

type Chain = (typeof chains)[keyof typeof chains];

function parseArgs(args: string[]) {
  const versionIndex = args.indexOf('--version');
  const version = versionIndex === -1 ? 'dev' : args[versionIndex + 1];
  const buildOnly = args.includes('--build-only');
  if (!version) fail('Pass a value after --version.');

  const targets = args
    .filter((argument, index) => {
      if (argument === '--build-only' || argument === '--version') return false;
      return versionIndex === -1 || index !== versionIndex + 1;
    })
    .map(argument => {
      const [chain, slug, extra] = argument.split('=');
      if (!chain || extra !== undefined)
        fail(`Invalid target "${argument}". Use chain=studio-slug.`);
      if (!buildOnly && !slug)
        fail(`Missing Studio slug for "${chain}". Use ${chain}=studio-slug.`);
      return { chain: chain as string, slug: slug ?? '' };
    });

  if (targets.length === 0 && !buildOnly) fail('Pass at least one chain=studio-slug target.');
  return {
    buildOnly,
    targets: targets.length === 0 ? [{ chain: DEFAULT_CHAIN, slug: '' }] : targets,
    version: version as string,
  };
}

function requireChain(name: string, buildOnly: boolean): Chain {
  if (!(name in chains))
    fail(`Unknown chain "${name}". Available: ${Object.keys(chains).join(', ')}.`);
  const chain = chains[name as keyof typeof chains];
  if (!buildOnly && !/^0x[0-9a-fA-F]{40}$/.test(chain.contracts.agenticCommerce.address)) {
    fail(`No ERC-8183 escrow known for "${name}" yet — see scripts/generate-chain-config.ts.`);
  }
  return chain;
}

async function generateManifest(name: string, chain: Chain) {
  const escrow =
    chain.contracts.agenticCommerce.address || '0x0000000000000000000000000000000000000000';
  const replacements: Record<string, string | number> = {
    network: chain.network,
    chainId: chain.chainId,
    paymentToken: chain.paymentToken,
    identityAddress: chain.contracts.identity.address,
    identityStartBlock: chain.contracts.identity.startBlock,
    reputationAddress: chain.contracts.reputation.address,
    reputationStartBlock: chain.contracts.reputation.startBlock,
    agenticCommerceAddress: escrow,
    agenticCommerceStartBlock: chain.contracts.agenticCommerce.startBlock,
  };
  const template = await Bun.file(new URL('../subgraph.template.yaml', import.meta.url)).text();
  const manifest = Object.entries(replacements).reduce(
    (contents, [key, value]) => contents.replaceAll(`{{${key}}}`, String(value)),
    template
  );
  if (manifest.split('\n').some(line => !line.trimStart().startsWith('#') && line.includes('{{'))) {
    fail('The manifest has an unknown template value.');
  }
  const output = `.generated/${name}/subgraph.yaml`;
  await Bun.write(output, manifest);
  return output;
}

async function run(command: string[]) {
  const subprocess = Bun.spawn(command, { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
  if ((await subprocess.exited) !== 0) process.exit(1);
}

function fail(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(1);
}
