import type { Metadata } from 'next';
import Link from 'next/link';
import { dealIdForLink, getLinkPreview } from '@/services';
import { currentUser } from '@/services';
import { formatMinor } from '@/lib/format';
import { PREVIEW_META, leg, previewHeadline, rateLabel, settlementLegs } from '@/lib/dealPresenter';
import { SCENARIO } from '@/lib/scenario';
import { miniAppDealLink } from '@/lib/miniApp';
import { publicUrl } from '@/lib/publicUrl';
import { TopBar } from '@/components/kit/AppChrome';
import { ToastProvider } from '@/components/kit/Feedback';
import { AssetMark, Icon } from '@/components/kit/Icon';
import { JoinPanel } from '@/components/kit/JoinPanel';
import { ShareLink } from '@/components/kit/ShareLink';
import { Deadline } from '@/components/kit/Time';
import {
  ActionLink,
  Avatar,
  Callout,
  Card,
  Fact,
  Facts,
  Label,
  Notice,
  SandboxChip,
  SandboxLine,
  Shell,
  Status,
  Stepper,
  TotalRow,
  VerifiedTick,
} from '@/components/kit/primitives';

/**
 * The public deal link — the product's shareable surface.
 *
 * Server-rendered from the database on every request, so status and expiry
 * are whatever the server says now. No client countdown gates anything, and
 * nothing is derived from the URL.
 *
 * ────────────────────────────────────────────────────────────────────
 * DISCLOSURE BOUNDARY. An unfurl is public, forwardable and cached by
 * intermediaries the sender does not control. THE METADATA CARRIES THE
 * ECONOMIC TERMS ONLY. The page itself will name the creator to a SIGNED-IN
 * reader — who is about to become their counterparty and is entitled to know
 * — and to nobody else. Bank instructions, wallet addresses, UTRs, proofs
 * and dispute material never appear here at all: `getLinkPreview` does not
 * return them, so they cannot leak even by mistake.
 * ────────────────────────────────────────────────────────────────────
 */

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ publicId: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { publicId } = await params;
  // Deliberately anonymous: this call is what builds the unfurl.
  const preview = await getLinkPreview(publicId);

  if (!preview) {
    return { title: 'Deal link', robots: { index: false, follow: false } };
  }

  const state =
    preview.displayStatus === 'OPEN'
      ? 'Open to one counterparty'
      : preview.displayStatus === 'CONSUMED'
        ? 'Already taken'
        : preview.displayStatus === 'EXPIRED'
          ? 'Expired'
          : 'Withdrawn';
  const title = previewHeadline(preview);
  const description = `${state}. Protected deal on INRP2P — sandbox build, no real funds are held or moved.`;

  return {
    title,
    description,
    openGraph: {
      type: 'website',
      title: `INRP2P · ${title}`,
      description,
      siteName: 'INRP2P DealSafe India',
    },
    twitter: { card: 'summary', title: `INRP2P · ${title}`, description },
    robots: { index: false, follow: false },
  };
}

export default async function DealLinkPage({ params }: Params) {
  const { publicId } = await params;
  const viewer = await currentUser();
  const preview = await getLinkPreview(publicId, viewer);

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

  const meta = PREVIEW_META[preview.displayStatus];
  const scenario = SCENARIO[preview.direction];
  // The canonical address, never the one this viewer happens to be on:
  // a deal link is forwarded to someone else, and a Vercel deployment URL
  // would bounce them to a login page for a team they are not in.
  const url = await publicUrl(`/d/${preview.publicId}`);
  const headline = previewHeadline(preview);
  const settle = settlementLegs(preview);
  const usdt = leg(preview.usdtMinor, 'USDT');

  // A viewer who already holds a seat in the deal this link became should
  // land in the room, not stare at a "taken" notice about their own deal.
  const existingDeal = viewer ? await dealIdForLink(viewer, preview.publicId) : null;

  /* -------- The creator's own view: share it -------------------- */
  if (preview.viewerIsCreator) {
    return (
      <Frame>
        <Card className="animate-rise text-center">
          <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-[var(--color-final-tint)] text-[var(--color-final)]">
            <Icon name="shield-check" className="h-7 w-7" strokeWidth={1.9} />
          </span>
          <h1 className="mt-4 text-[length:var(--text-xl)] font-semibold tracking-[-0.025em] text-[var(--color-ink)]">
            Your deal is protected
          </h1>
          <p className="mt-1.5 text-[length:var(--text-base)] leading-relaxed text-[var(--color-ink-2)]">
            Share the link so the other person can join. Only one of them can.
          </p>

          <div className="mt-5">
            <Stepper
              steps={[
                { key: 'created', label: 'Created', state: 'done' },
                { key: 'secured', label: 'Secured', state: 'done' },
                { key: 'shared', label: 'Shared', state: 'now' },
                {
                  key: 'joined',
                  label: 'Joined',
                  state: preview.displayStatus === 'CONSUMED' ? 'done' : 'todo',
                },
              ]}
            />
          </div>
        </Card>

        {preview.joinable ? (
          <Card className="mt-3">
            <ShareLink
              url={url}
              headline={headline}
              miniAppUrl={miniAppDealLink(preview.publicId)}
            />
          </Card>
        ) : (
          <Notice
            className="mt-3"
            tone={preview.displayStatus === 'CONSUMED' ? 'final' : 'hold'}
            title={
              preview.displayStatus === 'CONSUMED'
                ? 'Someone has taken this deal'
                : `This link is ${meta.label.toLowerCase()}`
            }
            body={
              preview.displayStatus === 'CONSUMED'
                ? 'Your counterparty joined. The deal has moved to its own room.'
                : 'Nobody joined before it closed, so no deal exists for it.'
            }
            nextStep={
              preview.displayStatus === 'CONSUMED'
                ? 'Open the deal room to see what happens next.'
                : 'Create a fresh deal if you still want to trade.'
            }
            action={
              existingDeal
                ? { href: `/app/deal/${existingDeal}`, label: 'Open the deal room' }
                : { href: '/app/new', label: 'Create a new deal' }
            }
          />
        )}

        <TermsCard preview={preview} settle={settle} usdt={usdt} />

        <div className="mt-3 flex gap-2">
          <ActionLink href="/app/deals" variant="outline" size="md" full>
            All deals
          </ActionLink>
          <ActionLink href="/app/new" variant="outline" size="md" full>
            New deal
          </ActionLink>
        </div>
        <SandboxLine className="mt-3" full />
      </Frame>
    );
  }

  /* -------- Already a participant: go to the room --------------- */
  if (existingDeal) {
    return (
      <Frame>
        <Notice
          tone="final"
          title="You are already in this deal"
          body="This link was taken — by you. The deal has its own room."
          nextStep="Open the deal room to see whose move it is."
          action={{ href: `/app/deal/${existingDeal}`, label: 'Open the deal room' }}
        />
      </Frame>
    );
  }

  /* -------- The joiner's view ------------------------------------ */
  /*
   * What the viewer would send and receive, PER SCENARIO.
   *
   * A protected INR → INR payment has no second asset: the payer sends
   * rupees and receives the work, the payee receives rupees and sends
   * nothing. Reusing the exchange's two-legged shape here printed
   * "You receive 0 USDT" on a deal with no USDT leg at all — the single
   * most alarming thing this screen could tell someone about to commit.
   */
  const isPayer = preview.viewerWouldBe === 'FIAT_SIDE';
  const sending = isPayer ? settle.payerSends.display : scenario.hasRate ? usdt.display : null;
  const receiving = isPayer
    ? scenario.hasRate
      ? usdt.display
      : null
    : settle.payeeReceives.display;
  // What the person commits to, for the join panel's own sentence.
  const commitment = isPayer ? settle.payerSends.display : (sending ?? settle.amount.display);

  return (
    <Frame>
      <article className="animate-rise">
        <Card flush className={preview.joinable ? '' : 'opacity-95'}>
          <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--color-line)] px-4 py-3.5 sm:px-5">
            <div className="min-w-0 flex-1 basis-full sm:basis-auto">
              <Label>Protected deal</Label>
              <h1 className="mt-0.5 truncate text-[length:var(--text-lg)] font-semibold tracking-[-0.02em] text-[var(--color-ink)]">
                {preview.title?.trim() || scenario.title}
              </h1>
            </div>
            <Status tone={meta.tone}>{meta.label}</Status>
          </header>

          {/* The terms, as the product's core sentence. */}
          <div className="px-4 py-5 sm:px-5">
            <p className="text-center text-[length:var(--text-3xl)] font-semibold tracking-[-0.03em] text-[var(--color-ink)] sm:text-[length:var(--text-4xl)]">
              <span className="tnum">{settle.amount.display}</span>
              <span className="sr-only"> {settle.amount.srLabel}</span>
            </p>

            {preview.direction !== 'INR_TO_INR' ? (
              <div className="mt-4 flex items-center justify-center gap-3">
                <span className="flex items-center gap-1.5">
                  <AssetMark asset={scenario.from} size="sm" />
                  <span className="tnum text-[length:var(--text-base)] font-medium text-[var(--color-ink-2)]">
                    {scenario.from === 'INR' ? settle.amount.display : usdt.display}
                  </span>
                </span>
                <Icon
                  name="arrow-right"
                  className="h-4 w-4 text-[var(--color-ink-4)]"
                  strokeWidth={2}
                />
                <span className="flex items-center gap-1.5">
                  <AssetMark asset={scenario.to} size="sm" />
                  <span className="tnum text-[length:var(--text-base)] font-medium text-[var(--color-ink-2)]">
                    {scenario.to === 'INR' ? settle.amount.display : usdt.display}
                  </span>
                </span>
              </div>
            ) : null}

            {/* Who made this — a signed-in reader only. */}
            {preview.creatorName ? (
              <div className="mt-5 flex items-center justify-center gap-2.5 rounded-[var(--radius-md)] bg-[var(--color-sunken)] px-3 py-2.5">
                <Avatar name={preview.creatorName} size="sm" verified={preview.creatorVerified} />
                <div className="min-w-0 text-left">
                  <p className="truncate text-[length:var(--text-sm)] font-semibold text-[var(--color-ink)]">
                    {preview.creatorName}
                  </p>
                  <p className="text-[length:var(--text-2xs)] text-[var(--color-ink-3)]">
                    Created this deal
                    {preview.creatorVerified ? ' · ' : ''}
                    {preview.creatorVerified ? <VerifiedTick label="Verified" /> : null}
                  </p>
                </div>
              </div>
            ) : null}
          </div>

          {/* Your side of it. */}
          <div className="border-t border-[var(--color-line)] px-4 py-4 sm:px-5">
            <Facts>
              <Fact term="Your role" strong>
                {scenario.roleLabel[preview.viewerWouldBe]}
              </Fact>
              {sending ? (
                <Fact term="You send" strong>
                  <span className="tnum">{sending}</span>
                </Fact>
              ) : null}
              {receiving ? (
                <Fact term="You receive" strong>
                  <span className="tnum">{receiving}</span>
                </Fact>
              ) : null}
              {!scenario.hasRate ? (
                <Fact term={isPayer ? 'They receive' : 'They pay'}>
                  <span className="tnum">
                    {isPayer ? settle.payeeReceives.display : settle.payerSends.display}
                  </span>
                </Fact>
              ) : null}
              {scenario.hasRate ? (
                <Fact term="Firm rate">
                  <span className="tnum">{rateLabel(preview)}</span>
                </Fact>
              ) : null}
              <Fact term={meta.term}>
                <Deadline iso={preview.expiresAt} />
              </Fact>
              <Fact term="Reference" mono>
                {preview.publicId}
              </Fact>
            </Facts>
          </div>

          {/* The one action, or the reason there is none. */}
          <div className="border-t border-[var(--color-line)] bg-[var(--color-sunken)] px-4 py-4 sm:px-5">
            <JoinPanel
              publicId={preview.publicId}
              joinable={preview.joinable}
              status={preview.displayStatus}
              signedIn={viewer !== null}
              viewerWouldBe={preview.viewerWouldBe}
              scenario={preview.direction}
              amountLabel={commitment}
            />
          </div>
        </Card>
      </article>

      {/* What protection means, for someone meeting the product here. */}
      {preview.joinable ? (
        <Card className="mt-3">
          <h2 className="text-[length:var(--text-base)] font-semibold text-[var(--color-ink)]">
            What happens next
          </h2>
          <ol className="mt-3 space-y-3">
            {NEXT_STEPS.map((s, i) => (
              <li key={s.title} className="flex gap-3">
                <span
                  aria-hidden
                  className="tnum mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[var(--color-brand-tint)] text-[length:var(--text-2xs)] font-bold text-[var(--color-brand)]"
                >
                  {i + 1}
                </span>
                <span className="min-w-0">
                  <span className="block text-[length:var(--text-sm)] font-semibold text-[var(--color-ink)]">
                    {s.title}
                  </span>
                  <span className="mt-0.5 block text-[length:var(--text-xs)] leading-relaxed text-[var(--color-ink-3)]">
                    {s.body}
                  </span>
                </span>
              </li>
            ))}
          </ol>
          <Callout tone="info" icon="lock" className="mt-4">
            Only one verified person can join this link. Bank details and payment references are
            never shown here — they exist only inside the deal room, to the two sides.
          </Callout>
        </Card>
      ) : null}

      <SandboxLine className="mt-3" full />
      <p className="mt-4 text-center text-[length:var(--text-xs)] text-[var(--color-ink-3)]">
        <Link href="/" className="font-medium underline underline-offset-4">
          What is INRP2P?
        </Link>
      </p>
    </Frame>
  );
}

const NEXT_STEPS = [
  { title: 'Join', body: 'You take the other side of this protected deal.' },
  { title: 'Secure', body: 'The value is held against the deal, not released to anyone.' },
  { title: 'Complete', body: 'Both sides confirm what they did, in the deal room.' },
  { title: 'Release', body: 'The receiving side confirms, and the deal closes with a receipt.' },
];

function TermsCard({
  preview,
  settle,
  usdt,
}: {
  preview: Awaited<ReturnType<typeof getLinkPreview>> & object;
  settle: ReturnType<typeof settlementLegs>;
  usdt: ReturnType<typeof leg>;
}) {
  const scenario = SCENARIO[preview.direction];
  return (
    <Card className="mt-3">
      <h2 className="text-[length:var(--text-base)] font-semibold text-[var(--color-ink)]">
        Locked terms
      </h2>
      <Facts className="mt-1">
        <Fact term="Deal type">{scenario.title}</Fact>
        {preview.title?.trim() ? <Fact term="Purpose">{preview.title.trim()}</Fact> : null}
        <Fact term="Amount">
          <span className="tnum">{settle.amount.display}</span>
        </Fact>
        {scenario.hasRate ? (
          <Fact term="Firm rate">
            <span className="tnum">{rateLabel(preview)}</span>
          </Fact>
        ) : null}
        {scenario.hasRate ? (
          <Fact term="Crypto leg">
            <span className="tnum">{usdt.display}</span>
          </Fact>
        ) : null}
        <Fact term="Protection fee">
          <span className="tnum">₹{formatMinor(preview.protectionFeeMinor, 'INR')}</span>
        </Fact>
        <Fact term="Link expires">
          <Deadline iso={preview.expiresAt} />
        </Fact>
      </Facts>
      <div className="mt-3">
        <TotalRow term="Payer sends">{settle.payerSends.display}</TotalRow>
      </div>
    </Card>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <div className="flex min-h-dvh flex-col">
        <TopBar suffix="DealSafe India" right={<SandboxChip />} />
        <main id="main" className="flex-1 py-5 sm:py-8">
          <Shell width="form">{children}</Shell>
        </main>
      </div>
    </ToastProvider>
  );
}
