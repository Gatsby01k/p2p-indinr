# Why `vercel.json` says what it says

Three settings, each with a reason worth writing down.

## `installCommand: npm ci --omit=optional`

`embedded-postgres` is an **optional** dependency carrying 144 MB of real
PostgreSQL 18 server binaries. It exists so `npm run db:start` can run a
genuine database locally without Docker or Homebrew.

Nothing under `src/` imports it — only `scripts/db.mjs` does, and that script
never runs on a deployment. Installing it on every build would download
144 MB, slow each deploy, and put a database server inside a serverless
bundle that must never contain one.

Verified rather than assumed: the production build was run with the package
removed from `node_modules` entirely, and compiled successfully.

`npm ci` rather than `npm install` because the lockfile is committed and a
deployment should install exactly what was tested, not whatever resolves
today.

## `regions: ["iad1"]`

Washington DC — **chosen to match the database, not the users.**

The instinct is to put functions near the people using them, which for an
INR product would be `bom1` (Mumbai). That instinct is wrong here. Every
page in this app is `force-dynamic` and issues several queries, so a request
costs *one* user-to-function hop and *several* function-to-database hops.
Putting the function far from the database multiplies the expensive one.

The Neon project is in `us-east-1`, so the functions sit in `iad1` beside it.

**Change both together, or neither.** If the database moves to
`ap-south-1`, change this to `bom1` in the same commit — that is the version
that is genuinely faster for Indian users, and it is only faster because the
database moved too.

## `framework: nextjs`

Explicit rather than auto-detected, so a future dependency change cannot
silently alter how the project is built.

---

## What is deliberately NOT here

**No `crons`.** The lapsed-payment-window sweep runs on authenticated
navigation instead (see `sweepLapsedDeals`). That is honest for a sandbox
with no worker process, and it releases, refunds and completes nothing — so
there is nothing a missed cron could strand.

**No `headers`.** They are set in `next.config.ts`, where the reasoning about
`frame-ancestors` and Telegram lives next to the code it protects. Splitting
security headers across two files is how one of them gets forgotten.

**No `env`.** Secrets belong in the project's environment settings, never in
a committed file.
