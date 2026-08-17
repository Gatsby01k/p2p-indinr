import { cn } from '@/lib/cn';
import { Icon, type IconName } from '@/components/kit/Icon';
import { DEMO_DEAL_CODE } from './demo';

/**
 * Where the deal actually happens, after the link has been taken.
 *
 * ⚠ A DEMONSTRATION. The transcript is fixed copy; `Release funds` is an
 * inert `<span>`. Releasing is the single most consequential action in the
 * product and it belongs to a signed-in party inside a real deal room, so
 * it is not rendered as anything clickable on a public marketing page.
 */

const STEPS: readonly { label: string; icon: IconName; state: 'done' | 'now' }[] = [
  { label: 'Created', icon: 'check', state: 'done' },
  { label: 'Joined', icon: 'profile', state: 'done' },
  { label: 'Proof', icon: 'check', state: 'done' },
  { label: 'Release', icon: 'lock', state: 'now' },
];

const TRANSCRIPT: readonly {
  who: string;
  what: string;
  at: string;
  file: string;
  size: string;
  side: 'you' | 'them';
}[] = [
  {
    who: 'You',
    what: 'Payment sent',
    at: '10:32 AM',
    file: 'payment_receipt.jpg',
    size: '245 KB',
    side: 'you',
  },
  {
    who: 'Counterparty',
    what: 'Payment received',
    at: '10:35 AM',
    file: 'receipt_proof.jpg',
    size: '210 KB',
    side: 'them',
  },
];

export function DealRoomPreview({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-line)] bg-[var(--color-paper)] shadow-[var(--shadow-lift)]',
        className,
      )}
    >
      {/* ---- Head ------------------------------------------------- */}
      <div className="flex items-center justify-between gap-2 px-4 pb-1.5 pt-3">
        <span className="text-[14.5px] font-semibold tracking-[-0.02em] text-[var(--color-ink)]">
          Deal Room
        </span>
        <span className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded-[var(--radius-full)] border border-[var(--color-final-line)] bg-[var(--color-final-tint)] px-2 py-0.5 text-[10.5px] font-semibold text-[var(--color-final)]">
            <span className="h-1.5 w-1.5 rounded-full bg-current" />
            Active
          </span>
          <Icon
            name="more"
            className="h-4 w-4 rotate-90 text-[var(--color-ink-4)]"
            strokeWidth={2.6}
          />
        </span>
      </div>
      <p className="tnum px-4 font-mono text-[10.5px] text-[var(--color-ink-4)]">
        #{DEMO_DEAL_CODE}
      </p>

      {/* ---- Progress --------------------------------------------- */}
      <ol className="mt-2.5 flex items-start px-3 pb-2">
        {STEPS.map((step, i) => (
          <li key={step.label} className="relative flex flex-1 flex-col items-center">
            {i > 0 ? (
              <span className="absolute right-1/2 top-[11px] h-px w-full bg-[var(--color-line)]" />
            ) : null}
            <span
              className={cn(
                'relative grid h-[22px] w-[22px] place-items-center rounded-full border',
                step.state === 'now'
                  ? 'border-[var(--color-brand)] bg-[var(--color-brand)] text-white'
                  : 'border-[var(--color-rule)] bg-[var(--color-paper)] text-[var(--color-ink-3)]',
              )}
            >
              <Icon name={step.icon} className="h-3 w-3" strokeWidth={2.4} />
            </span>
            <span
              className={cn(
                'mt-1.5 text-[10px] font-semibold',
                step.state === 'now' ? 'text-[var(--color-brand)]' : 'text-[var(--color-ink-3)]',
              )}
            >
              {step.label}
            </span>
          </li>
        ))}
      </ol>

      {/* ---- Transcript ------------------------------------------- */}
      <div className="space-y-1.5 border-t border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-2">
        {TRANSCRIPT.map((entry) => (
          <div
            key={entry.file}
            className="rounded-[var(--radius-md)] border border-[var(--color-line)] bg-[var(--color-paper)] p-2"
          >
            <div className="flex items-start gap-2">
              <span
                className={cn(
                  'grid h-6 w-6 shrink-0 place-items-center rounded-full',
                  entry.side === 'you'
                    ? 'bg-[var(--color-brand-tint)] text-[var(--color-brand)]'
                    : 'bg-[var(--color-final-tint)] text-[var(--color-final)]',
                )}
              >
                <Icon name="profile" className="h-3.5 w-3.5" strokeWidth={1.9} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[11.5px] font-semibold text-[var(--color-ink)]">
                  {entry.who}
                </span>
                <span className="mt-0.5 block text-[10.5px] text-[var(--color-ink-3)]">
                  {entry.what}
                </span>
              </span>
              <span className="tnum shrink-0 text-[10px] text-[var(--color-ink-4)]">
                {entry.at}
              </span>
            </div>

            <div className="mt-1.5 flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--color-line)] bg-[var(--color-sunken)] p-1.5">
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-[var(--radius-xs)] bg-[var(--color-paper)] text-[var(--color-ink-4)]">
                <Icon name="file" className="h-3.5 w-3.5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[10.5px] font-medium text-[var(--color-ink)]">
                  {entry.file}
                </span>
                <span className="tnum mt-0.5 block text-[9.5px] text-[var(--color-ink-4)]">
                  {entry.size} · Uploaded
                </span>
              </span>
              <Icon
                name="check-circle"
                className="h-4 w-4 shrink-0 text-[var(--color-final)]"
                strokeWidth={2}
              />
            </div>
          </div>
        ))}
      </div>

      {/* ---- The consequential action ----------------------------- */}
      <div className="border-t border-[var(--color-line)] px-3 pb-3 pt-2.5">
        <span className="flex h-10 items-center justify-center gap-1.5 rounded-[var(--radius-md)] bg-[var(--color-brand)] text-[12.5px] font-semibold text-white shadow-[var(--shadow-brand)]">
          <Icon name="lock" className="h-3.5 w-3.5" strokeWidth={2.2} />
          Release funds
        </span>
        <p className="mt-2 text-center text-[10px] font-medium text-[var(--color-ink-4)]">
          Funds release to counterparty
        </p>
      </div>
    </div>
  );
}
