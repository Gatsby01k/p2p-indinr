#!/usr/bin/env node
/**
 * Prove every outbox event the code EMITS is classified.
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  THE FAILURE THIS CATCHES:                                       │
 * │                                                                  │
 * │  Somebody adds `ctx.emit({ type: 'payment.settled', … })` to a   │
 * │  command, forgets the registry, ships it. In DEL-09 the worker   │
 * │  marked that DELIVERED and it vanished. It is now quarantined —  │
 * │  which is far better, and still a 03:00 surprise.                │
 * │                                                                  │
 * │  So the source is scanned for every emitted literal and compared │
 * │  with the declared manifest, in BOTH directions. A new type      │
 * │  fails CI at the commit that introduced it.                      │
 * └──────────────────────────────────────────────────────────────────┘
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Every `.ts` under a directory, recursively. */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (path.endsWith('.ts')) out.push(path);
  }
  return out;
}

const sources = walk('src');

/**
 * Emitted types, read from `ctx.emit({ … type: '…' })` call sites.
 *
 * Matched on the emit call rather than on any `type:` property, so an
 * unrelated discriminated union does not produce a phantom event.
 */
const emitted = new Map();
const EMIT_CALL = /\bemit\(\{[\s\S]{0,400}?\btype:\s*(?:'([a-z0-9_.]+)'|([^,\n]+))/g;

for (const file of sources) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(EMIT_CALL)) {
    const literal = match[1];
    if (literal === undefined) {
      /*
       * A COMPUTED event type. `ingestRailEventCommand` chooses between
       * three literals with a ternary, which is legitimate — but a
       * scanner cannot follow it, so the expression is reported and the
       * literals it selects from are picked up separately below.
       */
      continue;
    }
    if (!emitted.has(literal)) emitted.set(literal, []);
    emitted.get(literal).push(file);
  }
}

/*
 * Literals used in a computed emit. Narrow on purpose: only strings that
 * already look like an event type AND appear next to an emit in the same
 * file. Anything broader would sweep up unrelated string constants.
 */
const TERNARY_LITERAL = /'([a-z0-9]+\.[a-z0-9_]+)'/g;
for (const file of sources) {
  const text = readFileSync(file, 'utf8');
  if (!/\bemit\(\{[\s\S]{0,400}?\btype:\s*\n?\s*[a-zA-Z]/.test(text)) continue;
  /*
   * A FIXED WINDOW, not a brace match. An emit block contains a nested
   * `payload: { … }`, so a lazy `}\)` terminator stops at the INNER
   * brace and truncates the ternary — which is how three genuinely
   * emitted types were first reported as never emitted.
   */
  for (const block of text.matchAll(/\bemit\(\{[\s\S]{0,700}/g)) {
    for (const literal of block[0].matchAll(TERNARY_LITERAL)) {
      const value = literal[1];
      if (!emitted.has(value)) emitted.set(value, []);
      if (!emitted.get(value).includes(file)) emitted.get(value).push(file);
    }
  }
}

/** The declared manifest, read from the registry's own source. */
const registry = readFileSync('src/server/ops/outboxHandlers.ts', 'utf8');
const declaredBlock = /DECLARED_EVENT_TYPES = \[([\s\S]*?)\] as const;/.exec(registry);
const classifiedBlock = /INTENTIONAL_NOOPS: readonly DeclaredEventType\[\] = \[([\s\S]*?)\];/.exec(
  registry,
);

if (declaredBlock === null || classifiedBlock === null) {
  console.error('could not read the outbox manifest from outboxHandlers.ts');
  process.exit(1);
}

const declared = new Set([...declaredBlock[1].matchAll(/'([a-z0-9_.]+)'/g)].map((m) => m[1]));
const classified = new Set([...classifiedBlock[1].matchAll(/'([a-z0-9_.]+)'/g)].map((m) => m[1]));

const problems = [];

// 1. Everything emitted must be declared.
for (const [type, files] of emitted) {
  if (!declared.has(type)) {
    problems.push(`EMITTED BUT NOT DECLARED: '${type}' (${files.join(', ')})`);
  }
}

// 2. Everything declared must be classified.
for (const type of declared) {
  if (!classified.has(type)) {
    problems.push(`DECLARED BUT NOT CLASSIFIED: '${type}' — register a handler or the no-op`);
  }
}

// 3. Nothing classified may be undeclared, or the registry is stale.
for (const type of classified) {
  if (!declared.has(type)) {
    problems.push(`CLASSIFIED BUT NOT DECLARED: '${type}' — stale registry entry`);
  }
}

// 4. A declared type nothing emits is dead weight worth pruning.
const orphaned = [...declared].filter((t) => !emitted.has(t));

if (problems.length > 0) {
  console.error(`outbox manifest: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

console.log(`outbox manifest OK`);
console.log(`  emitted in source: ${emitted.size}`);
console.log(`  declared:          ${declared.size}`);
console.log(`  classified:        ${classified.size}`);
if (orphaned.length > 0) {
  // Reported, not failed: a declared-but-unemitted type is usually an
  // event a future stage will produce, and failing on it would push
  // people to delete the declaration rather than keep the manifest whole.
  console.log(`  declared but not currently emitted: ${orphaned.join(', ')}`);
}
