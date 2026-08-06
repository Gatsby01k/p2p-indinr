import Link from 'next/link';
import { currentUser } from '@/server/sandbox/session';
import { operatorCase } from '@/server/sandbox/ops';
import { getChrome } from '@/server/sandbox/chrome';
import { SandboxFailure } from '@/lib/sandboxContract';
import { DISPUTE_REASON_COPY } from '@/lib/sandboxContract';
import { formatMinor } from '@/lib/format';
import { DEAL_STATE } from '@/lib/dealPresenter';
import { SCENARIO } from '@/lib/scenario';
import { cn } from '@/lib/cn';
import { AppHeader } from '@/components/kit/AppChrome';
import { Icon } from '@/components/kit/Icon';
import { Ago, Deadline } from '@/components/kit/Time';
import { ToastProvider } from '@/components/kit/Feedback';
import { RulingPanel } from '@/components/flows/RulingPanel';
import {
  Avatar,
  Callout,
  Card,
  Fact,
  Facts,
  Label,
  Notice,
  Shell,
  Status,
} from '@/components/kit/primitives';

export const dynamic = 'force-dynamic';

/**
 * One operator case.
 *
 * Three columns of exactly what a ruling needs, in the order it is needed:
 * the FACTS of the deal, the TRAIL of what happened, and the DECISION.
 *
 * ⚠ This is the product's widest disclosure. It shows the parties, the
 * payment reference and every attached file — so it is available only for a
 * deal that is genuinely blocked (awaiting action or disputed), it is
 * refused for a completed private deal between two people, and opening it
 * writes an `OPERATOR_CASE_OPEN` row to the audit trail. All three of those
 * are enforced in `operatorCase`, not here.
 */
export default async function OperatorCasePage({
  params,
}: {
  params: Promise<{ dealId: string }>;
}) {
  const { dealId } = await params;
  const user = await currentUser();

  if (!user?.isOperator) {
    return (
      <Shell width="prose" className="py-10">
        <Notice
          tone="risk"
          title="This area is restricted to operators"
          body="No case data was loaded for this request."
          reassurance="No transaction was affected."
          nextStep="Sign in with an operator account, or return to your deals."
          action={{ href: '/app', label: 'Back to your deals' }}
        />
      </Shell>
    );
  }

  const { unread } = await getChrome();

  let kase;
  try {
    kase = await operatorCase(user, dealId);
  } catch (err) {
    const message = err instanceof SandboxFailure ? err.message : 'That case could not be opened.';
    return (
      <>
        <AppHeader
          title="Case unavailable"
          back={{ href: '/app/ops', label: 'Back to the desk' }}
        />
        <Shell width="prose" className="py-8">
          <Notice
            tone="idle"
            title="This case is not open to review"
            body={message}
            reassurance="No participant data was loaded, and nothing was changed."
            nextStep="Only blocked deals — awaiting action or disputed — can be opened here. A settled deal is private to its two sides."
            action={{ href: '/app/ops', label: 'Back to the desk' }}
          />
        </Shell>
      </>
    );
  }

  const meta = DEAL_STATE[kase.state];
  const scenario = SCENARIO[kase.direction];
  const payer = kase.parties.find((p) => p.role === 'FIAT_SIDE');
  const payee = kase.parties.find((p) => p.role === 'CRYPTO_SIDE');

  return (
    <ToastProvider>
      <AppHeader
        title={kase.dealCode}
        subtitle={`${scenario.short} · ₹${formatMinor(kase.inrMinor, 'INR')}`}
        back={{ href: '/app/ops', label: 'Back to the desk' }}
        unread={unread}
        actions={
          <span className="hidden sm:inline-flex">
            <Status tone={meta.tone}>{meta.label}</Status>
          </span>
        }
      />

      <Shell width="ops" className="py-5 sm:py-7">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)_minmax(0,23rem)] lg:items-start">
          {/* ============ Column 1 · the facts ==================== */}
          <div className="space-y-4">
            <Card>
              <Label>Protected amount</Label>
              <p className="tnum mt-1 text-[length:var(--text-3xl)] font-semibold tracking-[-0.03em] text-[var(--color-ink)]">
                ₹{formatMinor(kase.inrMinor, 'INR')}
              </p>
              {kase.usdtMinor ? (
                <p className="tnum mt-0.5 text-[length:var(--text-base)] text-[var(--color-ink-3)]">
                  {formatMinor(kase.usdtMinor, 'USDT')} USDT
                </p>
              ) : null}

              <Facts className="mt-3">
                <Fact term="Deal">{scenario.title}</Fact>
                {kase.title ? <Fact term="Purpose">{kase.title}</Fact> : null}
                <Fact term="Protection fee">
                  <span className="tnum">₹{formatMinor(kase.protectionFeeMinor, 'INR')}</span>
                </Fact>
                <Fact term="Opened">
                  <Ago iso={kase.createdAt} />
                </Fact>
                {kase.actionDeadline ? (
                  <Fact term="Deadline">
                    <Deadline iso={kase.actionDeadline} />
                  </Fact>
                ) : null}
                <Fact term="Reference" mono>
                  {kase.publicId}
                </Fact>
              </Facts>
            </Card>

            <Card>
              <h2 className="text-[length:var(--text-base)] font-semibold text-[var(--color-ink)]">
                Participants
              </h2>
              <ul className="mt-3 space-y-3">
                {[payer, payee].filter(Boolean).map((p) => (
                  <li key={p!.role} className="flex items-center gap-3">
                    <Avatar name={p!.name} size="sm" verified={p!.verified} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[length:var(--text-sm)] font-semibold capitalize text-[var(--color-ink)]">
                        {p!.name}
                      </p>
                      <p className="truncate text-[length:var(--text-2xs)] text-[var(--color-ink-3)]">
                        {scenario.roleLabel[p!.role]} · {p!.completedDeals} completed
                      </p>
                    </div>
                    {p!.verified ? (
                      <Icon
                        name="shield-check"
                        className="h-4 w-4 shrink-0 text-[var(--color-final)]"
                      />
                    ) : (
                      <span className="shrink-0 text-[length:var(--text-2xs)] font-semibold text-[var(--color-hold)]">
                        Unverified
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </Card>

            {kase.claim ? (
              <Card>
                <h2 className="text-[length:var(--text-base)] font-semibold text-[var(--color-ink)]">
                  Payment claim
                </h2>
                <Facts className="mt-1">
                  <Fact term="Reference" mono>
                    {kase.claim.utr}
                  </Fact>
                  <Fact term="Submitted">
                    <Ago iso={kase.claim.submittedAt} />
                  </Fact>
                  {kase.claim.note ? <Fact term="Note">{kase.claim.note}</Fact> : null}
                </Facts>
                <Callout tone="info" icon="info" className="mt-3">
                  A UTR is unique platform-wide, so this reference has never been claimed on another
                  deal.
                </Callout>
              </Card>
            ) : (
              <Card tone="sunken">
                <p className="text-[length:var(--text-sm)] text-[var(--color-ink-3)]">
                  No payment has been claimed on this deal.
                </p>
              </Card>
            )}
          </div>

          {/* ============ Column 2 · the trail ==================== */}
          <div className="space-y-4">
            {kase.dispute ? (
              <Card className="border-[var(--color-risk-line)]">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Label>Disputed</Label>
                    <h2 className="mt-0.5 text-[length:var(--text-lg)] font-semibold text-[var(--color-ink)]">
                      {DISPUTE_REASON_COPY[kase.dispute.reason].label}
                    </h2>
                    <p className="mt-0.5 text-[length:var(--text-xs)] text-[var(--color-ink-3)]">
                      Raised by <span className="capitalize">{kase.dispute.raisedByName}</span> ·{' '}
                      <Ago iso={kase.dispute.raisedAt} />
                    </p>
                  </div>
                  <Status tone={kase.dispute.state === 'RESOLVED' ? 'final' : 'risk'}>
                    {kase.dispute.state === 'RESOLVED'
                      ? (kase.dispute.resolution ?? 'Resolved')
                      : 'Open'}
                  </Status>
                </div>
                {kase.dispute.detail ? (
                  <p className="mt-3 rounded-[var(--radius-md)] bg-[var(--color-sunken)] p-3 text-[length:var(--text-sm)] leading-relaxed text-[var(--color-ink-2)]">
                    {kase.dispute.detail}
                  </p>
                ) : null}
              </Card>
            ) : null}

            {/* ---- Evidence trail ------------------------------- */}
            <Card>
              <h2 className="text-[length:var(--text-base)] font-semibold text-[var(--color-ink)]">
                Evidence trail
                <span className="tnum ml-2 text-[length:var(--text-xs)] font-normal text-[var(--color-ink-4)]">
                  {kase.evidence.length}
                </span>
              </h2>
              {kase.evidence.length === 0 ? (
                <p className="mt-2 text-[length:var(--text-sm)] text-[var(--color-ink-3)]">
                  Neither side has attached a file.
                </p>
              ) : (
                <ul className="mt-3 space-y-2">
                  {kase.evidence.map((file) => (
                    <li key={file.evidenceId}>
                      <a
                        href={`/api/evidence/${file.evidenceId}`}
                        className="press flex items-center gap-3 rounded-[var(--radius-md)] border border-[var(--color-line)] p-3 hover:bg-[var(--color-sunken)]"
                      >
                        <Icon
                          name="file"
                          className="h-[18px] w-[18px] shrink-0 text-[var(--color-ink-3)]"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[length:var(--text-sm)] font-medium text-[var(--color-ink)]">
                            {file.filename}
                          </span>
                          <span className="block truncate text-[length:var(--text-2xs)] text-[var(--color-ink-3)]">
                            <span className="capitalize">{file.uploadedByName}</span> ·{' '}
                            <Ago iso={file.uploadedAt} /> ·{' '}
                            <span className="font-mono">{file.sha256.slice(0, 12)}…</span>
                          </span>
                        </span>
                        <Icon
                          name="download"
                          className="h-4 w-4 shrink-0 text-[var(--color-ink-4)]"
                        />
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            {/* ---- The conversation ----------------------------- */}
            <Card flush>
              <h2 className="border-b border-[var(--color-line)] px-4 py-3 text-[length:var(--text-base)] font-semibold text-[var(--color-ink)] sm:px-5">
                Party statements
                <span className="tnum ml-2 text-[length:var(--text-xs)] font-normal text-[var(--color-ink-4)]">
                  {kase.messages.filter((m) => m.kind === 'CHAT').length}
                </span>
              </h2>
              <div className="max-h-[24rem] space-y-2.5 overflow-y-auto px-4 py-4 sm:px-5">
                {kase.messages.length === 0 ? (
                  <p className="text-[length:var(--text-sm)] text-[var(--color-ink-3)]">
                    Nothing has been said on this deal.
                  </p>
                ) : null}
                {kase.messages.map((m, i) =>
                  m.kind === 'SYSTEM' ? (
                    <p
                      key={i}
                      className="mx-auto w-fit rounded-[var(--radius-full)] bg-[var(--color-sunken)] px-3 py-1 text-center text-[length:var(--text-2xs)] text-[var(--color-ink-3)]"
                    >
                      {m.body}
                    </p>
                  ) : (
                    <div key={i} className="flex items-start gap-2.5">
                      <Avatar name={m.authorName ?? '?'} size="xs" />
                      <div className="min-w-0 flex-1">
                        <p className="text-[length:var(--text-2xs)] capitalize text-[var(--color-ink-3)]">
                          {m.authorName} · <Ago iso={m.sentAt} />
                        </p>
                        <p className="mt-0.5 rounded-[var(--radius-md)] bg-[var(--color-sunken)] px-3 py-2 text-[length:var(--text-sm)] leading-relaxed text-[var(--color-ink)]">
                          {m.body}
                        </p>
                      </div>
                    </div>
                  ),
                )}
              </div>
            </Card>
          </div>

          {/* ============ Column 3 · the decision ================= */}
          <div className="space-y-4">
            {kase.state === 'DISPUTED' && kase.dispute?.state !== 'RESOLVED' ? (
              <RulingPanel dealId={kase.dealId} dealCode={kase.dealCode} />
            ) : (
              <Card>
                <h2 className="text-[length:var(--text-base)] font-semibold text-[var(--color-ink)]">
                  No ruling is possible
                </h2>
                <p className="mt-1.5 text-[length:var(--text-sm)] leading-relaxed text-[var(--color-ink-2)]">
                  This deal is not under dispute, so there is nothing for an operator to decide. It
                  is here because it is waiting on one of its two sides.
                </p>
                <Callout tone="info" icon="clock" className="mt-3">
                  Nothing on this desk resolves on a timer. If a deadline passes, the deal stays
                  where it is until a person acts or a problem is reported.
                </Callout>
              </Card>
            )}

            {/* ---- Audit trail ---------------------------------- */}
            <Card>
              <h2 className="text-[length:var(--text-base)] font-semibold text-[var(--color-ink)]">
                Audit trail
              </h2>
              <p className="mt-1 text-[length:var(--text-xs)] text-[var(--color-ink-3)]">
                Append-only. Rejections are recorded alongside successes.
              </p>
              <ol className="mt-3 space-y-2.5">
                {kase.timeline.map((entry, i) => (
                  <li key={i} className="flex gap-2.5">
                    <span
                      aria-hidden
                      className={cn(
                        'mt-1 h-2 w-2 shrink-0 rounded-full',
                        entry.outcome === 'OK'
                          ? 'bg-[var(--color-final)]'
                          : 'bg-[var(--color-risk)]',
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-[length:var(--text-xs)] font-semibold text-[var(--color-ink)]">
                        {entry.action.replace(/_/g, ' ').toLowerCase()}
                        {entry.outcome !== 'OK' ? (
                          <span className="ml-1.5 font-normal text-[var(--color-risk)]">
                            {entry.outcome.replace(/_/g, ' ').toLowerCase()}
                          </span>
                        ) : null}
                      </p>
                      <p className="mt-0.5 text-[length:var(--text-2xs)] text-[var(--color-ink-3)]">
                        {entry.actorName ? (
                          <span className="capitalize">{entry.actorName}</span>
                        ) : (
                          'system'
                        )}
                        {entry.toState ? ` → ${entry.toState.toLowerCase()}` : ''} ·{' '}
                        <Ago iso={entry.at} />
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            </Card>

            <Link
              href="/app/ops"
              prefetch={false}
              className="flex items-center justify-center gap-1.5 text-[length:var(--text-sm)] font-medium text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
            >
              <Icon name="chevron-left" className="h-3.5 w-3.5" strokeWidth={2.2} />
              Back to the desk
            </Link>
          </div>
        </div>
      </Shell>
    </ToastProvider>
  );
}
