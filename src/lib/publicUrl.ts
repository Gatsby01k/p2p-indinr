import 'server-only';
import { headers } from 'next/headers';

/**
 * The canonical public address of this deployment.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  A SHARED LINK OUTLIVES THE REQUEST THAT MADE IT.                  │
 * │                                                                    │
 * │  Deriving it from the request `Host` header seems right and is     │
 * │  wrong: whatever address the CREATOR happened to be browsing gets  │
 * │  baked into a link sent to someone else.                           │
 * │                                                                    │
 * │  On Vercel that breaks concretely. Every deployment also has a     │
 * │  unique URL — `project-abc123-team.vercel.app`, and the            │
 * │  `project-git-branch-team.vercel.app` alias. Those carry           │
 * │  Deployment Protection by default, so a recipient opening one is   │
 * │  bounced to a Vercel login page for a team they are not in. The    │
 * │  sender sees a working link; everyone else sees Vercel.            │
 * │                                                                    │
 * │  A deal link is the product. It must point at the one stable       │
 * │  address, whichever address its creator was using.                 │
 * └────────────────────────────────────────────────────────────────────┘
 */

/** Strip a trailing slash so callers can always append a rooted path. */
function normalise(origin: string): string | null {
  try {
    const url = new URL(origin.includes('://') ? origin : `https://${origin}`);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

/**
 * Resolve the origin, most trustworthy source first.
 *
 * 1. `NEXT_PUBLIC_SITE_URL` — an explicit decision, including a custom
 *    domain, which nothing else can know about.
 * 2. `VERCEL_PROJECT_PRODUCTION_URL` — Vercel's own stable production
 *    domain. Set on every deployment INCLUDING previews, and it always
 *    names production, which is exactly the property needed here: a link
 *    created while testing a preview still points somewhere a recipient
 *    can open.
 * 3. The request headers — correct in local development and for any host
 *    that is not behind a platform with a canonical name of its own.
 *
 * `x-forwarded-proto` may arrive as a comma-separated list when more than
 * one proxy is in the chain (`https,http`). Taking the whole value produced
 * `https,http://host/d/…`, a genuinely malformed link, so only the first
 * entry is used — the one the client actually spoke.
 */
export async function publicOrigin(): Promise<string> {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (explicit) {
    const normalised = normalise(explicit);
    if (normalised) return normalised;
  }

  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (vercel) {
    const normalised = normalise(vercel);
    if (normalised) return normalised;
  }

  const h = await headers();
  const host = h.get('host');
  if (host) {
    const proto = (h.get('x-forwarded-proto') ?? 'http').split(',')[0]!.trim();
    const normalised = normalise(`${proto}://${host}`);
    if (normalised) return normalised;
  }

  return 'http://localhost:3000';
}

/** An absolute URL for a rooted path, e.g. `/d/INRP-…`. */
export async function publicUrl(path: string): Promise<string> {
  const origin = await publicOrigin();
  return `${origin}${path.startsWith('/') ? path : `/${path}`}`;
}
