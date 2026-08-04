import Link from 'next/link';
import { listDealsForUser } from '@/server/sandbox/service';
import { requireUser } from '@/server/sandbox/session';
import { formatMinor } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function DealsPage() {
  const user = await requireUser();
  const deals = await listDealsForUser(user);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">Your deals</h1>
          <p className="mt-1 text-sm text-slate-600">
            Stored server-side. These survive a reload and a restart.
          </p>
        </div>
        <Link
          href="/app/new"
          className="inline-flex h-10 items-center rounded-lg bg-slate-900 px-4 text-sm font-medium text-white hover:bg-slate-800"
        >
          Create a deal link
        </Link>
      </div>

      {deals.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center">
          <p className="text-sm font-medium text-slate-900">No deals yet</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-slate-600">
            Create a deal link and send it to someone, or open a link you were sent.
          </p>
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {deals.map((d) => (
            <li key={d.dealId}>
              <Link
                href={`/app/deal/${d.dealId}`}
                className="block rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-slate-300 hover:shadow"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="font-mono text-xs text-slate-500">{d.publicId}</span>
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
                    {d.state.replace(/_/g, ' ').toLowerCase()}
                  </span>
                </div>
                <p className="mt-2 text-lg font-semibold tabular-nums tracking-tight text-slate-900">
                  {formatMinor(d.usdtMinor, 'USDT')} USDT
                </p>
                <p className="text-sm tabular-nums text-slate-600">
                  ₹{formatMinor(d.inrMinor, 'INR')}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  You are the {d.viewerRole === 'FIAT_SIDE' ? 'INR sender' : 'USDT supplier'}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
