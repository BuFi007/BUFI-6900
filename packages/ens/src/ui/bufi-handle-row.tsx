'use client';

/**
 * One `.bufi` handle row — the ENS selector chrome: check, then the segmented
 * mono field. The 3D coin lives on the card, wearing this face's own art. Face
 * suffixes are derived and locked; the claimable label is edited in the field
 * above, not here.
 *
 * NO ROLE COLUMN. A trailing "Operations" label restated what the `.operations`
 * segment two millimetres to its left already says — the handle IS the role.
 * `faceLabel` survives in the sr-only line beside the lock, so a screen reader
 * still hears the role AND the handle.
 *
 * Hover card wraps the WHOLE row. It used to wrap only the inspect targets
 * (check + role label), on the theory that the mono box reads as an input a
 * card should not hijack — but with the role column gone that left one 14px
 * circle as the only trigger, under a subtitle promising "hover a handle". The
 * box is display-only anyway (typing lives in WorkspaceTagField,
 * `cursor-text`), so the row is the target.
 */

import type { ReactNode } from 'react';

import { Check, Lock } from 'lucide-react';

import { AssetHoverCard } from '@/components/header/asset-hover-card';
import { HandleFaceArt } from '@/components/header/handle-face-art';
import {
  type HandleHoverFace,
  resolveHandleFaceIcon,
  resolveHandleHoverInfo,
} from '@/lib/wallet/handle-hover-info';

import '@/styles/bufi-gradient-text.css';

interface BufiHandleRowProps {
  face: HandleHoverFace;
  /** The claimable segment, e.g. `acme` — never the full tag. */
  label: string;
  faceLabel: string;
  caption: string;
  selected?: boolean;
  onSelect?: () => void;
  muted?: boolean;
  /**
   * Full `*.bufi.eth`, and ONLY a name that has been measured resolvable.
   *
   * Pass the return of `ensDisplayName()` from `@bu/utils/ens-display`, which
   * yields null unless the stored row is `resolution_state = 'resolvable'`.
   * Never pass `row.ens_name` directly: a reserved name resolves nowhere, and
   * rendering it here tells a user their name is live when it is not.
   * Nothing passes this today — no `*.bufi.eth` name resolves anywhere.
   */
  ensName?: string | null;
  /**
   * Where that name resolves, derived from the row (`network`), never a
   * literal. Absent means no badge: an unlabelled name is better than one
   * asserting the wrong chain.
   */
  ensNetworkLabel?: string | null;
  /**
   * Tighter vertical rhythm for stacked previews. The workspace claim shows
   * THREE of these rows plus a field, an identity block, a permanence notice
   * and the CTA, which overflowed a laptop viewport at the default height.
   * Chrome, gaps and type sizes are unchanged — only the row's own padding and
   * the inner field height move, so a dense row still reads as the same
   * control. The default stays comfortable for the single personal row.
   */
  dense?: boolean;
}

function isDerivedFace(face: HandleHoverFace): boolean {
  return face === 'treasury' || face === 'agent';
}

function HandleInspect({
  face,
  label,
  children,
}: {
  face: HandleHoverFace;
  label: string;
  children: ReactNode;
}) {
  return (
    <AssetHoverCard
      info={resolveHandleHoverInfo({ face, tag: null, label })}
      iconUrl={resolveHandleFaceIcon(face)}
      art={<HandleFaceArt face={face} />}
      side="right"
    >
      {children}
    </AssetHoverCard>
  );
}

export function BufiHandleRow({
  face,
  label,
  faceLabel,
  caption,
  selected = false,
  onSelect,
  muted = false,
  ensName = null,
  ensNetworkLabel = null,
  dense = false,
}: BufiHandleRowProps) {
  const derived = isDerivedFace(face);
  // `bufi-handle-row` is a HOOK FOR CSS, not a style: the hover card wraps every
  // row in its own `.ahc-root` span, which is `display: inline-block` and so
  // shrinks to content unless the parent happens to be a stretching flex
  // column. The preview list is one; the personal claim form is a plain div,
  // and its single row rendered half width. See asset-hover-card-overrides.css.
  const rowClassName = `bufi-handle-row group flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-xl border px-2 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purpleDanis focus-visible:ring-offset-2 sm:px-2.5 ${dense ? 'py-0.5' : 'py-1'} ${
    selected
      ? 'border-purpleDanis bg-violetDanis/20 shadow-[0_4px_12px_rgba(107,82,202,0.08)] dark:border-violetDanis dark:bg-violetDanis/15'
      : 'border-transparent bg-white/60 hover:border-borderBufi hover:bg-violetDanis/10 dark:bg-white/5 dark:hover:border-white/20 dark:hover:bg-white/8'
  } ${muted ? 'opacity-70' : ''}`;

  const chrome = (
    <>
      <span
        aria-hidden
        className={`flex size-3.5 shrink-0 cursor-pointer items-center justify-center rounded-full border transition-colors ${
          selected
            ? 'border-purpleDanis bg-purpleDanis text-white'
            : 'border-borderBufi text-transparent group-hover:border-purpleDanis dark:border-white/25'
        }`}
      >
        <Check className="size-2.5" strokeWidth={3} />
      </span>

      <div
        className={`flex min-w-0 flex-1 cursor-pointer items-center rounded-lg border font-mono text-xs tracking-[-0.02em] transition-colors ${dense ? 'h-7' : 'h-8'} ${
          selected
            ? 'border-borderBufi bg-white/80 dark:border-violetDanis/40 dark:bg-white/10'
            : 'border-borderFine bg-white/50 group-hover:border-borderBufi dark:border-white/12 dark:bg-white/5'
        }`}
      >
        {derived ? (
          <span className="ml-1 flex size-4 shrink-0 items-center justify-center text-purpleDanis dark:text-violetDanis">
            <Lock className="size-2.5" strokeWidth={2} aria-hidden />
            {/* Carries the role the visible column used to. NOT an `aria-label`
                on the row: that would REPLACE the name computed from the
                handle text, so the reader would hear "Operations" and never
                the handle itself. */}
            <span className="sr-only">
              {faceLabel} — {caption}
            </span>
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate px-1.5 text-main dark:text-darkTextTertiary">
          {label}
        </span>
        {derived ? (
          <span className="shrink-0 border-l border-borderFine px-1.5 text-slateDanis dark:border-white/12 dark:text-darkTextSecondary">
            .{face}
          </span>
        ) : null}
        {/* The shared brand suffix wears the living gradient. The face segment
            above stays grey: it is a namespace, not the mark. */}
        <span className="shrink-0 border-l border-borderFine px-1.5 dark:border-white/12">
          <span className="t-gradient-text">{ensName ? '.bufi.eth' : '.bufi'}</span>
        </span>
        {ensName && ensNetworkLabel ? (
          <span className="mr-1.5 shrink-0 rounded-full border border-borderFine px-1.5 text-[10px] uppercase tracking-[-0.02em] text-slateDanis dark:border-white/12 dark:text-darkTextSecondary">
            {ensNetworkLabel}
          </span>
        ) : null}
      </div>
    </>
  );

  if (!onSelect) {
    return (
      <HandleInspect face={face} label={label}>
        <div className={rowClassName}>{chrome}</div>
      </HandleInspect>
    );
  }

  return (
    <HandleInspect face={face} label={label}>
      <div
        role="radio"
        aria-checked={selected}
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onSelect();
          }
        }}
        className={rowClassName}
      >
        {chrome}
      </div>
    </HandleInspect>
  );
}
