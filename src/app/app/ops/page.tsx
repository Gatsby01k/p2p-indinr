import { operatorQueue } from '@/server/sandbox/service';
import { currentUser } from '@/server/sandbox/session';
import { AccessDenied } from '@/components/sandbox/SandboxChrome';
import { formatMinor } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function OpsPage() {
  const user = await currentUser();

  /*
   * Authorization is decided BEFORE any queue data is fetched, so a denied
   * visitor's HTML never contains operator content at all — not hidden, not
   * collapsed, not present. Rendering the page and then overlaying a notice
   * would ship the queue to someone who may not see it.
   */
  if (!user || !user.isOperator) {
    return <AccessDenied signedIn={user !== null} />;
  }

  const queue = await operatorQueue(user);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">Operator queue</h1>
        <p className="mt-1 text-sm text-slate-600">
          Deals that cannot progress without a person. Nothing here resolves on a timer.
        </p>
      </div>

      {queue.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-600">
          Nothing is waiting.
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Reference</th>
                  <th className="px-4 py-2.5 font-medium">State</th>
                  <th className="px-4 py-2.5 text-right font-medium">Amount</th>
                  <th className="px-4 py-2.5 text-right font-medium">Waiting</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {queue.map((r) => (
                  <tr key={r.publicId}>
                    <td className="px-4 py-3 font-mono text-xs text-slate-700">{r.publicId}</td>
                    <td className="px-4 py-3 text-slate-700">
                      {r.state.replace(/_/g, ' ').toLowerCase()}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-900">
                      {formatMinor(r.usdtMinor, 'USDT')} USDT
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-600">
                      {r.waitingMinutes} min
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <p className="text-xs leading-relaxed text-slate-500">
        The queue deliberately carries no participant identities and no payment references — an
        operator triaging throughput does not need either.
      </p>
    </div>
  );
}
