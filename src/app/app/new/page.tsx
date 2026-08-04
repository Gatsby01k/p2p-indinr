import { createLinkAction } from '@/server/sandbox/actions';
import { requireUser } from '@/server/sandbox/session';
import { SandboxNote } from '@/components/sandbox/SandboxChrome';

export const dynamic = 'force-dynamic';

/**
 * Create a deal link.
 *
 * The rate is NOT carried here from the calculator. Whatever the visitor saw
 * before signing in was indicative and is not binding; the server issues a
 * fresh firm quote inside `createLinkAction` at the moment the link is made,
 * with its own server-controlled expiry.
 */
export default async function NewDealPage({
  searchParams,
}: {
  searchParams: Promise<{ amount?: string; error?: string }>;
}) {
  await requireUser();
  const { amount, error } = await searchParams;

  return (
    <div className="mx-auto max-w-lg">
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <h1 className="text-lg font-semibold tracking-tight text-slate-900">Create a deal link</h1>
        <p className="mt-1.5 text-sm leading-relaxed text-slate-600">
          You supply the USDT. Whoever opens the link sends you the INR. A firm rate is issued by
          the server when the link is created — nothing you saw earlier is binding.
        </p>

        <SandboxNote className="mt-4" />

        {error === 'amount' ? (
          <div
            role="alert"
            className="mt-4 rounded-lg border border-amber-500/30 bg-amber-50 px-3 py-2.5"
          >
            <p className="text-sm font-semibold text-amber-900">That amount is not valid.</p>
            <p className="mt-1 text-sm text-amber-900">
              Enter a number of USDT with up to six decimal places, for example 500 or 12.5.
            </p>
          </div>
        ) : null}

        <form action={createLinkAction} className="mt-5 space-y-4">
          <label className="block">
            <span className="text-xs font-medium text-slate-700">You supply</span>
            <div className="mt-1 flex items-center gap-2">
              <input
                name="usdt"
                defaultValue={amount ?? '500'}
                inputMode="decimal"
                required
                aria-label="USDT amount"
                className="h-12 w-full rounded-lg border border-slate-300 px-3 text-lg tabular-nums"
              />
              <span className="shrink-0 rounded-lg bg-slate-100 px-3 py-3 text-sm font-medium text-slate-700">
                USDT
              </span>
            </div>
          </label>

          <button
            type="submit"
            className="h-12 w-full rounded-lg bg-slate-900 text-sm font-medium text-white hover:bg-slate-800"
          >
            Issue rate and create link
          </button>
        </form>

        <p className="mt-4 text-xs leading-relaxed text-slate-500">
          The link expires on a server-side deadline. Exactly one person can join it; if two people
          open it at once, the database picks the winner and tells the other honestly.
        </p>
      </div>
    </div>
  );
}
