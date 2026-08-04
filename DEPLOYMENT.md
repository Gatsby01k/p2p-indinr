# Deploying the INRP2P sandbox

This app needs a PostgreSQL database and three environment variables. It will
**build** without them and **fail at runtime**, which is deliberate — each
missing value is a safety property failing closed rather than degrading into
something that looks functional but is not.

> **This is a sandbox.** It holds no funds, moves no money, and contains no
> ledger, custody, blockchain or bank integration. Do not put it in front of
> anyone as a live financial product.

---

## 1. Provision a database

Any hosted PostgreSQL works. Free tiers that suit this app:

| Provider | Notes |
|---|---|
| **Neon** | Serverless Postgres, scales to zero. Use the *pooled* connection string. |
| **Supabase** | Use the **Connection pooling** string (port 6543), not the direct one. |
| **Vercel Postgres** | Sets `POSTGRES_URL`; copy it into `DATABASE_URL`. |

Connection pooling matters: every serverless function instance opens its own
pool, so a direct connection string exhausts the database's connection limit
under any real traffic. The app already sizes its pool small (`max: 3`) when
it detects a non-loopback host, but a pooled endpoint is still the right
choice.

## 2. Apply the schema

Once, from your machine, pointing at the hosted database:

```bash
DATABASE_URL='postgres://…' npm run db:migrate
```

It prints `migrating REMOTE database: <host>` before it does anything, so a
mistargeted run is visible immediately. Migrations are idempotent — a second
run reports `schema up to date`.

`db:start`, `db:stop` and `db:reset` refuse to act when `DATABASE_URL` points
at a remote host. They only ever manage the local embedded server.

## 3. Set the environment variables

All three are required in production.

| Variable | Why it fails closed |
|---|---|
| `DATABASE_URL` | Without it the pool throws with instructions. There is no in-memory fallback, because a fallback would silently discard every deal. |
| `INRP2P_SANDBOX=true` | Without it `getEscrowService()` refuses to start in production. The guard exists so a funds-free simulation cannot be served unlabelled; auto-enabling it would defeat the point. |
| `SANDBOX_SESSION_SECRET` | Without it (or under 16 characters) production refuses to sign cookies. The development fallback is committed to this public repository — anyone could compute the HMAC and forge a session, including one carrying `isOperator`. Generate with `openssl rand -base64 32`. |

On Vercel: **Project → Settings → Environment Variables**, all three for the
Production environment, then redeploy. Environment changes do not apply to an
existing deployment.

## 4. Verify

```
/                    should render the calculator
/login               sign in with any address
/app                 should list deals (empty at first)
```

If `/` renders but `/app` shows the error boundary, the database is not
reachable — check `DATABASE_URL` and that step 2 actually ran.

Sandbox accounts are chosen by email prefix: `ops@…` is an operator, `new@…`
is unverified and cannot join, anything else is a verified trader.

---

## Local development

```bash
npm install
npm run db:start     # embedded PostgreSQL, migrates automatically
npm run dev
```

`npm run db:start` runs a real PostgreSQL 18 from the `embedded-postgres`
package — no Docker, Homebrew or system install required. It is an
**optional** dependency: if the platform binary cannot be fetched on a
deployment host, the build still succeeds, because the app never imports it.

### Verification gate

```bash
npm run verify           # format, lint, types, unit, manifest, integration, build
npm run test:integration # authorization, state transitions, concurrent Join
npm run screens:journey  # real screenshots from a running build
```

The integration suite needs the local database running.

---

## Known issues

- **`npm audit` reports 3 high-severity advisories** in `next`, `postcss` and
  `sharp`. All three are only fixed by `next@16`, a major upgrade not
  attempted here. `sharp` and the image-optimisation advisories are not on
  this app's path — it uses no `next/image`.
- **A repository path containing `#`** breaks the Next build tracer and
  Vite's resolver. Clone into a path without one.
