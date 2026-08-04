import { createLinkAction } from '@/server/sandbox/actions';
import { requireUser } from '@/server/sandbox/session';
import { BottomNav } from '@/components/kit/AppChrome';
import { NewDealForm } from '@/components/kit/NewDealForm';
import { Label, Notice, Rail, SandboxLine, Shell } from '@/components/kit/primitives';

export const dynamic = 'force-dynamic';

/**
 * Create a deal link.
 *
 * One dominant decision — the amount — with the consequences of that
 * decision kept in view beside it. Direction is fixed for this sandbox
 * (you supply USDT, they send INR), so it is stated as context rather
 * than offered as a choice that has only one option.
 *
 * NO RATE IS CARRIED HERE. Whatever the visitor saw on the calculator was
 * indicative; `createLinkAction` asks the server for a fresh firm quote
 * with its own server-controlled expiry at the moment the link is made.
 */
export default async function NewDealPage({
  searchParams,
}: {
  searchParams: Promise<{ amount?: string; error?: string }>;
}) {
  const user = await requireUser();
  const { amount, error } = await searchParams;

  return (
    <>
      <Shell width="content" className="py-6 sm:py-8">
        <div className="mx-auto max-w-[46rem]">
          <div className="flex items-center gap-3">
            <h1 className="text-[length:var(--text-2xl)] font-semibold tracking-[-0.025em] text-[var(--color-ink)]">
              Create a deal link
            </h1>
            <Rail className="flex-1" live />
          </div>
          <p className="mt-1.5 max-w-[54ch] text-[length:var(--text-sm)] leading-relaxed text-[var(--color-ink-3)]">
            You supply the USDT. Whoever opens the link sends you the INR, and exactly one person
            can take it.
          </p>

          {error === 'amount' ? (
            <Notice
              className="mt-5"
              tone="risk"
              title="That amount is not valid"
              body="An amount must be a number of USDT with up to six decimal places."
              reassurance="Nothing was created and no rate was requested."
              nextStep="Enter something like 500 or 12.5, then create the link again."
            />
          ) : null}

          <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_17rem] lg:items-start">
            <NewDealForm action={createLinkAction} defaultAmount={amount ?? '500'} />

            {/* Context, not decoration: what happens after this button. */}
            <aside className="rounded-[var(--radius-lg)] border border-[var(--color-line)] bg-[var(--color-paper)] p-4">
              <Label>What happens next</Label>
              <ol className="mt-3 space-y-3">
                {AFTER.map((s, i) => (
                  <li key={s} className="flex gap-2.5">
                    <span className="tnum mt-px text-[length:var(--text-2xs)] font-semibold text-[var(--color-ink-4)]">
                      {i + 1}
                    </span>
                    <span className="text-[length:var(--text-xs)] leading-relaxed text-[var(--color-ink-2)]">
                      {s}
                    </span>
                  </li>
                ))}
              </ol>
              <SandboxLine className="mt-4" full />
            </aside>
          </div>
        </div>
      </Shell>
      <BottomNav active="new" isOperator={user.isOperator} />
    </>
  );
}

const AFTER = [
  'The server issues a firm rate and fixes both amounts.',
  'You get a link with its own expiry.',
  'You share it — WhatsApp, Telegram, anywhere.',
  'The first eligible person to open it takes the other side.',
];
