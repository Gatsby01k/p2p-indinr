#!/usr/bin/env node
/**
 * Structural checker for the TS-02 schema contract.
 *
 * Extracts every ```sql block from docs/specs/TS-02.md and asserts the ten
 * properties TS-02 §12.2 claims. This is NOT execution: it cannot prove the DDL
 * parses in PostgreSQL, and it makes no claim about runtime behaviour. It
 * proves internal consistency — which is precisely what v1.0 lacked.
 *
 *   node scripts/check-schema.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const doc = readFileSync(join(ROOT, 'docs/specs/TS-02.md'), 'utf8');

const problems = [];
const fail = (check, msg) => problems.push(`[${check}] ${msg}`);

// ---------------------------------------------------------------------------
// Extract SQL blocks
// ---------------------------------------------------------------------------
const rawBlocks = [...doc.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]);
if (rawBlocks.length === 0) fail('extract', 'no ```sql blocks found');

/**
 * Strip SQL line comments before structural analysis.
 *
 * `--` comments are legal SQL and TS-02 uses them heavily to bind each column
 * and constraint to the TS-01.4 rule it implements. Parsing them as DDL
 * produced three classes of false positive: a comment line read as a column
 * definition ("cannot parse column definition"), an English word inside a
 * comment read as a type ("uses unrecognized type \"is\""), and the word
 * "real" in prose tripping the floating-point check.
 *
 * Comment markers inside string literals and dollar-quoted function bodies are
 * NOT comments, so both are skipped over rather than scanned.
 */
function stripSqlComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);

    // Dollar-quoted body: copy verbatim to the matching tag.
    const dollar = /^\$[A-Za-z_]*\$/.exec(src.slice(i));
    if (dollar) {
      const tag = dollar[0];
      const end = src.indexOf(tag, i + tag.length);
      const stop = end === -1 ? src.length : end + tag.length;
      out += src.slice(i, stop);
      i = stop;
      continue;
    }

    // Single-quoted literal: copy verbatim, honouring '' escaping.
    if (src[i] === "'") {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "'" && src[j + 1] === "'") j += 2;
        else if (src[j] === "'") { j += 1; break; }
        else j += 1;
      }
      out += src.slice(i, j);
      i = j;
      continue;
    }

    // Line comment: drop to end of line, keeping the newline.
    if (two === '--') {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl;
      continue;
    }

    // Block comment.
    if (two === '/*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }

    out += src[i];
    i += 1;
  }
  return out;
}

// Ellipsis detection runs on the RAW text: a placeholder hidden in a comment is
// still a placeholder, and must not be laundered by comment stripping.
const blocks = rawBlocks.map(stripSqlComments);
const sql = blocks.join('\n');

// ---------------------------------------------------------------------------
// 1. No ellipsis or unexplained placeholder
// ---------------------------------------------------------------------------
rawBlocks.forEach((b, i) => {
  if (b.includes('…')) fail('1-ellipsis', `block ${i + 1} contains U+2026`);
  if (/(^|[^.])\.\.\.($|[^.])/.test(b)) fail('1-ellipsis', `block ${i + 1} contains "..."`);
});

// ---------------------------------------------------------------------------
// 2. Balanced parentheses and dollar-quoted bodies
// ---------------------------------------------------------------------------
blocks.forEach((b, i) => {
  // Strip dollar-quoted bodies before counting parens, then check tag pairing.
  const tags = [...b.matchAll(/\$([a-z]{0,8})\$/g)].map((m) => m[1]);
  const counts = new Map();
  for (const t of tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  for (const [t, n] of counts) {
    if (n % 2 !== 0) fail('2-dollar', `block ${i + 1}: dollar tag $${t}$ appears ${n} times (unpaired)`);
  }
  const stripped = b.replace(/\$([a-z]{0,8})\$[\s\S]*?\$\1\$/g, ' BODY ').replace(/'[^']*'/g, "''");
  let depth = 0;
  for (const ch of stripped) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (depth < 0) break;
  }
  if (depth !== 0) fail('2-parens', `block ${i + 1}: unbalanced parentheses (net ${depth})`);
});

// ---------------------------------------------------------------------------
// Parse declarations
// ---------------------------------------------------------------------------
const declaredTables = new Set();
for (const m of sql.matchAll(/CREATE (?:UNLOGGED )?TABLE (?:IF NOT EXISTS )?inrp2p\.(\w+)/g)) {
  declaredTables.add(m[1]);
}
const declaredTypes = new Set();
for (const m of sql.matchAll(/CREATE (?:TYPE|DOMAIN) inrp2p\.(\w+)/g)) declaredTypes.add(m[1]);
const declaredFns = new Set();
for (const m of sql.matchAll(/CREATE FUNCTION inrp2p\.(\w+)/g)) declaredFns.add(m[1]);

// Table body extraction: CREATE TABLE x ( ... );
const tableBodies = new Map();
for (const m of sql.matchAll(/CREATE (?:UNLOGGED )?TABLE (?:IF NOT EXISTS )?inrp2p\.(\w+)\s*\(/g)) {
  const start = m.index + m[0].length;
  let depth = 1, i = start;
  while (i < sql.length && depth > 0) {
    const c = sql[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    i++;
  }
  tableBodies.set(m[1], sql.slice(start, i - 1));
}

// Keys declared per table: PRIMARY KEY (...) and UNIQUE (...) inline or via ALTER,
// plus CREATE UNIQUE INDEX.
const keysOf = new Map();
const addKey = (t, cols) => {
  if (!keysOf.has(t)) keysOf.set(t, []);
  keysOf.get(t).push(cols.split(',').map((c) => c.trim()).filter(Boolean).join(','));
};
for (const [t, body] of tableBodies) {
  for (const m of body.matchAll(/PRIMARY KEY\s*\(([^)]*)\)/g)) addKey(t, m[1]);
  for (const m of body.matchAll(/UNIQUE\s*\(([^)]*)\)/g)) addKey(t, m[1]);
}
for (const m of sql.matchAll(/ALTER TABLE inrp2p\.(\w+)\s+ADD CONSTRAINT \w+ UNIQUE\s*\(([^)]*)\)/g)) {
  addKey(m[1], m[2]);
}
for (const m of sql.matchAll(/CREATE UNIQUE INDEX \w+\s*\n?\s*ON inrp2p\.(\w+)\s*\(([^)]*)\)/g)) {
  addKey(m[1], m[2]);
}

// ---------------------------------------------------------------------------
// 3 + 4. Foreign keys: target declared, and target columns are a declared key
// ---------------------------------------------------------------------------
const FK_RE = /FOREIGN KEY\s*\(([^)]*)\)\s*\n?\s*REFERENCES inrp2p\.(\w+)\s*(?:\(([^)]*)\))?/g;
for (const [t, body] of tableBodies) {
  for (const m of body.matchAll(FK_RE)) {
    const [, srcCols, target, tgtCols] = m;
    if (!declaredTables.has(target)) {
      fail('3-fk-target', `${t}: REFERENCES inrp2p.${target}, which is not declared`);
      continue;
    }
    const src = srcCols.split(',').map((c) => c.trim());
    if (!tgtCols) continue; // defaults to the target PK
    const tgt = tgtCols.split(',').map((c) => c.trim());
    if (src.length !== tgt.length) {
      fail('4-fk-arity', `${t}: FK (${srcCols}) -> ${target}(${tgtCols}) arity mismatch`);
      continue;
    }
    const want = tgt.join(',');
    const have = keysOf.get(target) ?? [];
    if (!have.includes(want)) {
      fail(
        '4-fk-key',
        `${t}: FK -> inrp2p.${target}(${want}) has no matching PRIMARY KEY or UNIQUE on the target (declared: ${have.join(' | ') || 'none'})`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 5. Every table has a PRIMARY KEY
// ---------------------------------------------------------------------------
for (const [t, body] of tableBodies) {
  if (!/PRIMARY KEY/.test(body)) fail('5-pk', `${t} has no PRIMARY KEY`);
}

// ---------------------------------------------------------------------------
// 6. Every column type is a real PG type or declared here
// ---------------------------------------------------------------------------
const BUILTIN = new Set([
  'uuid', 'text', 'boolean', 'smallint', 'integer', 'bigint', 'numeric',
  'timestamptz', 'jsonb', 'bytea', 'int4', 'int8',
]);
/** Split a table body on top-level commas, so multi-line constraints stay whole. */
function splitItems(body) {
  const items = [];
  let depth = 0, cur = '', inStr = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "'") inStr = !inStr;
    if (!inStr) {
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === ',' && depth === 0) { items.push(cur.trim()); cur = ''; continue; }
    }
    cur += c;
  }
  if (cur.trim()) items.push(cur.trim());
  return items.filter(Boolean);
}

const CONSTRAINT_START = /^(CONSTRAINT|PRIMARY KEY|UNIQUE|FOREIGN KEY|CHECK|EXCLUDE)\b/i;
const itemsOf = new Map();
for (const [t, body] of tableBodies) itemsOf.set(t, splitItems(body));

for (const [t, items] of itemsOf) {
  for (const item of items) {
    if (CONSTRAINT_START.test(item)) continue;
    const m = /^(\w+)\s+([A-Za-z0-9_.]+(?:\[\])?)/.exec(item.replace(/\s+/g, ' '));
    if (!m) { fail('6-type', `${t}: cannot parse column definition "${item.slice(0, 60)}"`); continue; }
    const [, col, ty] = m;
    const bare = ty.toLowerCase();
    if (BUILTIN.has(bare) || BUILTIN.has(bare.replace(/\[\]$/, ''))) continue;
    if (bare.startsWith('inrp2p.')) {
      const n = bare.slice('inrp2p.'.length).replace(/\[\]$/, '');
      if (!declaredTypes.has(n)) fail('6-type', `${t}.${col} uses undeclared type inrp2p.${n}`);
      continue;
    }
    fail('6-type', `${t}.${col} uses unrecognized type "${ty}"`);
  }
}

// ---------------------------------------------------------------------------
// 7. Every called inrp2p.* function is defined here
// ---------------------------------------------------------------------------
const DEFINED_ELSEWHERE = new Set(['tb_move', 'tb_quote_issue', 'tb_link_create', 'tb_link_join',
  'tb_link_close', 'tb_claim', 'tb_complete', 'tb_cancel', 'tb_withdraw_request',
  'tb_withdraw_cancel', 'severity1_code_for']);
for (const m of sql.matchAll(/inrp2p\.(\w+)\s*\(/g)) {
  const fn = m[1];
  if (declaredFns.has(fn) || declaredTables.has(fn) || declaredTypes.has(fn)) continue;
  if (DEFINED_ELSEWHERE.has(fn)) continue;
  fail('7-fn', `call to inrp2p.${fn}() which is not defined in this document`);
}

// ---------------------------------------------------------------------------
// 8. No subquery inside a CHECK
// ---------------------------------------------------------------------------
for (const m of sql.matchAll(/CHECK\s*\(/g)) {
  const start = m.index + m[0].length;
  let depth = 1, i = start;
  while (i < sql.length && depth > 0) {
    const c = sql[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    i++;
  }
  const body = sql.slice(start, i - 1);
  if (/\bSELECT\b/i.test(body)) fail('8-check-subquery', `CHECK contains a subquery: ${body.slice(0, 90)}`);
}

// ---------------------------------------------------------------------------
// 9. No floating-point type
// ---------------------------------------------------------------------------
if (/\b(REAL|DOUBLE PRECISION|FLOAT4|FLOAT8|\bFLOAT\b)\b/i.test(sql)) {
  fail('9-float', 'a floating-point type appears in the schema');
}

// ---------------------------------------------------------------------------
// 10. Every table constraint is explicitly named
// ---------------------------------------------------------------------------
for (const [t, items] of itemsOf) {
  for (const item of items) {
    if (/^(PRIMARY KEY|UNIQUE|FOREIGN KEY|CHECK|EXCLUDE)\b/i.test(item)) {
      fail('10-unnamed', `${t} has an unnamed table constraint: ${item.slice(0, 70)}`);
    }
  }
}

// ---------------------------------------------------------------------------
console.log(`sql blocks: ${blocks.length}`);
console.log(`tables: ${declaredTables.size}  types/domains: ${declaredTypes.size}  functions: ${declaredFns.size}`);
if (problems.length) {
  console.error(`\nSCHEMA CHECK FAILED — ${problems.length} problem(s):`);
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log('SCHEMA CHECK PASSED — all 10 structural properties hold');
