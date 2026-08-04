import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { getLinkPreview, type PreviewStatus } from '@/server/sandbox/service';
import { currentUser } from '@/server/sandbox/session';
import { formatMinor } from '@/lib/format';
import { TopBar } from '@/components/kit/AppChrome';
import { JoinPanel } from '@/components/kit/JoinPanel';
import { ShareLink } from '@/components/kit/ShareLink';
import {
  ExchangeRail,
  Label,
  Money,
  Notice,
  SandboxChip,
  SandboxLine,
  Shell,
  Status,
  type Tone,
} from '@/components/kit/primitives';

/**
 * The public deal link — the product's shareable surface.
 *
 * Server-rendered from the database on every request, so status and
 * expiry are whatever the server says now. No client countdown gates
 * anything, and nothing is derived from the URL.
 *
 * ────────────────────────────────────────────────────────────────────
 * DISCLOSURE BOUNDARY. An unfurl is public, forwardable and cached by
 * intermediaries the sender does not control. This page and its metadata
 * carry the ECONOMIC TERMS ONLY, and never: identities (creator or
 * counterparty name or id), bank instructions, wallet addresses, UTRs or
 * payment proofs, dispute or case material. `getLinkPreview` returns none
 * of those, so they cannot leak here even by mistake.
 * ────────────────────────────────────────────────────────────────────
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
  const state =
    preview.displayStatus === 'OPEN'
      ? 'Open to one counterparty'
      : preview.displayStatus === 'CONSUMED'
        ? 'Already taken'
        : preview.displayStatus === 'EXPIRED'
          ? 'Expired'
          : 'Withdrawn';
  const title = `${send} → ${receive}`;
  const description = `${state}. Sandbox deal link — no real funds are held or moved.`;

  return {
    title,
    description,
    openGraph: {
      type: 'website',
      title: `INRP2P · ${title}`,
      description,
      siteName: 'INRP2P Sandbox',
    },
    twitter: { card: 'summary', title: `INRP2P · ${title}`, description },
    robots: { index: false, follow: false },
  };
}

const STATUS_META: Record<PreviewStatus, { tone: Tone; label: string; term: string }> = {
  OPEN: { tone: 'action', label: 'Open', term: 'Expires' },
  CONSUMED: { tone: 'idle', label: 'Already taken', term: 'Deadline was' },
  EXPIRED: { tone: 'hold', label: 'Expired', term: 'Expired' },
  CLOSED: { tone: 'idle', label: 'Withdrawn', term: 'Deadline was' },
};

export default async function DealLinkPage({ params }: Params) {
  const { publicId } = await params;
  const [preview, viewer, h] = await Promise.all([
    getLinkPreview(publicId),
    currentUser(),
    headers(),
  ]);

  if (!preview) {
    return (
      <Frame>
        <Notice
          tone="idle"
          title="This deal link does not exist"
          body="The reference in this address does not match any deal link."
          reassurance="Nothing was charged and no transaction exists for it."
          nextStep="Check the link you were sent, or ask the sender to reissue one."
          action={{ href: '/', label: 'Go to the calculator' }}
        />
      </Frame>
    );
  }

  const meta = STATUS_META[preview.displayStatus];
  const isCreator = false; // the preview deliberately carries no identity
  const host = h.get('host') ?? 'localhost';
  const proto = h.get('x-forwarded-proto') ?? 'http';
  const url = `${proto}://${host}/d/${preview.publicId}`;
  const headline = `${formatMinor(preview.usdtMinor, 'USDT')} USDT for ₹${formatMinor(preview.inrMinor, 'INR')}`;

  return (
    <Frame>
      <article
        className={`animate-rise overflow-hidden rounded-[var(--radius-lg)] border bg-[var(--color-paper)] ${
          preview.joinable ? 'border-[var(--color-rule)]' : 'border-[var(--color-line)]'
        }`}
      >
        {/* Identity of the offer — one status value, one badge. */}
        <header className="flex items-start justify-between gap-3 border-b border-[var(--color-line)] px-5 py-4 sm:px-6">
          <div>
            <Label>Deal link</Label>
            <h1 className="mt-1 text-[length:var(--text-lg)] font-semibold tracking-[-0.02em] text-[var(--color-ink)]">
              Sell USDT for INR
            </h1>
          </div>
          <Status tone={meta.tone}>{meta.label}</Status>
        </header>

        {/* The terms, as the product's core sentence. */}
        <div className={`px-5 py-5 sm:px-6 ${preview.joinable ? '' : 'opacity-70'}`}>
          <Label>They send</Label>
          <div className="mt-1.5">
            <Money
              value={formatMinor(preview.usdtMinor, 'USDT')}
              unit="USDT"
              size="lg"
              srLabel={`${formatMinor(preview.usdtMinor, 'USDT')} USDT`}
            />
          </div>

          <div className="my-4">
            <ExchangeRail
              caption={`${(Number(preview.rateNum) / Number(preview.rateDen)).toFixed(2)} INR / USDT`}
              live={preview.joinable}
            />
          </div>

          <Label>They receive</Label>
          <p className="tnum mt-1.5 text-[length:var(--text-4xl)] font-semibold tracking-[-0.03em] text-[var(--color-ink)]">
            <span aria-hidden>₹</span>
            {formatMinor(preview.inrMinor, 'INR')}
            <span className="sr-only">{formatMinor(preview.inrMinor, 'INR')} rupees</span>
          </p>
        </div>

        {/* Facts. Deliberately no identity of any kind. */}
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 border-t border-[var(--color-line)] px-5 py-4 sm:px-6">
          <div>
            <dt className="text-[length:var(--text-2xs)] text-[var(--color-ink-4)]">Reference</dt>
            <dd className="mt-0.5 font-mono text-[length:var(--text-xs)] text-[var(--color-ink)]">
              {preview.publicId}
            </dd>
          </div>
          <div>
            <dt className="text-[length:var(--text-2xs)] text-[var(--color-ink-4)]">{meta.term}</dt>
            <dd className="tnum mt-0.5 text-[length:var(--text-xs)] text-[var(--color-ink)]">
              {new Date(preview.expiresAt).toLocaleString('en-IN', {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
            </dd>
          </div>
          <div>
            <dt className="text-[length:var(--text-2xs)] text-[var(--color-ink-4)]">Your side</dt>
            <dd className="mt-0.5 text-[length:var(--text-xs)] text-[var(--color-ink)]">
              {preview.viewerWouldBe === 'FIAT_SIDE' ? 'Send the INR' : 'Supply the USDT'}
            </dd>
          </div>
          <div>
            <dt className="text-[length:var(--text-2xs)] text-[var(--color-ink-4)]">Settlement</dt>
            <dd className="mt-0.5 text-[length:var(--text-xs)] text-[var(--color-ink)]">
              Bank transfer, simulated
            </dd>
          </div>
        </dl>

        {/* The one action, or the reason there is none. */}
        <div className="border-t border-[var(--color-line)] bg-[var(--color-sunken)] px-5 py-5 sm:px-6">
          <JoinPanel
            publicId={preview.publicId}
            joinable={preview.joinable}
            status={preview.displayStatus}
            signedIn={viewer !== null}
            viewerWouldBe={preview.viewerWouldBe}
          />
        </div>
      </article>

      {preview.joinable ? (
        <div className="mt-4">
          <ShareLink url={url} headline={headline} canJoin={!isCreator} />
        </div>
      ) : null}

      <SandboxLine className="mt-4" full />
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <TopBar suffix="Sandbox" right={<SandboxChip />} />
      <main id="main" className="flex-1 py-6 sm:py-10">
        <Shell width="form">{children}</Shell>
      </main>
    </div>
  );
}
