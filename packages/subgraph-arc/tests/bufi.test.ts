import { Address, BigInt } from '@graphprotocol/graph-ts';
import { assert, describe, test } from 'matchstick-as';

import { Agent } from '../generated/schema';
import { engagementId } from '../src/bufi/engagement';
import { jobEntityId } from '../src/commerce/job';
import { agentEntityId } from '../src/identity/agent';

// Matchstick 0.6 cannot persist entities with Timestamp fields (LimeChain
// #433), so these cover the id rules the BUFI joins depend on; handler
// behaviour is asserted live after deploy (plan 342 S3).
const CHAIN = BigInt.fromI32(5042002);
const IDENTITY = Address.fromString('0x8004A818BFB912233c491871b3d84c89A494BD9e');
const ESCROW = Address.fromString('0x0747EEf0706327138c69792bF28Cd525089e4583');

describe('chain-scoped ids', () => {
  test("agent and job ids are '<chain>:<contract>:<n>' as UTF-8 bytes", () => {
    assert.stringEquals(
      '5042002:0x8004a818bfb912233c491871b3d84c89a494bd9e:894551',
      agentEntityId(CHAIN, IDENTITY, BigInt.fromI32(894551)).toString()
    );
    assert.stringEquals(
      '5042002:0x0747eef0706327138c69792bf28cd525089e4583:182422',
      jobEntityId(CHAIN, ESCROW, BigInt.fromI32(182422)).toString()
    );
  });

  test('engagement ids are directed: client→provider differs from provider→client', () => {
    const a = new Agent(agentEntityId(CHAIN, IDENTITY, BigInt.fromI32(1)));
    const b = new Agent(agentEntityId(CHAIN, IDENTITY, BigInt.fromI32(2)));
    assert.assertTrue(engagementId(a, b).notEqual(engagementId(b, a)));
    assert.bytesEquals(engagementId(a, b), engagementId(a, b));
  });
});
