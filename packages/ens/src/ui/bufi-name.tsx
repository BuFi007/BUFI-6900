'use client';

/**
 * BufiName — a finished BUFI handle, rendered as the brand object it is.
 *
 * ONE place decides what a handle looks like: Knicknack, the purple → violet →
 * blue identity ramp Ghost Mode wears on its masthead, and a click that copies
 * it. Before this component every site made its own choices — 9px mono in the
 * face tab, 12px mono in the header pill, three separate spans in the setup
 * row with the gradient on `.bufi` alone — so the same string was four
 * different objects depending on where you met it.
 *
 * WHY THE WHOLE NAME AND NOT THE SUFFIX. `.t-gradient-text` dresses `.bufi`
 * only, deliberately: while you are TYPING a handle, the label is the part you
 * are choosing and should read as your own text. That reasoning is about the
 * claim field, and the claim field keeps it. Everywhere else the handle is not
 * a field being filled in, it is an identity being shown, and it is styled
 * whole (founder, 2026-09-08).
 *
 * WHY KNICKNACK IS SAFE HERE. DESIGN.md reserves Knicknack for brand moments
 * because it maps 340 codepoints — Latin plus Western punctuation. A handle is
 * not translated copy: it is `[a-z0-9]` plus dots, enforced at the claim field.
 * `canKnicknackRender` still checks the actual string rather than trusting
 * that, and falls back to the UI face for anything it cannot draw — the
 * question is what is IN this string, never what locale the page is in.
 */

import { useState } from 'react';

import { cn } from '@bu/ui/cn';
import { useCopyHandler } from '@bu/ui/use-copy-handler';
import { Check, Copy } from 'lucide-react';

import '@/styles/bufi-gradient-text.css';

/**
 * Printable ASCII — every glyph a handle can contain, and a strict subset of
 * the 340 codepoints Knicknack maps. Deliberately narrower than the font's
 * real coverage: the question this answers is "can Knicknack draw THIS
 * string", and being wrong in the permissive direction renders tofu. Anything
 * outside (a CJK or Devanagari codepoint that reached a name some other way)
 * falls back to the UI face.
 *
 * This tests the STRING, not the locale. Mobile's `isKnicknackScript` guards
 * translated copy, which a handle is not.
 */
const KNICKNACK_RENDERABLE = /^[\u0020-\u007E]*$/u;

export function canKnicknackRender(value: string): boolean {
  return KNICKNACK_RENDERABLE.test(value);
}

interface BufiNameProps {
  /** The complete handle, e.g. `acme.treasury.bufi` or `acme.bufi.eth`. */
  name: string;
  /**
   * `span` when this renders inside another interactive element — the wallet
   * face tab is a `<button role="tab">` from @bufinance/web3-signin, and a
   * nested <button> is both invalid HTML and a second click target that would
   * switch faces. Keyboard support is restored by hand in that case.
   */
  as?: 'button' | 'span';
  /** Off for a handle that is decoration inside a row that is itself clickable. */
  copyable?: boolean;
  /** Show the copy glyph beside the name. Off leaves the name itself clickable. */
  showIcon?: boolean;
  /**
   * `onColor` for a handle on a saturated surface. The brand ramp starts at
   * purpleDanis, which against a mint or gold card is not a style choice but
   * an unreadable name; `onColor` keeps the gradient and travels violet-ward
   * from white instead.
   */
  tone?: 'brand' | 'onColor';
  /**
   * Typeface. Default `knicknack` (brand object). `poppins` for panel chrome
   * that should match Select Chains / address-pill body text — e.g. ENS Alias.
   */
  face?: 'knicknack' | 'poppins';
  className?: string;
  iconClassName?: string;
}

export function BufiName({
  name,
  as = 'button',
  copyable = true,
  showIcon = true,
  tone = 'brand',
  face = 'knicknack',
  className,
  iconClassName,
}: BufiNameProps) {
  // The founder copy, verbatim from `wallet-face-tag.tsx` — a handle pasted
  // outside BUFI does nothing, and a lookalike outside the platform is a
  // phishing surface, so the toast teaches WHERE it may be shared at the
  // moment it is copied.
  const { copy, isCopied } = useCopyHandler({
    title: 'Tag copied',
    description:
      'Send this to other BUFI users so they send you payments in the platform. Only share tags with BUFI workspace users.',
  });
  const [hovered, setHovered] = useState(false);

  const faceClass =
    face === 'poppins'
      ? 'font-poppins'
      : canKnicknackRender(name)
        ? 'font-knicknack'
        : 'font-sans';
  const label = (
    <span
      className={cn(
        faceClass,
        'truncate',
        tone === 'onColor' ? 'bu-name-gradient-on-color' : 'bu-name-gradient',
        className
      )}
      title={name}
    >
      {name}
    </span>
  );

  if (!copyable) return label;

  const handleCopy = (event: React.MouseEvent | React.KeyboardEvent) => {
    // A handle very often sits inside a row that navigates. Copying must never
    // also mean "select this face".
    event.stopPropagation();
    event.preventDefault();
    void copy(name);
  };

  const icon = showIcon ? (
    <span
      aria-hidden
      className={cn(
        'shrink-0 transition-opacity duration-150',
        isCopied || hovered ? 'opacity-100' : 'opacity-0',
        iconClassName
      )}
    >
      {isCopied ? (
        <Check
          className={cn('size-3', tone === 'onColor' ? 'text-white' : 'text-green-600')}
          strokeWidth={3}
        />
      ) : (
        <Copy
          className={cn(
            'size-3',
            tone === 'onColor' ? 'text-white/75' : 'text-purpleDanis/60 dark:text-violetDanis/60'
          )}
          strokeWidth={2.5}
        />
      )}
    </span>
  ) : null;

  const shared = {
    'aria-label': `Copy ${name}`,
    onClick: handleCopy,
    onMouseEnter: () => setHovered(true),
    onMouseLeave: () => setHovered(false),
    onFocus: () => setHovered(true),
    onBlur: () => setHovered(false),
    className: cn(
      'group/bufi-name inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1 rounded',
      'focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-purpleDanis'
    ),
  };

  if (as === 'span') {
    return (
      /* biome-ignore lint/a11y/useSemanticElements: a <button> is what this
         should be and what it cannot be — callers passing `as="span"` render
         inside another button (the wallet-face tab), where a nested button is
         invalid HTML and would also switch faces. The key handler below
         restores what the semantic element gives for free. */
      <span
        role="button"
        tabIndex={0}
        {...shared}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') handleCopy(event);
        }}
      >
        {label}
        {icon}
      </span>
    );
  }

  return (
    <button type="button" {...shared}>
      {label}
      {icon}
    </button>
  );
}
