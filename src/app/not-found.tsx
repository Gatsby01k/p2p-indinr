import Link from 'next/link';
import { SandboxBanner } from '@/components/sandbox/SandboxChrome';

export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col bg-slate-50">
      <SandboxBanner />
      <main id="main" className="flex flex-1 items-center">
        <div className="mx-auto max-w-md px-4 py-16 text-center">
          <p className="text-5xl font-semibold tracking-tight text-slate-300">404</p>
          <h1 className="mt-3 text-xl font-semibold text-slate-900">That page does not exist</h1>
          <p className="mt-2 text-sm leading-relaxed text-slate-600">
            The address may be mistyped, or the deal link may have been reissued.
          </p>
          <Link
            href="/"
            className="mt-5 inline-flex h-10 items-center rounded-lg bg-slate-900 px-4 text-sm font-medium text-white hover:bg-slate-800"
          >
            Go to the calculator
          </Link>
        </div>
      </main>
    </div>
  );
}
