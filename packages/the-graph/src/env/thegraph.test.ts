import {
  getGraphGatewayApiKey,
  getSubgraphRef,
  hasGraphGatewayApiKey,
  MissingSubgraphError,
  subgraphEnvKey,
  subgraphQueryUrl,
  subgraphQueryUrlNeedsApiKey,
  THEGRAPH_GATEWAY_URL,
} from './thegraph';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

const ENV_KEYS = [
  'GRAPH_GATEWAY_API_KEY',
  'THEGRAPH_ARC_TESTNET_QUERY_URL',
  'THEGRAPH_ARC_TESTNET_SUBGRAPH_ID',
  'THEGRAPH_ARC_TESTNET_DEPLOYMENT_ID',
  'THEGRAPH_ERC8004_ARC_TESTNET_SUBGRAPH_ID',
  'THEGRAPH_ERC8004_ARC_TESTNET_DEPLOYMENT_ID',
  'THEGRAPH_ERC8183_ARC_TESTNET_SUBGRAPH_ID',
  'THEGRAPH_ERC8183_ARC_TESTNET_DEPLOYMENT_ID',
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('getGraphGatewayApiKey', () => {
  test('throws naming the variable when unset', () => {
    expect(hasGraphGatewayApiKey()).toBe(false);
    expect(() => getGraphGatewayApiKey()).toThrow('GRAPH_GATEWAY_API_KEY');
  });

  test('override wins over the environment', () => {
    process.env.GRAPH_GATEWAY_API_KEY = 'from-env';
    expect(getGraphGatewayApiKey()).toBe('from-env');
    expect(getGraphGatewayApiKey('from-override')).toBe('from-override');
    expect(hasGraphGatewayApiKey()).toBe(true);
  });
});

describe('subgraphEnvKey', () => {
  test('upper-cases the kind and replaces the chain hyphen', () => {
    expect(subgraphEnvKey('erc8183', 'arc-testnet', 'SUBGRAPH_ID')).toBe(
      'THEGRAPH_ERC8183_ARC_TESTNET_SUBGRAPH_ID'
    );
    expect(subgraphEnvKey('erc8004', 'arc', 'DEPLOYMENT_ID')).toBe(
      'THEGRAPH_ERC8004_ARC_DEPLOYMENT_ID'
    );
  });
});

describe('getSubgraphRef', () => {
  test('erc8004 on arc-testnet has NO default until the BUFI deployment exists: a third-party index is never a default', () => {
    const ref = getSubgraphRef('erc8004');
    expect(ref).toEqual({
      kind: 'erc8004',
      chain: 'arc-testnet',
      chainId: 5042002,
      subgraphId: null,
      deploymentId: null,
      queryUrl: null,
    });
    expect(() => subgraphQueryUrl(ref)).toThrow('THEGRAPH_ARC_TESTNET_SUBGRAPH_ID');
  });

  test('a Studio query URL wins over every id and needs no gateway id at all', () => {
    process.env.THEGRAPH_ARC_TESTNET_QUERY_URL =
      'https://api.studio.thegraph.com/query/1760286/bufi-eth-online/v0.1.0';
    process.env.THEGRAPH_ARC_TESTNET_DEPLOYMENT_ID = 'QmPinned';
    for (const kind of ['erc8004', 'erc8183'] as const) {
      expect(subgraphQueryUrl(getSubgraphRef(kind))).toBe(
        'https://api.studio.thegraph.com/query/1760286/bufi-eth-online/v0.1.0'
      );
    }
  });

  test('one chain-level id serves both kinds: BUFI indexes identity and commerce on one graph', () => {
    process.env.THEGRAPH_ARC_TESTNET_SUBGRAPH_ID = 'BufiArc';
    expect(getSubgraphRef('erc8004').subgraphId).toBe('BufiArc');
    expect(getSubgraphRef('erc8183').subgraphId).toBe('BufiArc');
    expect(subgraphQueryUrl(getSubgraphRef('erc8183'))).toBe(
      `${THEGRAPH_GATEWAY_URL}/subgraphs/id/BufiArc`
    );
  });

  test('a per-kind id wins over the chain-level id, and replaces both chain-level values', () => {
    process.env.THEGRAPH_ARC_TESTNET_SUBGRAPH_ID = 'BufiArc';
    process.env.THEGRAPH_ARC_TESTNET_DEPLOYMENT_ID = 'QmChainPin';
    process.env.THEGRAPH_ERC8183_ARC_TESTNET_SUBGRAPH_ID = 'SplitCommerce';
    expect(getSubgraphRef('erc8004').deploymentId).toBe('QmChainPin');
    const commerce = getSubgraphRef('erc8183');
    expect(commerce.subgraphId).toBe('SplitCommerce');
    expect(commerce.deploymentId).toBeNull();
  });

  test('erc8183 on arc-testnet has NO default either', () => {
    const ref = getSubgraphRef('erc8183', 'arc-testnet');
    expect(ref.subgraphId).toBeNull();
    expect(ref.deploymentId).toBeNull();
    expect(() => subgraphQueryUrl(ref)).toThrow(MissingSubgraphError);
    expect(() => subgraphQueryUrl(ref)).toThrow('THEGRAPH_ERC8183_ARC_TESTNET_SUBGRAPH_ID');
  });

  test('an env subgraph id replaces BOTH defaults so a default deployment pin cannot shadow it', () => {
    process.env.THEGRAPH_ERC8004_ARC_TESTNET_SUBGRAPH_ID = 'BufiSubgraphId';
    const ref = getSubgraphRef('erc8004', 'arc-testnet');
    expect(ref.subgraphId).toBe('BufiSubgraphId');
    expect(ref.deploymentId).toBeNull();
    expect(subgraphQueryUrl(ref)).toBe(`${THEGRAPH_GATEWAY_URL}/subgraphs/id/BufiSubgraphId`);
  });

  test('an env deployment pin is preferred over a subgraph id in the URL', () => {
    process.env.THEGRAPH_ERC8183_ARC_TESTNET_SUBGRAPH_ID = 'Sub';
    process.env.THEGRAPH_ERC8183_ARC_TESTNET_DEPLOYMENT_ID = 'QmPinned';
    const ref = getSubgraphRef('erc8183');
    expect(subgraphQueryUrl(ref)).toBe(`${THEGRAPH_GATEWAY_URL}/deployments/id/QmPinned`);
  });

  test('arc mainnet has no defaults yet and carries the registry chain id', () => {
    const ref = getSubgraphRef('erc8004', 'arc');
    expect(ref.chainId).toBe(5042);
    expect(() => subgraphQueryUrl(ref)).toThrow(MissingSubgraphError);
  });
});

describe('subgraphQueryUrlNeedsApiKey', () => {
  test('the decentralised gateway needs the key; Studio and a local node do not', () => {
    expect(subgraphQueryUrlNeedsApiKey('https://gateway.thegraph.com/api/subgraphs/id/Abc')).toBe(
      true
    );
    expect(
      subgraphQueryUrlNeedsApiKey('https://gateway.thegraph.com/api/deployments/id/QmAbc')
    ).toBe(true);
    // Studio serves without a key — requiring one there throws in production,
    // which deliberately holds no key until a mainnet subgraph exists.
    expect(
      subgraphQueryUrlNeedsApiKey(
        'https://api.studio.thegraph.com/query/1760286/bufi-eth-online/version/latest'
      )
    ).toBe(false);
    expect(subgraphQueryUrlNeedsApiKey('http://localhost:8000/subgraphs/name/bufi')).toBe(false);
  });
});
