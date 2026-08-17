import { cn } from '@/lib/cn';
import { Icon } from '@/components/kit/Icon';
import { StatusCluster } from './Glyphs';
import { CAPABILITIES, CAPABILITY_KEYS, type CapabilityDemo, type CapabilityKey } from './demo';

/**
 * The composer, inside Telegram, inside a phone.
 *
 * ⚠ A DEMONSTRATION. Nothing here is a form control: the mode tabs are
 * `<span>`s driven by the hero's real radio group, the amounts are text,
 * and `Create deal` is inert. The live control that creates a deal is the
 * page's primary call to action, which goes to the existing `/app/new`
 * route through the existing sign-in handoff. Two things that look like
 * the same button must not do different amounts of work.
 */
export function MiniAppPreview({
  capability,
  className,
}: {
  capability: CapabilityDemo;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'overflow-hidden rounded-[2.2rem] border-[7px] border-[#171310] bg-[#171310] shadow-[var(--shadow-lift)]',
        className,
      )}
    >
      <div className="relative overflow-hidden rounded-[1.7rem] bg-[var(--color-paper)]">
        {/* ---- iOS status bar ------------------------------------- */}
        <div className="relative flex items-center justify-between px-5 pb-1.5 pt-2.5 text-[var(--color-ink)]">
          <span className="tnum text-[12.5px] font-semibold">9:41</span>
          {/* The cutout. Drawn, not photographed. */}
          <span className="absolute left-1/2 top-1.5 h-[22px] w-[74px] -translate-x-1/2 rounded-full bg-[#171310]" />
          <StatusCluster />
        </div>

        {/* ---- Telegram's own header ------------------------------ */}
        <div className="flex items-center justify-between gap-1.5 px-3 pb-2.5 pt-2">
          <span className="w-8 shrink-0 text-[11px] font-medium text-[var(--tg)]">Close</span>
          <span className="flex min-w-0 flex-col items-center leading-none">
            <span className="whitespace-nowrap text-[11.5px] font-semibold text-[var(--color-ink)]">
              Telegram Mini App
            </span>
            <span className="mt-1 text-[9.5px] font-medium text-[var(--color-ink-4)]">INRP2P</span>
          </span>
          <span className="flex w-8 shrink-0 justify-end">
            <Icon name="more" className="h-4 w-4 text-[var(--color-ink-3)]" strokeWidth={2.6} />
          </span>
        </div>

        <div className="border-t border-[var(--color-line)] px-3.5 pb-4 pt-3.5">
          <p className="text-[14px] font-semibold tracking-[-0.02em] text-[var(--color-ink)]">
            Create a protected deal
          </p>

          {/* ---- The three modes ---------------------------------- */}
          <div className="mt-3 flex gap-1 border-b border-[var(--color-line)]">
            {CAPABILITY_KEYS.map((key) => (
              <ModeTab key={key} mode={key} active={key === capability.key} />
            ))}
          </div>

          {/* ---- The two legs ------------------------------------- */}
          <div className="mt-3.5 rounded-[var(--radius-md)] border border-[var(--color-line)] bg-[var(--color-sunken)] p-3">
            <p className="text-[10.5px] font-medium text-[var(--color-ink-3)]">You pay</p>
            <div className="mt-1 flex items-center justify-between gap-2">
              <span
                key={`pay-${capability.key}`}
                className="tnum animate-value min-w-0 truncate text-[19px] font-semibold tracking-[-0.03em] text-[var(--color-ink)]"
              >
                {capability.pay.amount}
              </span>
              <UnitChip unit={capability.pay.unit} />
            </div>
            <p className="mt-2.5 flex items-center gap-1.5 text-[10px] font-medium text-[var(--color-ink-3)]">
              <Icon name="lock" className="h-3 w-3 text-[var(--color-ink-4)]" strokeWidth={2} />
              Funds held securely by DealSafe
            </p>
          </div>

          <div className="mt-2 rounded-[var(--radius-md)] border border-[var(--color-line)] bg-[var(--color-paper)] p-3">
            <p className="text-[10.5px] font-medium text-[var(--color-ink-3)]">They receive</p>
            <div className="mt-1 flex items-center justify-between gap-2">
              <span
                key={`get-${capability.key}`}
                className="tnum animate-value min-w-0 truncate text-[19px] font-semibold tracking-[-0.03em] text-[var(--color-ink)]"
              >
                {capability.receive.amount}
              </span>
              <UnitChip unit={capability.receive.unit} />
            </div>
          </div>

          {/* ---- Locked terms ------------------------------------- */}
          <div className="mt-2.5 flex items-start gap-2 rounded-[var(--radius-md)] border border-[var(--color-final-line)] bg-[var(--color-final-tint)] p-2.5">
            <Icon
              name="shield-check"
              className="mt-px h-4 w-4 shrink-0 text-[var(--color-final)]"
              strokeWidth={1.9}
            />
            <span className="min-w-0">
              <span className="block text-[11.5px] font-semibold text-[var(--color-final)]">
                Terms locked
              </span>
              <span className="mt-0.5 block text-[10px] leading-snug text-[var(--color-final)]/85">
                Only you and your counterparty can join.
              </span>
            </span>
          </div>

          <span className="mt-3 flex h-10 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-brand)] text-[13px] font-semibold text-white shadow-[var(--shadow-brand)]">
            Create deal
          </span>
          <p className="mt-2 flex items-center justify-center gap-1.5 text-[10px] font-medium text-[var(--color-ink-4)]">
            <Icon name="lock" className="h-3 w-3" strokeWidth={2} />1 counterparty only
          </p>
        </div>
      </div>
    </div>
  );
}

function ModeTab({ mode, active }: { mode: CapabilityKey; active: boolean }) {
  return (
    <span
      className={cn(
        'relative flex-1 pb-2 text-center text-[11px] font-semibold transition-colors duration-[var(--dur-base)]',
        active ? 'text-[var(--color-ink)]' : 'text-[var(--color-ink-4)]',
      )}
    >
      {CAPABILITIES[mode].label}
      <span
        className={cn(
          'absolute inset-x-1 -bottom-px h-[2px] rounded-full bg-[var(--tg)] transition-opacity duration-[var(--dur-base)]',
          active ? 'opacity-100' : 'opacity-0',
        )}
      />
    </span>
  );
}

/** The `INR ⌄` / `USDT ⌄` selector beside each leg. Inert, like the rest. */
function UnitChip({ unit }: { unit: 'INR' | 'USDT' }) {
  return (
    <span className="flex shrink-0 items-center gap-1 rounded-[var(--radius-sm)] border border-[var(--color-line)] bg-[var(--color-paper)] px-2 py-1 text-[10.5px] font-semibold text-[var(--color-ink-2)]">
      {unit}
      <Icon name="chevron-down" className="h-3 w-3 text-[var(--color-ink-4)]" strokeWidth={2.2} />
    </span>
  );
}
