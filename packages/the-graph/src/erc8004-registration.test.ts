import { fromBase64 } from './base64';
import {
  AGENT_REGISTRATION_MAX_BYTES,
  AGENT_REGISTRATION_TYPE,
  buildAgentRegistrationDataUri,
  buildAgentRegistrationDocument,
  deskAgentServices,
  isAgentRegistrationDataUri,
} from './erc8004-registration';
import { describe, expect, it } from 'bun:test';

const BASE = {
  name: '  Arc   Argentina  ',
  description: 'Invoices, payroll and contracts for LATAM teams.\n\nSettles on Arc.',
  appUrl: 'https://desk.bu.finance/',
  teamId: '57cf6dcc-3f55-4cbf-a8fc-e54b81e05dd2',
  chainId: 5042002,
  identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
};

describe('buildAgentRegistrationDocument', () => {
  it('produces the 8004scan profile shape the subgraph parses', () => {
    const doc = buildAgentRegistrationDocument(BASE);
    expect(doc.type).toBe(AGENT_REGISTRATION_TYPE);
    expect(doc.name).toBe('Arc Argentina');
    expect(doc.description).toBe(
      'Invoices, payroll and contracts for LATAM teams. Settles on Arc.'
    );
    expect(doc.active).toBe(true);
    expect(doc.supportedTrust).toEqual(['reputation']);
    expect(doc.registrations).toEqual([
      { agentRegistry: 'eip155:5042002:0x8004a818bfb912233c491871b3d84c89a494bd9e' },
    ]);
    expect(doc.services.map(s => s.name)).toEqual(['web', 'a2a', 'x402']);
    expect(doc.services[0]?.endpoint).toBe(
      'https://desk.bu.finance/api/public/agents/57cf6dcc-3f55-4cbf-a8fc-e54b81e05dd2/profile'
    );
  });

  it('adds the agentId to registrations once known and appends extra services', () => {
    const doc = buildAgentRegistrationDocument({
      ...BASE,
      agentId: '894551',
      services: [{ name: 'mcp', endpoint: 'https://shiva.bu.finance/mcp', version: '2025-06-18' }],
    });
    expect(doc.registrations[0]?.agentId).toBe('894551');
    expect(doc.services.at(-1)).toEqual({
      name: 'mcp',
      endpoint: 'https://shiva.bu.finance/mcp',
      version: '2025-06-18',
    });
  });

  it('drops a non-https image (storage paths and signed URLs never go on-chain) and empty text', () => {
    const doc = buildAgentRegistrationDocument({
      ...BASE,
      description: '   ',
      image: 'avatars/team/logo.png',
    });
    expect(doc.description).toBeUndefined();
    expect(doc.image).toBeUndefined();
    expect(
      buildAgentRegistrationDocument({ ...BASE, image: 'https://cdn.bu.finance/logo.png' }).image
    ).toBe('https://cdn.bu.finance/logo.png');
  });

  it('refuses an empty name and omits registrations without a registry', () => {
    expect(() => buildAgentRegistrationDocument({ ...BASE, name: ' ' })).toThrow(
      'ERC8004_REGISTRATION_NAME_REQUIRED'
    );
    expect(
      buildAgentRegistrationDocument({ ...BASE, chainId: undefined, identityRegistry: undefined })
        .registrations
    ).toEqual([]);
  });
});

describe('buildAgentRegistrationDataUri', () => {
  it('is a base64 JSON data URI that round-trips and is deterministic', () => {
    const uri = buildAgentRegistrationDataUri(BASE);
    expect(isAgentRegistrationDataUri(uri)).toBe(true);
    expect(uri).toBe(buildAgentRegistrationDataUri(BASE));
    const decoded = JSON.parse(fromBase64(uri.slice('data:application/json;base64,'.length)));
    expect(decoded).toEqual(buildAgentRegistrationDocument(BASE));
    expect(uri.length).toBeLessThan(AGENT_REGISTRATION_MAX_BYTES);
  });

  it('caps oversized documents instead of minting them', () => {
    expect(() =>
      buildAgentRegistrationDataUri({
        ...BASE,
        services: Array.from({ length: 60 }, (_, i) => ({
          name: `custom-${i}`,
          endpoint: `https://example.com/${'x'.repeat(60)}/${i}`,
        })),
      })
    ).toThrow('ERC8004_REGISTRATION_TOO_LARGE');
  });
});

describe('deskAgentServices', () => {
  it('tolerates a trailing slash on the app URL', () => {
    expect(deskAgentServices('https://x.test///', 't')[1]?.endpoint).toBe(
      'https://x.test/api/public/agents/t/agent-card.json'
    );
  });
});
