import { getChrome } from '@/services';
import { AppHeader } from '@/components/kit/AppChrome';
import { Icon, type IconName } from '@/components/kit/Icon';
import {
  ActionLink,
  Callout,
  Card,
  SandboxLine,
  SectionHead,
  Shell,
} from '@/components/kit/primitives';

export const dynamic = 'force-dynamic';

/**
 * Help and support.
 *
 * Written to answer the questions people actually arrive with in a product
 * that holds money in the middle of a deal — "where is my money", "they are
 * not responding", "what does protected mean" — rather than to list
 * features.
 *
 * Every answer states what the SYSTEM guarantees, not what we hope happens.
 * Where the sandbox differs from a live deployment, it says so in the same
 * breath rather than in a footnote.
 */
export default async function HelpPage() {
  const { unread } = await getChrome();

  return (
    <>
      <AppHeader
        title="Help and support"
        back={{ href: '/app/profile', label: 'Back to profile' }}
        unread={unread}
      />

      <Shell width="content" className="py-5 sm:py-7">
        {/* ---- Straight to the point ----------------------------- */}
        <div className="grid gap-3 sm:grid-cols-3">
          {QUICK.map((q) => (
            <Card key={q.title} className="h-full">
              <span className="grid h-10 w-10 place-items-center rounded-full bg-[var(--color-sunken)] text-[var(--color-ink-2)]">
                <Icon name={q.icon} className="h-[18px] w-[18px]" />
              </span>
              <h2 className="mt-3 text-[length:var(--text-base)] font-semibold text-[var(--color-ink)]">
                {q.title}
              </h2>
              <p className="mt-1 text-[length:var(--text-xs)] leading-relaxed text-[var(--color-ink-3)]">
                {q.body}
              </p>
              <ActionLink href={q.href} variant="outline" size="sm" className="mt-3">
                {q.cta}
              </ActionLink>
            </Card>
          ))}
        </div>

        {/* ---- How protection works ------------------------------ */}
        <section className="mt-8" id="terms">
          <SectionHead title="Protection terms" />
          <Card className="mt-3">
            <ol className="space-y-4">
              {TERMS.map((t, i) => (
                <li key={t.title} className="flex gap-3">
                  <span
                    aria-hidden
                    className="tnum mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[var(--color-brand-tint)] text-[length:var(--text-2xs)] font-bold text-[var(--color-brand)]"
                  >
                    {i + 1}
                  </span>
                  <div className="min-w-0">
                    <h3 className="text-[length:var(--text-base)] font-semibold text-[var(--color-ink)]">
                      {t.title}
                    </h3>
                    <p className="mt-1 text-[length:var(--text-sm)] leading-relaxed text-[var(--color-ink-2)]">
                      {t.body}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </Card>
        </section>

        {/* ---- Questions ----------------------------------------- */}
        <section className="mt-8">
          <SectionHead title="Common questions" />
          <Card className="mt-3" flush seam>
            {FAQ.map((item) => (
              <details key={item.q} className="group">
                <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3.5 hover:bg-[var(--color-sunken)] sm:px-5">
                  <span className="min-w-0 flex-1 text-[length:var(--text-base)] font-medium text-[var(--color-ink)]">
                    {item.q}
                  </span>
                  <Icon
                    name="chevron-down"
                    className="h-4 w-4 shrink-0 text-[var(--color-ink-4)] transition-transform duration-[var(--dur-fast)] group-open:rotate-180"
                  />
                </summary>
                <p className="px-4 pb-4 text-[length:var(--text-sm)] leading-relaxed text-[var(--color-ink-2)] sm:px-5">
                  {item.a}
                </p>
              </details>
            ))}
          </Card>
        </section>

        {/* ---- Fraud ---------------------------------------------- */}
        <section className="mt-8">
          <SectionHead title="Staying safe" />
          <Card className="mt-3">
            <ul className="space-y-3">
              {SAFETY.map((s) => (
                <li key={s} className="flex gap-2.5">
                  <Icon
                    name="shield-check"
                    className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-final)]"
                  />
                  <span className="text-[length:var(--text-sm)] leading-relaxed text-[var(--color-ink-2)]">
                    {s}
                  </span>
                </li>
              ))}
            </ul>
            <Callout tone="risk" icon="lock" className="mt-4">
              <strong className="font-semibold">
                INRP2P will never ask for a PIN, a password or a card number.
              </strong>{' '}
              No screen in this product has a field for one.
            </Callout>
          </Card>
        </section>

        {/* ---- Contact -------------------------------------------- */}
        <section className="mt-8">
          <SectionHead title="Still stuck?" />
          <Card className="mt-3">
            <p className="text-[length:var(--text-sm)] leading-relaxed text-[var(--color-ink-2)]">
              If a deal is going wrong, the fastest route is the deal itself: a message in the deal
              chat reaches the other side immediately, and reporting a problem puts a person on the
              case with every message and file already attached.
            </p>
            <div className="mt-4 flex flex-col gap-2 sm:flex-row">
              <ActionLink href="/app/deals?filter=action" variant="primary" size="md" icon="deals">
                Open a deal that needs you
              </ActionLink>
              <ActionLink href="/app/deals?filter=problem" variant="outline" size="md" icon="flag">
                See reported problems
              </ActionLink>
            </div>
            <p className="mt-4 text-[length:var(--text-xs)] leading-relaxed text-[var(--color-ink-3)]">
              This is a sandbox build with no support desk behind it. A live deployment would put
              its contact route here.
            </p>
          </Card>
        </section>

        <SandboxLine className="mt-6" full />
      </Shell>
    </>
  );
}

const QUICK: readonly { title: string; body: string; cta: string; href: string; icon: IconName }[] =
  [
    {
      title: 'Where is my money?',
      body: 'Every deal shows its exact state and whose move it is. Open the deal and the answer is the first thing on the screen.',
      cta: 'Open my deals',
      href: '/app/deals',
      icon: 'search',
    },
    {
      title: 'They are not responding',
      body: 'Message them in the deal chat first. If the deadline passes with nothing happening, report a problem and an operator reviews it.',
      cta: 'Deals waiting on someone',
      href: '/app/deals?filter=live',
      icon: 'message',
    },
    {
      title: 'Something went wrong',
      body: 'Reporting a problem pauses release immediately. Nothing is reversed automatically — a person decides, with a written reason.',
      cta: 'How disputes work',
      href: '#terms',
      icon: 'flag',
    },
  ];

const TERMS = [
  {
    title: 'The terms are fixed when the deal is created',
    body: 'Amounts, fees and the rate are frozen on the server and copied into the deal unchanged. No later step re-derives a figure from a rate, so what you agreed to is what settles.',
  },
  {
    title: 'Exactly one person can join a link',
    body: 'The database decides the winner, not the button. Anyone who opens the link a moment too late is told it was taken, and nothing is charged to them.',
  },
  {
    title: 'Value is protected, not transferred',
    body: 'Protection means the value is held against the deal and released only when the receiving side confirms — or when an operator rules on a dispute. Nothing is released on a timer.',
  },
  {
    title: 'Only your side can act',
    body: 'The payer marks the payment; the receiver confirms it arrived. The server refuses the other action outright, so neither side can move the deal on the other’s behalf.',
  },
  {
    title: 'Reporting a problem pauses everything',
    body: 'A dispute stops release for both sides. An operator reads the messages, the payment reference and every attached file, then rules: released, refunded or cancelled — with a reason you both see.',
  },
  {
    title: 'The record cannot be edited',
    body: 'Every transition and every refusal is written to an append-only audit trail. Not even an operator can update or delete a row in it.',
  },
];

const FAQ = [
  {
    q: 'What does the protection fee pay for?',
    a: 'Holding the value against the deal, the dispute process behind it, and the operator time a contested deal consumes. It is 1.50% of a protected payment (minimum ₹25, maximum ₹2,000), or 1.25% plus a flat network fee on an exchange. The figure is fixed at creation and shown before you commit.',
  },
  {
    q: 'What happens if the payer never pays?',
    a: 'Nothing is released. The payment window lapses and the deal is marked expired — it does not complete, and it does not quietly refund either. If money did leave your account and the deal still lapsed, report a problem so a person can look at it.',
  },
  {
    q: 'Can I cancel a deal?',
    a: 'Only before anyone has marked a payment. After that, cancelling would strand a real transfer, so the route is a dispute instead — which pauses release and puts an operator on it.',
  },
  {
    q: 'Why can I not see who created a link before I sign in?',
    a: 'A shared link is public and forwardable, and its preview is cached by messaging apps we do not control. The unfurl carries the economic terms only. Once you sign in — at which point you are about to become the counterparty — the page names them.',
  },
  {
    q: 'What is a UTR, and why does it have to be unique?',
    a: 'It is the 12-character reference your bank puts on a transfer. It is checked against every other deal on the platform, so one transfer can only ever be claimed once. Reusing a reference is a fraud signal, and the database refuses it outright.',
  },
  {
    q: 'Are SafePoints money?',
    a: 'No. They cannot be bought, sold, transferred or withdrawn, and there is no cash payout. They discount this platform’s own fees and nothing else — ten points is ₹1 off a future protection fee.',
  },
  {
    q: 'Is this real?',
    a: 'This build is a sandbox. No funds are held or moved, no bank or blockchain connection exists, and sign-in authenticates nobody. Do not send a real payment to anything you see here.',
  },
];

const SAFETY = [
  'Pay only from an account in your own name. A transfer from a third party cannot be matched to your deal.',
  'Send exactly the amount shown. A different figure has to be resolved by hand and delays everything.',
  'Keep the conversation in the deal chat. It is part of the record if a problem is reported; a WhatsApp thread is not.',
  'Attach the receipt while you still have it. Evidence added early resolves a dispute in minutes rather than days.',
  'Never share your UPI PIN, card number, CVV or banking password with anyone, including someone claiming to be support.',
];
