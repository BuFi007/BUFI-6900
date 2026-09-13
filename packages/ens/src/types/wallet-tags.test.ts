import {
  deriveAgenticFaceSet,
  mapWorkspaceToEnsv2Preview,
  resolveWorkspaceTagSuggestedLabel,
  slugifyTagLabel,
} from './wallet-tags';
import { describe, expect, test } from 'bun:test';

describe('resolveWorkspaceTagSuggestedLabel', () => {
  test('uses the primary team name, never the person', () => {
    expect(
      resolveWorkspaceTagSuggestedLabel({
        teamName: 'Acme Labs',
        userFullName: 'Ada Lovelace',
      })
    ).toBe('acmelabs');
  });

  test('prefers the legal business name over a person-shaped display name', () => {
    expect(
      resolveWorkspaceTagSuggestedLabel({
        teamName: 'Ada Lovelace',
        legalName: 'Acme Labs SRL',
        userFullName: 'Ada Lovelace',
      })
    ).toBe('acmelabssrl');
  });

  test('never seeds a workspace handle from the person alone', () => {
    expect(
      resolveWorkspaceTagSuggestedLabel({
        userFullName: 'Ada Lovelace',
      })
    ).toBe('');
  });

  test('still uses the team name when it happens to match the person', () => {
    expect(
      resolveWorkspaceTagSuggestedLabel({
        teamName: 'Ada Lovelace',
        userFullName: 'Ada Lovelace',
      })
    ).toBe(slugifyTagLabel('Ada Lovelace'));
  });

  /**
   * The claim step is only ever REACHED because `createTeamAction` refused to
   * auto-claim the slug (too short, all punctuation, or reserved). Suggesting
   * that same slug back hands the user a handle the Claim button can never
   * enable — the field is prefilled, looks legitimate, and is permanently
   * unclaimable. See `create-team-action.ts` (`isClaimableTagLabel` gate).
   */
  test('never suggests a reserved label', () => {
    expect(
      resolveWorkspaceTagSuggestedLabel({
        teamName: 'BUFI',
        userFullName: 'Ada Lovelace',
      })
    ).toBe('');
  });

  test('never suggests a label the format rules reject', () => {
    // Two characters — under WALLET_TAG_MIN_LENGTH, so `validateTagLabel`
    // answers `format` and the claim stays disabled forever.
    expect(
      resolveWorkspaceTagSuggestedLabel({
        teamName: 'Hi',
        userFullName: 'Ada Lovelace',
      })
    ).toBe('');
  });

  test('falls through to the next claimable candidate', () => {
    // Legal name wins normally, but `agent` is a reserved face subtag, so the
    // team name is the first candidate that could actually be claimed.
    expect(
      resolveWorkspaceTagSuggestedLabel({
        teamName: 'Arc Argentina',
        legalName: 'Agent',
        userFullName: 'Ada Lovelace',
      })
    ).toBe('arcargentina');
  });
});

describe('ENSv2 preview mapping (Plan 313)', () => {
  test('agentic faces sit under agent and carry the full .bufi.eth name', () => {
    const faces = deriveAgenticFaceSet('acme');
    expect(faces.map(row => row.ensName)).toEqual([
      'mcp.agent.acme.bufi.eth',
      'webmcp.agent.acme.bufi.eth',
      'x402.agent.acme.bufi.eth',
    ]);
  });

  test('workspace + faces + agentic map to preview names without minting', () => {
    const names = mapWorkspaceToEnsv2Preview('acme');
    expect(names.some(row => row.ensName === 'acme.bufi.eth' && row.kind === 'workspace')).toBe(
      true
    );
    // FACE-FIRST. This previously asserted `acme.agent.bufi.eth`, which reads
    // as "acme is a child of agent.bufi.eth" — the workspace parented to its
    // own face. The agentic assertion above was always face-first, so the two
    // halves of this mapping disagreed. They now agree, and the agentic names
    // nest correctly UNDER this one (`mcp.agent.acme.bufi.eth`).
    expect(names.some(row => row.ensName === 'agent.acme.bufi.eth' && row.kind === 'face')).toBe(
      true
    );
    expect(names.filter(row => row.kind === 'agentic')).toHaveLength(3);
  });
});
