import Link from 'next/link';
import { cn } from '@/lib/cn';
import { Mark } from '@/components/kit/Brand';
import { CHANNELS, ChannelDisc } from './Glyphs';
import { LandingShell } from './LandingShell';
import { FOOTER_BOTTOM, FOOTER_BRAND, FOOTER_COLUMNS, type FooterEntry } from './telegramDemo';

/**
 * The end of the page, and the honest map of what exists.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  HALF OF THESE DESTINATIONS DO NOT EXIST, AND THE FOOTER SAYS SO.  │
 * │                                                                    │
 * │  There is no `/terms`, `/privacy`, `/about`, `/contact`, `/legal`  │
 * │  or status page in this repository. The tempting move is to point  │
 * │  them at something adjacent — Privacy at the security screen,      │
 * │  Legal at the FAQ — and every one of those is a small lie in the   │
 * │  footer of a product whose entire subject is trust.                │
 * │                                                                    │
 * │  So an entry with no destination renders as text, not a link:      │
 * │  visibly dimmer, `aria-disabled`, and carrying "not published yet" │
 * │  in its accessible name. Nothing is a dead `#`, and nothing        │
 * │  navigates somewhere it did not promise. When the pages are        │
 * │  written, one `href` in `telegramDemo.ts` turns each back into a   │
 * │  link.                                                             │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * The sandbox disclosure that used to live here is gone from the PUBLIC
 * page at LANDING-04's instruction. It still renders on `/login` and on a
 * shared deal link, where somebody is about to act rather than read.
 */
export function SiteFooter() {
  return (
    <footer className="bg-[var(--color-canvas)]">
      <LandingShell className="pb-10 sm:pb-14">
        <div className="overflow-hidden rounded-[var(--radius-2xl)] bg-[var(--color-nav)] p-6 sm:p-9 lg:p-11">
          <div className="grid gap-10 min-[1120px]:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] min-[1120px]:gap-14">
            {/* ---- Who this is -------------------------------- */}
            <div className="min-w-0">
              <span className="flex items-center gap-3">
                <Mark className="h-9 w-9 text-[var(--color-brand)]" />
                <span className="flex flex-col leading-none">
                  <span className="text-[1.3rem] font-bold tracking-[-0.04em] text-[var(--color-nav-ink)]">
                    {FOOTER_BRAND.name}
                  </span>
                  <span className="mt-1.5 text-[length:var(--text-xs)] font-medium text-[var(--color-nav-ink-3)]">
                    {FOOTER_BRAND.suffix}
                  </span>
                </span>
              </span>
              <p className="mt-5 max-w-[34ch] text-[length:var(--text-sm)] leading-relaxed text-[var(--color-nav-ink-2)]">
                {FOOTER_BRAND.line}
              </p>

              {/* The chats a deal link travels through. */}
              <ul className="mt-6 flex items-center gap-2.5">
                {CHANNELS.filter((c) => c.key !== 'code').map((channel) => (
                  <li key={channel.key}>
                    <ChannelDisc
                      channel={channel}
                      className="h-9 w-9"
                      glyphClassName="h-[18px] w-[18px]"
                    />
                    <span className="sr-only">{channel.label}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* ---- What is where ------------------------------ */}
            <div className="grid gap-8 sm:grid-cols-3 sm:gap-6">
              {FOOTER_COLUMNS.map((column) => (
                <nav key={column.title} aria-label={column.title} className="min-w-0">
                  <h2 className="text-[length:var(--text-sm)] font-semibold text-[var(--color-nav-ink)]">
                    {column.title}
                  </h2>
                  <ul className="mt-3.5 space-y-2.5">
                    {column.entries.map((entry) => (
                      <li key={entry.label}>
                        <FooterLink entry={entry} />
                      </li>
                    ))}
                  </ul>
                </nav>
              ))}
            </div>
          </div>

          {/* ---- The small print ------------------------------ */}
          <div className="mt-10 flex flex-col gap-4 border-t border-[var(--color-nav-3)] pt-6 sm:flex-row-reverse sm:items-center sm:justify-between">
            <ul className="flex flex-wrap items-center gap-x-4 gap-y-2">
              {FOOTER_BOTTOM.map((entry) => (
                <li key={entry.label} className="flex items-center gap-4">
                  <FooterLink entry={entry} />
                </li>
              ))}
            </ul>
            <p className="tnum text-[length:var(--text-xs)] text-[var(--color-nav-ink-3)]">
              {FOOTER_BRAND.copyright}
            </p>
          </div>
        </div>
      </LandingShell>
    </footer>
  );
}

/**
 * A destination, or an honest absence.
 *
 * `min-h-6` on both branches: WCAG 2.2 AA 2.5.8 wants 24px, and these are
 * block-level list items rather than inline text, so the inline exemption
 * does not apply to them.
 */
function FooterLink({ entry }: { entry: FooterEntry }) {
  const shape =
    'inline-flex min-h-6 items-center rounded-[var(--radius-xs)] text-[length:var(--text-sm)]';

  if (entry.href === null) {
    return (
      <span
        aria-disabled="true"
        title={`${entry.label} is not published yet.`}
        className={cn(shape, 'cursor-default text-[var(--color-nav-ink-3)]/70')}
      >
        {entry.label}
        <span className="sr-only"> — not published yet</span>
      </span>
    );
  }

  return (
    <Link
      href={entry.href}
      prefetch={false}
      className={cn(
        shape,
        'text-[var(--color-nav-ink-2)] transition-colors hover:text-[var(--color-nav-ink)]',
      )}
    >
      {entry.label}
    </Link>
  );
}
