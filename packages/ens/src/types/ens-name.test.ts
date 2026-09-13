import {
  buildAgenticEnsName,
  buildFaceEnsName,
  buildWorkspaceEnsName,
  ENS_PARENT,
} from './ens-name';
import { buildFaceTag, buildRootTag, mapWorkspaceToEnsv2Preview } from './wallet-tags';
import { describe, expect, it } from 'bun:test';

/**
 * ENS labels are hierarchical right to left. A `.bufi` tag is a flat handle and
 * is not, which is why `ensName` is NOT `tag + '.eth'` for face rows. This file
 * pins the divergence so nobody "simplifies" it back into an inverted tree.
 */
describe('ENS name construction', () => {
  it('keeps the workspace at the top of its own subtree', () => {
    expect(buildWorkspaceEnsName('acme')).toBe('acme.bufi.eth');
  });

  it('puts the FACE first, so the face is a child of the workspace', () => {
    expect(buildFaceEnsName('acme', 'treasury')).toBe('treasury.acme.bufi.eth');
    expect(buildFaceEnsName('acme', 'agent')).toBe('agent.acme.bufi.eth');
  });

  it('nests agentic discovery faces under `agent`', () => {
    expect(buildAgenticEnsName('acme', 'mcp')).toBe('mcp.agent.acme.bufi.eth');
  });

  it('DELIBERATELY diverges from the frozen `.bufi` tag scheme', () => {
    // The tag reads "acme's treasury handle" and is frozen by plan 204.
    expect(buildFaceTag('acme', 'treasury')).toBe('acme.treasury.bufi');
    // Appending `.eth` to that tag would read "acme is a child of
    // treasury.bufi.eth" — the workspace parented to its own face.
    expect(buildFaceEnsName('acme', 'treasury')).not.toBe(
      `${buildFaceTag('acme', 'treasury')}.eth`
    );
    // The workspace ROOT is the one case where they legitimately coincide.
    expect(buildWorkspaceEnsName('acme')).toBe(`${buildRootTag('acme')}.eth`);
  });

  it('never emits a name whose first label is the workspace on a face row', () => {
    for (const row of mapWorkspaceToEnsv2Preview('acme')) {
      if (row.kind !== 'face') continue;
      expect(row.ensName.startsWith('acme.')).toBe(false);
      expect(row.ensName.endsWith(`.acme.${ENS_PARENT}`)).toBe(true);
    }
  });

  it('routes every generated name through the single parent constant', () => {
    // Changing the parent must be a one-line edit, so nothing may hardcode
    // `.eth` alongside a tag.
    for (const row of mapWorkspaceToEnsv2Preview('acme')) {
      expect(row.ensName.endsWith(`.${ENS_PARENT}`)).toBe(true);
    }
  });
});
