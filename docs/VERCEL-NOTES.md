# Why `vercel.json` says what it says

Two settings, and one deliberate omission that cost a broken deploy.

## ⚠ Never add `--omit=optional` to the install command

It was here once. It broke every build:

```
Cannot find module '@tailwindcss/oxide-linux-x64-gnu'
```

The reasoning that put it there was: `embedded-postgres` is an optional
dependency carrying 144 MB of PostgreSQL server binaries, nothing under
`src/` imports it, so skipping it should make builds faster.

The flaw is that **`--omit=optional` is not selective.** It drops optional
dependencies throughout the whole tree, and npm distributes platform-specific
native binaries precisely through `optionalDependencies` — one entry per
platform, so exactly one installs. `@tailwindcss/oxide` is a Rust module that
works this way, so the flag removed the Tailwind compiler for the build
platform and CSS compilation died.

Measured, not guessed:

| Install | `@tailwindcss/oxide-<platform>` |
|---|---|
| `npm ci` | present, under `@tailwindcss/postcss/node_modules/` |
| `npm ci --omit=optional` | **absent** |

The 144 MB is a build-time download only. Nothing imports the package, so
Next never traces it into a serverless function — the concern that motivated
the flag did not exist, and the flag broke something real to solve it.

**The lesson worth keeping:** the original claim of "verified rather than
assumed" was false. What had been tested was deleting `@embedded-postgres`
from `node_modules` by hand — not running the flag. Testing an approximation
of a change is not testing the change.

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
