#!/usr/bin/env bun

/**
 * Generate the manifest for one chain from subgraph.template.yaml +
 * chain.config.json, run codegen + build, and (unless --build-only) deploy it
 * to Subgraph Studio.
 *
 *   bun run build                                      # arc-testnet, build only
 *   bun run deploy -- arc-testnet=bufi-arc-testnet --version v0.1.0
 *   bun run deploy -- arc-testnet=bufi-eth-online --version v0.1.1 \
 *     --graft QmBase…:45306948                         # resume a fixed index
 *
 * `--graft <deployment>:<block>` copies the base deployment's state up to
 * `block` instead of re-indexing from the start blocks — hours saved when a
 * handler fix only has to reprocess what came after. Grafted versions are
 * for Studio; a version published to the network should be a clean sync.
 *
 * `graph auth <deploy key>` must have run once on this machine. Adapted from
 * Space Object's hackathon deploy script (used with permission).
 */

import chains from '../chain.config.json';

const DEFAULT_CHAIN = 'arc-testnet';
const options = parseArgs(Bun.argv.slice(2));

for (const target of options.targets) {
  const chain = requireChain(target.chain, options.buildOnly);
  const manifest = await generateManifest(target.chain, chain, options.graft);

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

type Graft = { base: string; block: number };

function parseArgs(args: string[]) {
  const versionIndex = args.indexOf('--version');
  const version = versionIndex === -1 ? 'dev' : args[versionIndex + 1];
  const buildOnly = args.includes('--build-only');
  if (!version) fail('Pass a value after --version.');
  const graftIndex = args.indexOf('--graft');
  const graft = graftIndex === -1 ? null : parseGraft(args[graftIndex + 1]);

  const targets = args
    .filter((argument, index) => {
      if (['--build-only', '--version', '--graft'].includes(argument)) return false;
      if (versionIndex !== -1 && index === versionIndex + 1) return false;
      if (graftIndex !== -1 && index === graftIndex + 1) return false;
      return true;
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
    graft,
    targets: targets.length === 0 ? [{ chain: DEFAULT_CHAIN, slug: '' }] : targets,
    version: version as string,
  };
}

function parseGraft(value: string | undefined): Graft {
  const [base, block] = (value ?? '').split(':');
  if (!base || !/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(base) || !block || !/^\d+$/.test(block)) {
    fail('Pass --graft <base deployment Qm…>:<block>.');
  }
  return { base, block: Number(block) };
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

async function generateManifest(name: string, chain: Chain, graft: Graft | null) {
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
  let manifest = Object.entries(replacements).reduce(
    (contents, [key, value]) => contents.replaceAll(`{{${key}}}`, String(value)),
    template
  );
  if (graft) {
    const features = 'features:\n  - fullTextSearch\n';
    if (!manifest.includes(features)) fail('The template features block moved; update --graft.');
    manifest = manifest.replace(
      features,
      `${features}  - grafting\ngraft:\n  base: ${graft.base}\n  block: ${graft.block}\n`
    );
  }
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
