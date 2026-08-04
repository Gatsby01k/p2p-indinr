import Link from 'next/link';
import { SandboxBanner } from '@/components/sandbox/SandboxChrome';
import { Calculator } from '@/components/sandbox/Calculator';

/**
 * Landing.
 *
 * MOBILE: the calculator is the FIRST element in the document, so it lands
 * inside the first viewport without scrolling. The narrative sits beneath it —
 * someone who arrived to check a rate should not have to scroll past a pitch
 * to reach the one control they came for.
 *
 * DESKTOP: a two-column grid at `lg` with the calculator on the right (via
 * `order`), the copy given real width, a three-up feature row and a full-width
 * container — rather than one narrow card adrift in empty space.
 */
export default function HomePage() {
  return (
    <div className="flex min-h-dvh flex-col bg-white">
      <SandboxBanner />

      <header className="border-b border-slate-200">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6">
          <span className="text-sm font-semibold tracking-tight text-slate-900">
            INRP2P <span className="font-normal text-slate-400">Sandbox</span>
          </span>
          <Link
            href="/login"
            className="inline-flex h-9 items-center rounded-lg bg-slate-900 px-3.5 text-sm font-medium text-white hover:bg-slate-800"
          >
            Sign in
          </Link>
        </div>
      </header>

      <main id="main" className="flex-1">
        <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-10 lg:py-14">
          <div className="grid items-start gap-8 lg:grid-cols-[1.05fr_minmax(360px,1fr)] lg:gap-14">
            {/* First in DOM ⇒ first viewport on mobile; ordered right on desktop. */}
            <div className="lg:order-2">
              <Calculator />
            </div>

            <div className="lg:order-1 lg:pt-2">
              <p className="text-sm font-medium text-slate-500">INR ⇄ USDT settlement</p>
              <h1 className="mt-2 text-3xl font-semibold leading-tight tracking-tight text-slate-900 sm:text-4xl lg:text-5xl">
                Send a link.
                <br className="hidden sm:block" /> Settle the deal.
              </h1>
              <p className="mt-4 max-w-xl text-base leading-relaxed text-slate-600 sm:text-lg">
                Every deal is a link you paste into any chat. The other side opens it, sees the
                exact amounts, and joins. No order book, no browsing, no strangers you did not
                choose.
              </p>

              <dl className="mt-8 grid gap-x-8 gap-y-6 sm:grid-cols-3">
                <Feature
                  term="Exact amounts"
                  detail="You send and you receive. No fee line, because the desk pays it."
                />
                <Feature
                  term="One winner, always"
                  detail="Two people opening the same link cannot both join. The database decides, not a button."
                />
                <Feature
                  term="A record every time"
                  detail="Rate, counterparty and reference, stored server-side and kept after reload."
                />
              </dl>

              <div className="mt-8 rounded-xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-sm font-medium text-slate-900">This is a sandbox</p>
                <p className="mt-1 text-sm leading-relaxed text-slate-600">
                  The journey works end to end and persists — quote, link, join, payment claim,
                  confirmation, completion. What is deliberately absent is money: there is no
                  ledger, no custody, no blockchain and no bank connection anywhere in it.
                </p>
              </div>
            </div>
          </div>
        </div>
      </main>

      <footer className="border-t border-slate-200">
        <div className="mx-auto max-w-6xl px-4 py-6 text-xs leading-relaxed text-slate-500 sm:px-6">
          Sandbox build. No regulatory registrations, licences or partnerships are claimed or
          implied. Nothing here is an offer to trade, and no funds are held.
        </div>
      </footer>
    </div>
  );
}

function Feature({ term, detail }: { term: string; detail: string }) {
  return (
    <div>
      <dt className="text-sm font-semibold text-slate-900">{term}</dt>
      <dd className="mt-1 text-sm leading-relaxed text-slate-600">{detail}</dd>
    </div>
  );
}
