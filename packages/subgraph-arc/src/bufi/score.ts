import { BigInt, Bytes, json } from '@graphprotocol/graph-ts';

import { Agent } from '../../generated/schema';
import { asObject, asString, asWholeI32 } from '../shared/json';

/**
 * BUFI: the payment-score attestation a workspace publishes on its own
 * identity (`payment-score-attestation.service.ts` in desk):
 *
 *   setMetadata(agentId, "bufi.score.v1", bytes(JSON {v, d, s, h}))
 *
 * `s` is the score, `d` the snapshot date, `h` the sha256 of the canonical
 * snapshot the workspace can later reveal, `v` the shape version. Owner-only
 * on the registry, so only the workspace's own agent wallet can write it —
 * which is exactly why it is worth indexing: a counterparty reads it here
 * without trusting BUFI's API.
 */
export const BUFI_SCORE_KEY = 'bufi.score.v1';

export function applyScoreAttestation(agent: Agent, value: Bytes, timestamp: BigInt): void {
  const parsed = json.try_fromString(value.toString());
  if (!parsed.isOk) return;
  const obj = asObject(parsed.value);
  if (obj == null) return;

  const score = asWholeI32(obj.get('s'), 0, 100000);
  if (!score.present) return;

  agent.bufiScore = BigInt.fromI32(score.value);
  const version = asWholeI32(obj.get('v'), 0, 1000);
  agent.bufiScoreVersion = version.present ? BigInt.fromI32(version.value) : null;
  agent.bufiScoreDate = asString(obj.get('d'));
  agent.bufiScoreHash = hashBytes(asString(obj.get('h')));
  agent.bufiScoreUpdatedAt = timestamp.toI64();
}

function hashBytes(value: string | null): Bytes | null {
  if (!value) return null;
  const text = value!;
  const hex = text.startsWith('0x') ? text : '0x' + text;
  if (hex.length != 66) return null;
  for (let i = 2; i < hex.length; i++) {
    const c = hex.charCodeAt(i);
    const isHex = (c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70);
    if (!isHex) return null;
  }
  return Bytes.fromHexString(hex);
}
