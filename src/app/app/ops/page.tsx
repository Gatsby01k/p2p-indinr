import { operatorQueue } from '@/server/sandbox/service';
import { currentUser } from '@/server/sandbox/session';
import { formatMinor } from '@/lib/format';
import { BottomNav, DeskNav } from '@/components/kit/AppChrome';
import { ActionLink, Label, Notice, Shell, Status, type Tone } from '@/components/kit/primitives';
import { QueueKeys } from '@/components/kit/QueueKeys';

export const dynamic = 'force-dynamic';

/**
 * Operator queue — settlement operations, not an admin table.
 *
 * Scan order matches how an operator triages: age first (what is going
 * stale), then who owes the move, then the amount at stake. Rows are a
 * semantic table so it stays keyboard- and screen-reader-navigable, but
 * each row leads with a rule-weight age column rather than a checkbox.
 *
 * Authorization is decided BEFORE any queue data is fetched, so a denied
 * visitor's HTML never contains operator content at all — not hidden, not
 * collapsed, not present.
 */
export default async function OpsPage() {
  const user = await currentUser();

  if (!user || !user.isOperator) {
    return (
      <Shell width="prose" className="py-10 sm:py-16">
        <div data-testid="access-denied">
          <p className="tnum text-[length:var(--text-5xl)] font-semibold tracking-[-0.04em] text-[var(--color-ink-4)]">
            403
          </p>
          <Notice
            className="mt-4"
            tone="risk"
            title="This area is restricted to operators"
            body={
              user
                ? 'Your account does not have operator permissions, so the queue was never loaded.'
                : 'You are not signed in, so the queue was never loaded.'
            }
            reassurance="No operator data was sent to this page, and no transaction was affected."
            nextStep={
              user
                ? 'If you should have operator access, ask an administrator to grant it. Otherwise return to your deals.'
                : 'Sign in with an operator account. In this sandbox, any address starting with ops@ is an operator.'
            }
            action={
              user
                ? { href: '/app', label: 'Back to your deals' }
                : { href: '/login?next=/app/ops', label: 'Sign in' }
            }
          />
        </div>
      </Shell>
    );
  }

  const queue = await operatorQueue(user);
  const stale = queue.filter((r) => r.waitingMinutes >= 30).length;

  return (
    <>
      <Shell width="ops" className="py-6 sm:py-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-[length:var(--text-2xl)] font-semibold tracking-[-0.025em] text-[var(--color-ink)]">
              Queue
            </h1>
            <p className="mt-1 text-[length:var(--text-sm)] text-[var(--color-ink-3)]">
              Deals that cannot progress without a person. Nothing here resolves on a timer.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <DeskNav active="ops" isOperator />
            <dl className="flex items-center gap-4">
              <div className="text-right">
                <dt className="text-[length:var(--text-2xs)] text-[var(--color-ink-4)]">Open</dt>
                <dd className="tnum text-[length:var(--text-lg)] font-semibold text-[var(--color-ink)]">
                  {queue.length}
                </dd>
              </div>
              <div className="text-right">
                <dt className="text-[length:var(--text-2xs)] text-[var(--color-ink-4)]">
                  Over 30m
                </dt>
                <dd
                  className={`tnum text-[length:var(--text-lg)] font-semibold ${
                    stale > 0 ? 'text-[var(--color-risk)]' : 'text-[var(--color-ink)]'
                  }`}
                >
                  {stale}
                </dd>
              </div>
            </dl>
          </div>
        </div>

        {queue.length === 0 ? (
          <div className="mt-6 rounded-[var(--radius-lg)] border border-dashed border-[var(--color-rule)] bg-[var(--color-paper)] p-12 text-center">
            <Label>Clear</Label>
            <p className="mt-2 text-[length:var(--text-sm)] text-[var(--color-ink-2)]">
              Nothing is waiting on an operator.
            </p>
          </div>
        ) : (
          <div className="mt-5 overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-line)] bg-[var(--color-paper)]">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[52rem] border-collapse text-[length:var(--text-sm)]">
                <caption className="sr-only">
                  Deals awaiting action, oldest first. {queue.length} open.
                </caption>
                <thead>
                  <tr className="border-b border-[var(--color-rule)] bg-[var(--color-sunken)] text-left">
                    <Th className="w-[5rem]">Age</Th>
                    <Th className="w-[8.5rem]">Reference</Th>
                    <Th className="w-[13rem]">Waiting on</Th>
                    <Th>Pressure</Th>
                    <Th className="w-[10.5rem]">State</Th>
                    <Th className="w-[8rem] text-right">USDT</Th>
                    <Th className="w-[9rem] text-right">INR</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-line)]">
                  {queue.map((r) => {
                    const hot = r.waitingMinutes >= 30;
                    const tone: Tone = r.state === 'FIAT_CLAIMED' ? 'hold' : 'idle';
                    return (
                      <tr
                        key={r.publicId}
                        tabIndex={0}
                        data-queue-row
                        className="outline-none transition-colors hover:bg-[var(--color-sunken)] focus-visible:bg-[var(--color-sunken)]"
                      >
                        <Td>
                          <span
                            className={`tnum font-semibold ${
                              hot ? 'text-[var(--color-risk)]' : 'text-[var(--color-ink-2)]'
                            }`}
                          >
                            {r.waitingMinutes}m
                          </span>
                          {hot ? <span className="sr-only"> — over the 30 minute mark</span> : null}
                        </Td>
                        <Td>
                          <span className="font-mono text-[length:var(--text-xs)] text-[var(--color-ink-2)]">
                            {r.publicId}
                          </span>
                        </Td>
                        <Td>
                          <span className="text-[var(--color-ink)]">
                            {r.state === 'FIAT_PENDING' ? 'INR sender' : 'USDT supplier'}
                          </span>
                          <span className="ml-1.5 text-[var(--color-ink-3)]">
                            {r.state === 'FIAT_PENDING' ? 'to pay' : 'to confirm'}
                          </span>
                        </Td>
                        <Td>
                          {/* Age against the 60-minute review horizon.
                              `aria-hidden` because the Age column already
                              states the same fact in words. */}
                          <div
                            aria-hidden
                            className="rail-progress"
                            data-tone={hot ? 'risk' : undefined}
                          >
                            <span
                              style={{
                                width: `${Math.min(100, Math.round((r.waitingMinutes / 60) * 100))}%`,
                              }}
                            />
                          </div>
                        </Td>
                        <Td>
                          <Status tone={tone}>
                            {r.state === 'FIAT_PENDING' ? 'Awaiting payment' : 'Awaiting confirm'}
                          </Status>
                        </Td>
                        <Td className="text-right">
                          <span className="tnum font-medium text-[var(--color-ink)]">
                            {formatMinor(r.usdtMinor, 'USDT')}
                          </span>
                          <span className="ml-1 text-[length:var(--text-2xs)] text-[var(--color-ink-3)]">
                            USDT
                          </span>
                        </Td>
                        <Td className="text-right">
                          <span className="tnum font-medium text-[var(--color-ink)]">
                            ₹{formatMinor(r.inrMinor, 'INR')}
                          </span>
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {queue.length > 0 ? <QueueKeys /> : null}
        <p className="mt-4 max-w-[68ch] text-[length:var(--text-xs)] leading-relaxed text-[var(--color-ink-3)]">
          The queue deliberately carries no participant identities and no payment references. An
          operator triaging throughput does not need either, so the server does not send them.
        </p>
        <ActionLink href="/app" variant="quiet" size="sm" className="mt-3 md:hidden">
          Back to your deals
        </ActionLink>
      </Shell>
      <BottomNav active="ops" isOperator />
    </>
  );
}

function Th({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      scope="col"
      className={`px-3 py-2.5 text-[length:var(--text-2xs)] font-medium uppercase tracking-[0.07em] text-[var(--color-ink-4)] ${className}`}
    >
      {children}
    </th>
  );
}

function Td({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-3 align-middle ${className}`}>{children}</td>;
}
