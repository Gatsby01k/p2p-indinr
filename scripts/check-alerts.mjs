#!/usr/bin/env node
/**
 * Evaluate the alert rules.
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  THIS SENDS NOTHING ANYWHERE.                                    │
 * │                                                                  │
 * │  No alert provider has credentials in this repository, so the    │
 * │  rules are evaluated and printed. Claiming an alert is wired      │
 * │  when nothing receives it is worse than having no alert: it      │
 * │  makes somebody stop checking.                                   │
 * │                                                                  │
 * │  Running this proves the rules are EXECUTABLE — that each        │
 * │  query parses, matches the real schema and returns a number —    │
 * │  which is the part that silently rots otherwise.                 │
 * └──────────────────────────────────────────────────────────────────┘
 */

import { readFileSync } from 'node:fs';
import pg from 'pg';

const { Client } = pg;

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://inrp2p_sandbox:sandbox-local-only@127.0.0.1:55433/inrp2p_sandbox';

const config = JSON.parse(readFileSync('db/alerts.json', 'utf8'));

/** `value > 0`, `value >= 20`, `value <> 13` — the only forms used. */
function fires(expression, value) {
  const match = /^value\s*(>=|<=|<>|>|<|=)\s*(-?\d+)$/.exec(expression.trim());
  if (match === null) return null;
  const [, op, raw] = match;
  const threshold = Number(raw);
  switch (op) {
    case '>':
      return value > threshold;
    case '>=':
      return value >= threshold;
    case '<':
      return value < threshold;
    case '<=':
      return value <= threshold;
    case '=':
      return value === threshold;
    case '<>':
      return value !== threshold;
  }
  return null;
}

async function main() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  const firing = [];
  const quiet = [];
  const unevaluable = [];

  for (const rule of config.rules) {
    if (rule.query === null) {
      // Evaluated elsewhere — readiness, or a CI exit code. Listed so
      // the inventory is complete rather than silently short.
      unevaluable.push(rule);
      continue;
    }
    let value;
    try {
      const { rows } = await client.query(rule.query);
      value = Number(rows[0]?.value ?? 0);
    } catch (error) {
      // A rule whose query no longer matches the schema is a rule that
      // has silently stopped protecting anything. That is a failure.
      console.error(`  BROKEN RULE ${rule.id}: ${error.message}`);
      process.exitCode = 1;
      continue;
    }
    const triggered = fires(rule.firesWhen, value);
    if (triggered === null) {
      console.error(`  UNPARSEABLE CONDITION ${rule.id}: ${rule.firesWhen}`);
      process.exitCode = 1;
      continue;
    }
    (triggered ? firing : quiet).push({ ...rule, value });
  }

  await client.end();

  console.log(`alert destination: ${config.destination ?? 'NONE CONFIGURED (nothing is sent)'}`);
  console.log(`evaluated ${quiet.length + firing.length} rule(s)`);

  if (firing.length > 0) {
    console.log('\nFIRING:');
    for (const r of firing) {
      console.log(`  [${r.severity}] ${r.id} = ${r.value}  (runbook ${r.runbook})`);
      console.log(`      ${r.description}`);
    }
  } else {
    console.log('nothing firing');
  }

  if (unevaluable.length > 0) {
    console.log('\nevaluated elsewhere:');
    for (const r of unevaluable) console.log(`  ${r.id} — ${r.firesWhen}`);
  }
}

main().catch((error) => {
  console.error('alert check failed:', error.message);
  process.exit(1);
});
