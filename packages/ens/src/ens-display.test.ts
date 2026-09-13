import { ENS_PRODUCT_SUFFIX, ensDisplayName, isEnsProductName } from './ens-display';
import { describe, expect, it } from 'bun:test';

describe('ENS display gate', () => {
  it('shows a name only when it was MEASURED resolvable', () => {
    expect(ensDisplayName('acme.bufi.eth', 'resolvable')).toBe('acme.bufi.eth');
    expect(ensDisplayName('acme.bufi.eth', 'reserved')).toBeNull();
    expect(ensDisplayName('acme.bufi.eth', 'revoked')).toBeNull();
  });

  it('fails closed on an absent or unrecognised state', () => {
    // The old gate was a boolean, so anything truthy showed the name. An
    // unknown state must never fall through into "show it".
    expect(ensDisplayName('acme.bufi.eth', null)).toBeNull();
    expect(ensDisplayName('acme.bufi.eth', undefined)).toBeNull();
    expect(ensDisplayName('acme.bufi.eth', 'minted')).toBeNull();
    expect(ensDisplayName('acme.bufi.eth', 'true')).toBeNull();
    expect(ensDisplayName('acme.bufi.eth', '')).toBeNull();
  });

  it('has no name to show without a name', () => {
    expect(ensDisplayName(null, 'resolvable')).toBeNull();
    expect(ensDisplayName(undefined, 'resolvable')).toBeNull();
    expect(ensDisplayName('', 'resolvable')).toBeNull();
  });

  it('recognises product names, including the face-first shapes', () => {
    expect(isEnsProductName('acme.bufi.eth')).toBe(true);
    expect(isEnsProductName('operations.acme.bufi.eth')).toBe(true);
    expect(isEnsProductName('mcp.agent.acme.bufi.eth')).toBe(true);
    expect(isEnsProductName('acme.bufi')).toBe(false);
    expect(ENS_PRODUCT_SUFFIX).toBe('.bufi.eth');
  });
});
