import { cn } from '@/lib/cn';
import { Icon } from '@/components/kit/Icon';
import { DEMO_DEAL_CODE } from './demo';
import { ROOM_EVENTS, ROOM_HEAD, ROOM_TIMELINE, type RoomEvent } from './engineDemo';
import { ReadReceipt } from './Glyphs';

/**
 * The room a deal lives in, at full size.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  A DEMONSTRATION. IT MUTATES NOTHING, AND IT CANNOT.               │
 * │                                                                    │
 * │  Every control here — `Confirm & release`, `Open dispute`, the     │
 * │  message field — is a `<span>` or a `<div>`. None of them is a     │
 * │  button, a link or a form, so there is no path from this page to   │
 * │  a state transition, and no second implementation of one. Release  │
 * │  is the most consequential act in the product; it belongs to a     │
 * │  signed-in party inside a real room, decided by the server.        │
 * │                                                                    │
 * │  The whole figure is `aria-hidden` and the section that holds it   │
 * │  carries the equivalent in words — reading four fake participants  │
 * │  and a fake transcript aloud would bury the real controls on the   │
 * │  page. See `DealRoomShowcase`.                                     │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * The two-column split arrives at `md`, where the conversation still has
 * 420px to itself. Below that the rail stacks under the transcript at
 * full width and full size — a deal room shrunk to fit a phone is a
 * screenshot of a product nobody can read, which is the one thing this
 * section cannot afford to be.
 */
export function DealRoomDemo({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        'overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-line)] bg-[var(--color-paper)] shadow-[var(--shadow-lift)]',
        className,
      )}
    >
      {/* ---- What this deal is ---------------------------------- */}
      {/*
        Two rows on a phone. Side by side, the `shrink-0` code-and-expiry
        group took 235 of 310px and the title group was squeezed until the
        status pill sat on top of the deal code.
      */}
      <div className="flex flex-col gap-2 border-b border-[var(--color-line)] px-3.5 py-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-3 sm:px-4">
        <span className="flex min-w-0 flex-1 items-center gap-2.5">
          <Icon
            name="chevron-left"
            className="h-[18px] w-[18px] shrink-0 text-[var(--color-ink-3)]"
            strokeWidth={2}
          />
          <span className="truncate text-[length:var(--text-md)] font-semibold text-[var(--color-ink)]">
            {ROOM_HEAD.title}
          </span>
          <span className="shrink-0 rounded-[var(--radius-full)] border border-[var(--color-hold-line)] bg-[var(--color-hold-tint)] px-2 py-0.5 text-[length:var(--text-2xs)] font-semibold text-[var(--color-hold)]">
            {ROOM_HEAD.status}
          </span>
        </span>

        <span className="flex w-full shrink-0 items-center justify-between gap-3 sm:w-auto sm:justify-start">
          <span className="flex items-center gap-1.5">
            <span className="text-[length:var(--text-2xs)] text-[var(--color-ink-3)]">
              Deal Code
            </span>
            <span className="font-mono text-[length:var(--text-xs)] font-semibold tracking-[0.04em] text-[var(--color-ink)]">
              {DEMO_DEAL_CODE}
            </span>
            <Icon name="copy" className="h-3.5 w-3.5 text-[var(--color-ink-4)]" />
          </span>
          <span className="tnum text-[length:var(--text-2xs)] font-semibold text-[var(--color-brand)]">
            Expires in {ROOM_HEAD.expiresIn}
          </span>
        </span>
      </div>

      {/*
        ⚠ `lg`, NOT `md`. At 768px the split left the conversation 360px
        beside a 280px rail, and `1,000 USDT`, `INR Payer`, `USDT Receiver`
        and `payment-proof.jpg` all took an ellipsis. The rail is a fixed
        width, so the breakpoint has to be where the REMAINDER is still
        readable — 1024px, which leaves the transcript 600px.
      */}
      <div className="lg:flex lg:items-stretch">
        {/* ---- The conversation --------------------------------- */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/*
            Who is in the room, and on which side.

            ⚠ STACKED BELOW `sm`, AND NOT AS A STYLE CHOICE. Both roles
            carry a `Verified` tick, and a truncating name implies
            `white-space: nowrap`, so this row's MIN-CONTENT was 415px —
            wider than a 390px phone can give it. A grid item cannot go
            below its min-content, so that one row was widening the whole
            dark panel and clipping the headline beside it. Two rows on a
            phone cost nothing and the row fits honestly.
          */}
          <div className="flex flex-col gap-2 border-b border-[var(--color-line)] px-3.5 py-2.5 sm:flex-row sm:items-center sm:px-4">
            <Party name="You" role="INR Payer" tone="brand" />
            <Icon
              name="swap"
              className="h-4 w-4 shrink-0 rotate-90 self-center text-[var(--color-ink-4)] sm:rotate-0"
              strokeWidth={1.9}
            />
            <Party name="Counterparty" role="USDT Receiver" tone="final" align="right" />
            <Icon
              name="more"
              className="hidden h-4 w-4 shrink-0 rotate-90 text-[var(--color-ink-4)] sm:block"
              strokeWidth={2.6}
            />
          </div>

          {/* The transcript. */}
          <div className="stagger flex-1 space-y-3 bg-[var(--color-canvas)] px-3.5 py-3.5 sm:px-4">
            <p className="text-center text-[length:var(--text-2xs)] font-medium text-[var(--color-ink-4)]">
              Today
            </p>
            {ROOM_EVENTS.map((event) => (
              <Event key={event.id} event={event} />
            ))}
          </div>

          {/* Inert: this room is a picture of a conversation. */}
          <div className="flex items-center gap-2 border-t border-[var(--color-line)] px-3.5 py-2.5 sm:px-4">
            <Icon name="paperclip" className="h-4 w-4 shrink-0 text-[var(--color-ink-4)]" />
            <span className="min-w-0 flex-1 truncate text-[length:var(--text-sm)] text-[var(--color-ink-4)]">
              Type a message…
            </span>
            <Icon
              name="telegram"
              className="h-[18px] w-[18px] shrink-0 text-[var(--color-ink-3)]"
              strokeWidth={1.7}
            />
          </div>
        </div>

        {/* ---- What is protected, and how far it has got --------- */}
        <div className="shrink-0 space-y-4 border-t border-[var(--color-line)] bg-[var(--color-paper)] p-3.5 sm:p-4 lg:w-[17.5rem] lg:border-l lg:border-t-0">
          <div>
            <p className="text-[length:var(--text-2xs)] font-semibold uppercase tracking-[0.07em] text-[var(--color-ink-4)]">
              Protected asset
            </p>
            <div className="mt-2 flex items-center gap-2.5 rounded-[var(--radius-md)] border border-[var(--color-final-line)] bg-[var(--color-final-tint)] p-2.5">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[var(--radius-sm)] bg-[var(--color-final)] text-white">
                <Icon name="lock" className="h-4 w-4" strokeWidth={2} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="tnum block text-[length:var(--text-base)] font-semibold text-[var(--color-ink)]">
                  {ROOM_HEAD.asset}
                </span>
                <span className="block text-[length:var(--text-2xs)] text-[var(--color-final)]">
                  {ROOM_HEAD.assetNote}
                </span>
              </span>
              <span className="shrink-0 rounded-[var(--radius-full)] border border-[var(--color-final-line)] bg-[var(--color-paper)] px-2 py-0.5 text-[length:var(--text-2xs)] font-semibold text-[var(--color-final)]">
                Locked
              </span>
            </div>
          </div>

          <div>
            <p className="text-[length:var(--text-2xs)] font-semibold uppercase tracking-[0.07em] text-[var(--color-ink-4)]">
              Status timeline
            </p>
            <ol className="mt-2">
              {ROOM_TIMELINE.map((step, i) => (
                <li key={step.label} className="relative flex items-center gap-2.5 py-[7px] pl-0">
                  {/* The run between two dots, drawn from each dot upward. */}
                  {i > 0 ? (
                    <span
                      className={cn(
                        'absolute bottom-1/2 left-[5px] top-0 w-px',
                        step.state === 'todo' ? 'bg-[var(--color-line)]' : 'bg-[var(--color-rule)]',
                      )}
                    />
                  ) : null}
                  <span
                    className={cn(
                      'relative h-[11px] w-[11px] shrink-0 rounded-full border-2',
                      step.state === 'now'
                        ? 'border-[var(--color-final)] bg-[var(--color-final)]'
                        : step.state === 'done'
                          ? 'border-[var(--color-edge)] bg-[var(--color-paper)]'
                          : 'border-[var(--color-line)] bg-[var(--color-paper)]',
                    )}
                  />
                  <span
                    className={cn(
                      'min-w-0 flex-1 text-[length:var(--text-xs)]',
                      step.state === 'now'
                        ? 'font-semibold text-[var(--color-final)]'
                        : step.state === 'todo'
                          ? 'text-[var(--color-ink-4)]'
                          : 'text-[var(--color-ink-2)]',
                    )}
                  >
                    {step.label}
                  </span>
                  <span className="tnum shrink-0 text-[length:var(--text-2xs)] text-[var(--color-ink-4)]">
                    {step.at}
                  </span>
                </li>
              ))}
            </ol>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <span className="flex h-10 items-center justify-center rounded-[var(--radius-md)] border border-[var(--color-rule)] bg-[var(--color-paper)] text-[length:var(--text-xs)] font-semibold text-[var(--color-ink)]">
              Open dispute
            </span>
            <span className="flex h-10 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-brand)] text-[length:var(--text-xs)] font-semibold text-white shadow-[var(--shadow-brand)]">
              Confirm &amp; release
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Parts
 * ------------------------------------------------------------------ */

function Party({
  name,
  role,
  tone,
  align = 'left',
}: {
  name: string;
  role: string;
  tone: 'brand' | 'final';
  align?: 'left' | 'right';
}) {
  return (
    <span
      className={cn(
        'flex min-w-0 flex-1 items-center gap-2',
        align === 'right' && 'sm:justify-end',
      )}
    >
      <span
        className={cn(
          'grid h-7 w-7 shrink-0 place-items-center rounded-full',
          tone === 'brand'
            ? 'bg-[var(--color-brand-tint)] text-[var(--color-brand)]'
            : 'bg-[var(--color-final-tint)] text-[var(--color-final)]',
        )}
      >
        <Icon name="profile" className="h-4 w-4" strokeWidth={1.9} />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[length:var(--text-xs)] font-semibold text-[var(--color-ink)]">
          {name}
        </span>
        <span className="flex items-center gap-1">
          <span className="truncate text-[length:var(--text-2xs)] text-[var(--color-ink-3)]">
            {role}
          </span>
          <span className="flex shrink-0 items-center gap-0.5 text-[length:var(--text-2xs)] font-semibold text-[var(--color-final)]">
            <Icon name="check-circle" className="h-3 w-3" strokeWidth={2.2} />
            Verified
          </span>
        </span>
      </span>
    </span>
  );
}

function Event({ event }: { event: RoomEvent }) {
  if (event.kind === 'system') {
    return (
      <div className="flex items-start gap-2">
        <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full border border-[var(--color-final-line)] bg-[var(--color-final-tint)] text-[var(--color-final)]">
          <Icon name="check" className="h-3 w-3" strokeWidth={2.6} />
        </span>
        <span className="min-w-0">
          <span className="flex items-baseline gap-2">
            <span className="text-[length:var(--text-2xs)] font-semibold text-[var(--color-ink-2)]">
              {event.who}
            </span>
            <span className="tnum text-[length:var(--text-2xs)] text-[var(--color-ink-4)]">
              {event.at}
            </span>
          </span>
          <span className="mt-1 inline-block rounded-[var(--radius-sm)] border border-[var(--color-line)] bg-[var(--color-paper)] px-2.5 py-1.5 text-[length:var(--text-xs)] text-[var(--color-ink-2)]">
            {event.body}
          </span>
        </span>
      </div>
    );
  }

  const mine = event.side === 'you';

  return (
    <div className="flex items-start gap-2">
      <span
        className={cn(
          'mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full',
          mine
            ? 'bg-[var(--color-brand-tint)] text-[var(--color-brand)]'
            : 'bg-[var(--color-final-tint)] text-[var(--color-final)]',
          event.kind === 'evidence' && 'invisible',
        )}
      >
        <Icon name="profile" className="h-3.5 w-3.5" strokeWidth={1.9} />
      </span>

      <span className="min-w-0 flex-1">
        {event.kind === 'message' ? (
          <>
            <span className="flex items-baseline gap-2">
              <span className="text-[length:var(--text-2xs)] font-semibold text-[var(--color-ink)]">
                {event.who}
              </span>
              <span className="tnum text-[length:var(--text-2xs)] text-[var(--color-ink-4)]">
                {event.at}
              </span>
            </span>
            <span className="mt-1 inline-flex max-w-full items-end gap-2 rounded-[var(--radius-sm)] border border-[var(--color-line)] bg-[var(--color-paper)] px-2.5 py-1.5">
              <span className="min-w-0 text-[length:var(--text-xs)] text-[var(--color-ink)]">
                {event.body}
              </span>
              {event.receipt ? <ReadReceipt className="mb-0.5 text-[var(--tg)]" /> : null}
            </span>
          </>
        ) : (
          <span className="flex items-center gap-2.5 rounded-[var(--radius-md)] border border-[var(--color-line)] bg-[var(--color-paper)] p-2">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[var(--radius-sm)] bg-[var(--color-inset)] text-[var(--color-ink-4)]">
              <Icon name="image" className="h-4 w-4" />
            </span>
            {/*
              `Verified upload` sits beside the filename from `sm` and
              drops onto the meta line below it on a phone. Inline, the
              pair needed 190px of the 190px available and the filename —
              the thing a person is actually checking — was the half that
              got the ellipsis.
            */}
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-[length:var(--text-xs)] font-semibold text-[var(--color-ink)]">
                  {event.file!.name}
                </span>
                <span className="hidden shrink-0 text-[length:var(--text-2xs)] text-[var(--color-ink-4)] sm:inline">
                  ·
                </span>
                <span className="hidden shrink-0 text-[length:var(--text-2xs)] font-medium text-[var(--color-final)] sm:inline">
                  {event.file!.note}
                </span>
              </span>
              <span className="tnum mt-0.5 block text-[length:var(--text-2xs)] text-[var(--color-ink-4)]">
                <span className="font-medium text-[var(--color-final)] sm:hidden">
                  {event.file!.note} ·{' '}
                </span>
                {event.file!.size} · {event.at}
              </span>
            </span>
            <Icon
              name="check-circle"
              className="h-5 w-5 shrink-0 text-[var(--color-final)]"
              strokeWidth={2}
            />
          </span>
        )}
      </span>
    </div>
  );
}
