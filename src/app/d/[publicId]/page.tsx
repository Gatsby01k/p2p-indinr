import type { Metadata } from 'next';
import Link from 'next/link';
import { getLinkPreview } from '@/server/sandbox/service';
import { currentUser } from '@/server/sandbox/session';
import { BlockedState, LinkStatusBadge, SandboxBanner } from '@/components/sandbox/SandboxChrome';
import { JoinPanel } from '@/components/sandbox/JoinPanel';
import { formatMinor } from '@/lib/format';

/**
 * Public, unauthenticated deal link.
 *
 * Server-rendered from the database on every request, so status and expiry are
 * whatever the server says right now — never a client countdown, and never a
 * value derived from the URL.
 *
 * ─────────────────────────────────────────────────────────────────────
 * DISCLOSURE BOUNDARY. An unfurl is public, forwardable and cached by
 * intermediaries. This page's metadata carries the economic terms ONLY, and
 * never: identities (creator or counterparty name/id), bank instructions,
 * wallet addresses, UTRs or payment proofs, dispute or case material.
 * `getLinkPreview` does not return any of those, so they cannot leak here.
 * Enforced by tests/publicMetadata.test.ts.
 * ─────────────────────────────────────────────────────────────────────
 */

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ publicId: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { publicId } = await params;
  const preview = await getLinkPreview(publicId);

  if (!preview) {
    return { title: 'Deal link', robots: { index: false, follow: false } };
  }

  const send = `${formatMinor(preview.usdtMinor, 'USDT')} USDT`;
  const receive = `₹${formatMinor(preview.inrMinor, 'INR')}`;
  const title = `Sell USDT · ${send} → ${receive}`;

  return {
    title,
    description: `Sandbox deal link. ${send} for ${receive}. No real funds are held or moved.`,
    openGraph: {
      type: 'website',
      title: `INRP2P Sandbox · ${title}`,
      description: `${send} for ${receive}. Sandbox only — no real funds.`,
      siteName: 'INRP2P Sandbox',
    },
    twitter: { card: 'summary', title: `INRP2P Sandbox · ${title}` },
    robots: { index: false, follow: false },
  };
}

export default async function DealLinkPage({ params }: Params) {
  const { publicId } = await params;
  const [preview, viewer] = await Promise.all([getLinkPreview(publicId), currentUser()]);

  return (
    <div className="flex min-h-dvh flex-col bg-slate-50">
      <SandboxBanner />
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex h-14 max-w-3xl items-center px-4 sm:px-6">
          <Link href="/" className="text-sm font-semibold tracking-tight text-slate-900">
            INRP2P <span className="font-normal text-slate-400">Sandbox</span>
          </Link>
        </div>
      </header>

      <main id="main" className="flex-1">
        <div className="mx-auto w-full max-w-xl px-4 py-8 sm:px-6 sm:py-12">
          {!preview ? (
            <BlockedState
              title="This deal link does not exist"
              reason="The reference in this URL does not match any deal link."
              nextStep="Check the link you were sent, or ask the sender to reissue it."
              action={{ href: '/', label: 'Go to the calculator' }}
            />
          ) : (
            <article className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
              <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4 sm:px-6">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                    Deal link
                  </p>
                  <h1 className="mt-1 text-lg font-semibold tracking-tight text-slate-900">
                    Sell USDT for INR
                  </h1>
                </div>
                {/* Exactly one badge, from exactly one server value. */}
                <LinkStatusBadge status={preview.displayStatus} />
              </div>

              <div className="space-y-4 px-5 py-5 sm:px-6">
                <Row label="They send" value={`${formatMinor(preview.usdtMinor, 'USDT')} USDT`} />
                <div className="flex items-center gap-3">
                  <span className="h-px flex-1 bg-slate-200" />
                  <span className="tabular-nums text-xs font-medium text-slate-500">
                    {(Number(preview.rateNum) / Number(preview.rateDen)).toFixed(2)} INR / USDT
                  </span>
                  <span className="h-px flex-1 bg-slate-200" />
                </div>
                <Row
                  label="They receive"
                  value={`₹${formatMinor(preview.inrMinor, 'INR')}`}
                  emphasis
                />

                <dl className="grid grid-cols-2 gap-4 border-t border-slate-200 pt-4 text-sm">
                  <Meta term="Reference" detail={preview.publicId} />
                  <Meta term="Payment method" detail="Bank transfer (simulated)" />
                  {/*
                    The deadline label must agree with the status badge. A
                    CONSUMED link is not "Expired" — it was taken, and its
                    deadline is now merely historical. Deriving this label from
                    the same single status value is what keeps the two from
                    contradicting each other.
                  */}
                  <Meta
                    term={
                      preview.displayStatus === 'OPEN'
                        ? 'Expires'
                        : preview.displayStatus === 'EXPIRED'
                          ? 'Expired'
                          : 'Deadline was'
                    }
                    detail={new Date(preview.expiresAt).toLocaleString('en-IN', {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })}
                  />
                </dl>

                <p className="rounded-lg bg-slate-50 px-3 py-2.5 text-xs leading-relaxed text-slate-600">
                  In a live deal the USDT would be held against this link until the receiver
                  confirms payment or an operator rules.{' '}
                  <strong className="font-medium">Here nothing is held and nothing moves.</strong>
                </p>
              </div>

              <div className="border-t border-slate-200 bg-slate-50 px-5 py-5 sm:px-6">
                <JoinPanel
                  publicId={preview.publicId}
                  joinable={preview.joinable}
                  status={preview.displayStatus}
                  signedIn={viewer !== null}
                  viewerWouldBe={preview.viewerWouldBe}
                />
              </div>
            </article>
          )}
        </div>
      </main>
    </div>
  );
}

function Row({ label, value, emphasis }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-sm text-slate-500">{label}</span>
      <span
        className={
          emphasis
            ? 'text-2xl font-semibold tabular-nums tracking-tight text-slate-900'
            : 'text-lg font-medium tabular-nums text-slate-900'
        }
      >
        {value}
      </span>
    </div>
  );
}

function Meta({ term, detail }: { term: string; detail: string }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{term}</dt>
      <dd className="mt-0.5 font-medium text-slate-900">{detail}</dd>
    </div>
  );
}
