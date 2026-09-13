import {
  agentEntityId,
  chainScopedEntityId,
  decodeChainScopedEntityId,
  feedbackEntityId,
  InvalidEntityIdInputError,
  jobEntityId,
  registryEntityId,
} from './ids';
import { describe, expect, test } from 'bun:test';

// Live ids observed on The Graph gateway, 2026-09-13.
const ARC_TESTNET = 5042002;
const IDENTITY_REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
const LIVE_REGISTRY_ID =
  '0x353034323030323a307838303034613831386266623931323233336334393138373162336438346338396134393462643965';
const LIVE_FEEDBACK_ID =
  '0x353034323030323a3078383030346236363330353661353937646666653965636363313936356131393362373338383731333a3837373732333a3078623664613232336339363939646564653433356565336134393338646366313234656662343437333a31';
const CIRCLE_8183 = '0x0747EEf0706327138c69792bF28Cd525089e4583';

describe('chainScopedEntityId', () => {
  test('matches the live identity registry id byte for byte', () => {
    expect(registryEntityId(ARC_TESTNET, IDENTITY_REGISTRY)).toBe(LIVE_REGISTRY_ID);
  });

  test('lowercases the address and joins parts with ":"', () => {
    const id = agentEntityId(ARC_TESTNET, IDENTITY_REGISTRY, '894551');
    expect(decodeChainScopedEntityId(id)).toEqual({
      chainId: ARC_TESTNET,
      address: IDENTITY_REGISTRY.toLowerCase(),
      parts: ['894551'],
    });
    expect(id.startsWith('0x')).toBe(true);
  });

  test('accepts bigint and number parts and chain ids', () => {
    expect(jobEntityId(5042002n, CIRCLE_8183, 182422n)).toBe(
      jobEntityId('5042002', CIRCLE_8183, '182422')
    );
    expect(decodeChainScopedEntityId(jobEntityId(ARC_TESTNET, CIRCLE_8183, 182422)).parts).toEqual([
      '182422',
    ]);
  });

  test('rejects a non-address contract and a non-numeric chain id', () => {
    expect(() => chainScopedEntityId(ARC_TESTNET, 'not-an-address')).toThrow(
      InvalidEntityIdInputError
    );
    expect(() => chainScopedEntityId('arc', IDENTITY_REGISTRY)).toThrow(InvalidEntityIdInputError);
  });
});

describe('feedbackEntityId', () => {
  test('reproduces a live feedback id, client address lowercased', () => {
    const decoded = decodeChainScopedEntityId(LIVE_FEEDBACK_ID);
    expect(decoded.chainId).toBe(ARC_TESTNET);
    expect(decoded.parts).toHaveLength(3);
    const [agentId, client, feedbackIndex] = decoded.parts;
    expect(
      feedbackEntityId(
        ARC_TESTNET,
        decoded.address,
        agentId as string,
        (client as string).toUpperCase().replace('0X', '0x'),
        feedbackIndex as string
      )
    ).toBe(LIVE_FEEDBACK_ID);
  });
});

describe('decodeChainScopedEntityId', () => {
  test('rejects hex that does not decode to a chain-scoped id', () => {
    expect(() => decodeChainScopedEntityId('0x68656c6c6f')).toThrow(InvalidEntityIdInputError);
    expect(() => decodeChainScopedEntityId('0xzz')).toThrow(InvalidEntityIdInputError);
  });
});
