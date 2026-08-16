#!/usr/bin/env node
/**
 * A REALISTIC BACKLOG, so the performance budgets measure something.
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  A QUEUE WITH FOUR ROWS IN IT PROVES NOTHING ABOUT A QUEUE.      │
 * │                                                                  │
 * │  The browser gate's journeys leave a handful of deals behind.    │
 * │  Timing the Deal Desk against those measures an empty page and   │
 * │  would happily stay green through the exact regression the       │
 * │  budgets exist to catch — an unbounded query, an N+1, a render   │
 * │  that is linear in the platform's whole open volume.             │
 * │                                                                  │
 * │  So the desk is measured against a backlog several pages deep,   │
 * │  and the busiest deal room against a room with a full page of    │
 * │  messages and evidence in it.                                    │
 * │                                                                  │
 * │  ⚠ THIS IS A MEASUREMENT FIXTURE, NOT A PRODUCT PATH. It writes  │
 * │  rows directly, out of band, into the GATE's own throwaway       │
 * │  cluster — never a shared or hosted database — and it refuses    │
 * │  to run against anything that is not loopback. Nothing it        │
 * │  creates is asserted on as product behaviour; the journeys do    │
 * │  that, through the rendered application.                         │
 * └──────────────────────────────────────────────────────────────────┘
 *
 *   DATABASE_URL=… node scripts/perf-backlog.mjs --deals 200 --room <uuid>
 */

import pg from 'pg';

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};

const DATABASE_URL = process.env.DATABASE_URL;
const DEALS = Number(argOf('deals', 200));
const MESSAGES = Number(argOf('messages', 60));
const ROOM = argOf('room', '');

if (!DATABASE_URL) {
  console.error('DATABASE_URL must be set.');
  process.exit(2);
}

/** Loopback only. A load fixture pointed at a real database is an outage. */
const host = new URL(DATABASE_URL).hostname;
if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
  console.error(`refusing to seed a non-loopback database (${host}).`);
  process.exit(2);
}

/**
 * Identifiers the database will actually accept.
 *
 * `deal_link.public_id` is `INRP-` + ten characters and `deal.deal_code`
 * is three letters, a hyphen and four — both from an alphabet with `I`
 * and `O` removed so nobody misreads a code down a phone line. The
 * fixture honours those CHECK constraints rather than working around
 * them: a row the product could not have produced would be measuring a
 * shape that does not exist.
 */
const ALPHABET = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const encode = (n, width) => {
  let out = '';
  let value = n;
  for (let i = 0; i < width; i += 1) {
    out = ALPHABET[value % ALPHABET.length] + out;
    value = Math.floor(value / ALPHABET.length);
  }
  return out;
};
const publicIdFor = (i) => `INRP-PERF${encode(i, 6)}`;
const dealCodeFor = (i) => `PRF-${encode(i, 4)}`;

const client = new pg.Client({ connectionString: DATABASE_URL });
await client.connect();

try {
  /* ---- Two accounts to hold the seats ---------------------------- */
  const { rows: users } = await client.query(
    `INSERT INTO sandbox.app_user (email, display_name, is_operator, is_verified)
     VALUES ('perf.maker@example.in','Perf Maker',FALSE,TRUE),
            ('perf.taker@example.in','Perf Taker',FALSE,TRUE)
     ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name
     RETURNING user_id, email`,
  );
  const maker = users.find((u) => u.email === 'perf.maker@example.in').user_id;
  const taker = users.find((u) => u.email === 'perf.taker@example.in').user_id;

  const { rows: existing } = await client.query(
    `SELECT count(*)::int AS n FROM sandbox.deal WHERE deal_code LIKE 'PRF-%'`,
  );
  const already = Number(existing[0].n);
  const wanted = Math.max(DEALS - already, 0);

  /*
   * ---- Open deals, half awaiting payment, half awaiting confirm ----
   *
   * A deal is a quote, then a link, then the deal, then two seats — the
   * same chain the product builds, with the same NOT NULL columns and
   * the same unique indexes, so a row here is indistinguishable from a
   * row a person made. Each is one transaction: a half-built deal in a
   * queue would measure a shape the product cannot produce.
   */
  for (let i = already; i < already + wanted; i += 1) {
    const state = i % 2 === 0 ? 'FIAT_PENDING' : 'FIAT_CLAIMED';
    await client.query('BEGIN');
    try {
      const { rows: quote } = await client.query(
        `INSERT INTO sandbox.quote
           (issued_to, direction, state, inr_minor, rate_num, rate_den,
            pricing_source, observed_at, expires_at, protection_fee_minor, title)
         VALUES ($1,'INR_TO_INR','CONSUMED', 2500000, 1, 1, 'SANDBOX', now(),
                 now() + interval '7 days', 55000, $2)
         RETURNING quote_id`,
        [maker, `Backlog fixture ${i}`],
      );
      const quoteId = quote[0].quote_id;

      const { rows: link } = await client.query(
        `INSERT INTO sandbox.deal_link
           (public_id, quote_id, created_by, creator_role, state, expires_at, consumed_at)
         VALUES ($1,$2,$3,'FIAT_SIDE','CONSUMED', now() + interval '7 days', now())
         RETURNING link_id`,
        [publicIdFor(i), quoteId, maker],
      );

      const { rows: deal } = await client.query(
        `INSERT INTO sandbox.deal
           (public_id, link_id, quote_id, state, direction, inr_minor,
            rate_num, rate_den, pricing_source, observed_at,
            action_deadline, created_at, protection_fee_minor, fee_bearer, deal_code, title)
         VALUES ($1,$2,$3,$4,'INR_TO_INR', 2500000, 1, 1, 'SANDBOX', now(),
                 now() + interval '2 hours', now() - ($5 || ' minutes')::interval,
                 55000, 'PAYER', $6, $7)
         RETURNING deal_id`,
        [
          publicIdFor(i),
          link[0].link_id,
          quoteId,
          state,
          // Spread across the at-risk boundary, so the "over 30m" view is
          // not trivially empty or trivially everything.
          String(i % 90),
          dealCodeFor(i),
          `Backlog fixture ${i}`,
        ],
      );
      await client.query(
        `INSERT INTO sandbox.participant (deal_id, user_id, role)
         VALUES ($1,$2,'FIAT_SIDE'), ($1,$3,'CRYPTO_SIDE')`,
        [deal[0].deal_id, maker, taker],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }

  /* ---- One busy room, so the deal room is measured with content --- */
  let seededMessages = 0;
  if (ROOM) {
    for (let i = 0; i < MESSAGES; i += 1) {
      // `seq` is GENERATED ALWAYS — the database owns message ordering,
      // and the fixture is not entitled to choose it either.
      await client.query(
        `INSERT INTO sandbox.deal_message (deal_id, author_id, kind, body, sent_at)
         VALUES ($1,$2,'CHAT',$3, now() - ($4 || ' seconds')::interval)`,
        [
          ROOM,
          i % 2 === 0 ? maker : taker,
          `Load-fixture message ${i + 1}. Long enough to render like a real one.`,
          String(MESSAGES - i),
        ],
      );
      seededMessages += 1;
    }
  }

  const { rows: open } = await client.query(
    `SELECT count(*)::int AS n FROM sandbox.deal
      WHERE state IN ('FIAT_PENDING','FIAT_CLAIMED','DISPUTED')`,
  );
  console.log(
    `backlog: ${Number(open[0].n)} open deals (${wanted} added), ${seededMessages} messages in ${ROOM || 'no room'}`,
  );
  process.stdout.write(`OPEN_DEALS=${Number(open[0].n)}\n`);
} finally {
  await client.end();
}
