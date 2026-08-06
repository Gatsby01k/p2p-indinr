# Known issues and deliberate decisions

## Route-level `loading.tsx` is not used on `force-dynamic` routes

**Symptom.** Navigating to the same authenticated route twice — a refresh, or
clicking "Deals" while already on Deals — left the page showing its loading
skeleton permanently. The content was present in the DOM inside a `hidden`
element; the Suspense reveal never ran, and a further reload did not clear it.

**Reproduction** (Next 15.5.22, `next start`, route with `export const dynamic
= 'force-dynamic'` plus a sibling `loading.tsx`):

```
sign in            → /app renders
navigate to /app   → renders
navigate to /app   → stuck on the skeleton, permanently
```

The server was never at fault: it rendered `/app` in ~10 ms and the response
body contained the full markup.

**Resolution.** The route-level `loading.tsx` files were removed. With the
boundary gone every navigation resolves. These routes are `force-dynamic` and
streamed, so the shell still paints immediately from the layout while the page
body streams in — the skeleton was buying very little and costing correctness.

**If a skeleton is wanted back**, do it with an explicit `<Suspense>` *inside*
the page around only the data-dependent subtree, rather than as a route-level
boundary. That form does not exhibit the defect, and it is better anyway: the
heading and primary action paint at once instead of the whole screen blanking.

`src/components/kit/primitives.tsx` still exports `Skeleton`, which is what
such a boundary should use.

---

## `npm audit`: three high-severity advisories

`next`, `postcss` and `sharp`, all fixed only by `next@16` — a major upgrade
not attempted here. The **critical** advisory (CVE-2025-66478) is cleared by
the current `next@15.5.22`. Neither `sharp` nor the image-optimisation
advisories are on this application's path: it uses no `next/image`.

---

## A repository path containing `#`

Breaks the Next build tracer (it produces a null byte in the path) and Vite's
module resolver. Clone into a path without one.
