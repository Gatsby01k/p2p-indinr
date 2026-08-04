#!/usr/bin/env node
/**
 * Manifest validator.
 *
 * Parses TS-01.4 (the authority), TS-02 and TS-02 Annex M, then fails on any
 * missing, duplicate or unknown identifier. It proves *correspondence*, never
 * coverage: a row appearing in Annex M means a test location has been named
 * for it, not that a test exists or passes. Nothing here may print a coverage
 * percentage.
 *
 *   node scripts/manifest-check.mjs
 *   node scripts/manifest-check.mjs --json
 *
 * Exit codes: 0 all checks pass · 1 one or more checks failed · 2 input missing.
 */

import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// `new URL(import.meta.url).pathname` is percent-encoded, so a repository path
// containing a space or `#` resolves to a nonexistent directory. fileURLToPath
// is the only correct decoder.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const P = {
  ts014: path.join(ROOT, 'docs/specs/TS-01.4.md'),
  ts02: path.join(ROOT, 'docs/specs/TS-02.md'),
  annexM: path.join(ROOT, 'docs/specs/TS-02-ANNEX-M.md'),
};

const JSON_OUT = process.argv.includes('--json');

for (const [k, f] of Object.entries(P)) {
  if (!existsSync(f)) {
    console.error(`missing required input (${k}): ${f}`);
    process.exit(2);
  }
}

const read = (f) => readFileSync(f, 'utf8');
const ts014 = read(P.ts014);
const ts02 = read(P.ts02);
const annexM = read(P.annexM);

const EXPECTED_TS014_SHA = 'a293e671997510ad2deb05138dbd1aae963fa601a7a85bd6dcdaae74a5290f20';
const actualSha = createHash('sha256').update(readFileSync(P.ts014)).digest('hex');

/* ------------------------- authority extraction ---------------------- */

/** Lines of the §13.2 transaction-boundary index table. */
function boundaryRows() {
  const start = ts014.indexOf('### 13.2 Transaction boundary index');
  const end = ts014.indexOf('## 14. Outbox and exactly-once effects');
  if (start < 0 || end < 0) throw new Error('cannot locate TS-01.4 §13.2');
  const rows = [];
  for (const line of ts014.slice(start, end).split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 4) continue;
    if (/^-+$/.test(cells[0].replace(/-/g, '-')) && /^[-\s]+$/.test(cells[0])) continue;
    if (cells[0] === 'Boundary') continue;
    // The single qualifier row carries an em-dash lock set and is not a boundary.
    if (cells[0].startsWith('*(') && cells[1] === '—') continue;
    rows.push({ boundary: cells[0], lockSet: cells[1], journals: cells[2], allocations: cells[3] });
  }
  return rows;
}

/** Journal codes from the §13.1 catalogue headings. */
function journalCodes() {
  const start = ts014.indexOf('### 13.1 Journal catalogue');
  const end = ts014.indexOf('### 13.2 Transaction boundary index');
  const out = [];
  for (const m of ts014.slice(start, end).matchAll(/^\*\*(J[A-Za-z0-9-]+) —/gm)) out.push(m[1]);
  return out;
}

/** F-row ids, and which are marked `**Mutation:**`. */
function fRows() {
  const all = [];
  const mutation = [];
  for (const line of ts014.split('\n')) {
    const m = /^\|\s*(F\d+)\s*\|/.exec(line);
    if (!m) continue;
    all.push(m[1]);
    if (/\*\*Mutation:\*\*/.test(line)) mutation.push(m[1]);
  }
  return { all, mutation };
}

/** K-R ids from the §15 concurrency matrix. */
function krRows() {
  const out = [];
  for (const m of ts014.matchAll(/^\|\s*\*\*(K-R\d+)\*\*\s*\|/gm)) out.push(m[1]);
  return out;
}

/** boundary_code enum members declared in TS-02 §5.1. */
function boundaryCodeEnum() {
  const m = /CREATE TYPE inrp2p\.boundary_code AS ENUM \(([\s\S]*?)\);/.exec(ts02);
  if (!m) throw new Error('cannot locate inrp2p.boundary_code in TS-02');
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

/* ------------------------------ checks -------------------------------- */

const results = [];
const fail = (name, detail) => results.push({ name, ok: false, detail });
const pass = (name, detail) => results.push({ name, ok: true, detail });

function dupes(xs) {
  const seen = new Set();
  const dup = new Set();
  for (const x of xs) (seen.has(x) ? dup : seen).add(x);
  return [...dup];
}

/**
 * Split a Markdown table row into trimmed cells with backticks and bold
 * markers stripped. Annex M writes identifiers as `` `F1` ``, so a parser that
 * does not strip them silently matches nothing — which would read as "all rows
 * unassigned" rather than as a parser bug.
 */
function cellsOf(line) {
  if (!line.startsWith('|')) return null;
  const cells = line
    .split('|')
    .slice(1, -1)
    .map((c) => c.trim().replace(/^\*\*|\*\*$/g, '').replace(/^`|`$/g, '').trim());
  if (cells.length < 2) return null;
  if (cells.every((c) => /^:?-{2,}:?$/.test(c))) return null; // separator row
  return cells;
}

/**
 * Find the first cell matching `re`, and the row's remaining cells.
 *
 * The identifier cell MUST have been backticked in the source. Annex M writes
 * every identifier as `` `F1` ``/`` `JD1` ``/`` `K-R1` ``, while table headers
 * ("Journal", "Race", "Row") are plain text — so requiring the backticks is
 * what keeps a header from being parsed as a data row.
 */
function rowFor(line, re) {
  const cells = cellsOf(line);
  if (!cells) return null;
  const raw = line
    .split('|')
    .slice(1, -1)
    .map((c) => c.trim());
  const idx = cells.findIndex((c, i) => re.test(c) && /^`.*`$/.test(raw[i] ?? ''));
  if (idx === -1) return null;
  return { id: re.exec(cells[idx])[0], cells, idx };
}

/* 0. Authority integrity ------------------------------------------------ */
if (actualSha !== EXPECTED_TS014_SHA) {
  fail('TS-01.4 integrity', `SHA-256 is ${actualSha}, expected ${EXPECTED_TS014_SHA}`);
} else {
  pass('TS-01.4 integrity', `SHA-256 ${actualSha}`);
}

/* 1. Journals ----------------------------------------------------------- */
const journals = journalCodes();
const jDup = dupes(journals);
if (journals.length !== 57 || jDup.length) {
  fail('§13.1 journal count', `parsed ${journals.length} (expected 57); duplicates: ${jDup.join(', ') || 'none'}`);
} else {
  pass('§13.1 journal count', '57 journals, no duplicates');
}

const m1 = annexM.slice(annexM.indexOf('## M.1'), annexM.indexOf('## M.2'));
const annexJournals = new Set();
for (const line of m1.split('\n')) {
  const r = rowFor(line, /^J[A-Za-z0-9-]+$/);
  if (r) annexJournals.add(r.id);
}
const missingJournals = journals.filter((j) => !annexJournals.has(j));
const unknownJournals = [...annexJournals].filter((j) => !journals.includes(j));
if (missingJournals.length || unknownJournals.length) {
  fail(
    'Annex M journal mapping',
    `missing: ${missingJournals.join(', ') || 'none'}; unknown: ${unknownJournals.join(', ') || 'none'}`,
  );
} else {
  pass('Annex M journal mapping', `all ${journals.length} journals mapped, no unknown codes`);
}

/* 2. Boundaries --------------------------------------------------------- */
const bRows = boundaryRows();
if (bRows.length !== 47) {
  fail('§13.2 boundary count', `parsed ${bRows.length} boundary rows (expected 47)`);
} else {
  pass('§13.2 boundary count', '47 boundary rows/branches');
}

const enumMembers = boundaryCodeEnum();
const eDup = dupes(enumMembers);
if (enumMembers.length !== bRows.length || eDup.length) {
  fail(
    'boundary_code cardinality',
    `enum has ${enumMembers.length} members for ${bRows.length} boundary rows; duplicates: ${eDup.join(', ') || 'none'}`,
  );
} else {
  pass('boundary_code cardinality', `${enumMembers.length} members == ${bRows.length} boundary rows`);
}

/* Distinct lock sets must remain distinct: collapsing two boundaries whose
 * lock sets differ is the failure mode this guards. */
const lockSets = new Map();
for (const r of bRows) {
  const key = r.boundary;
  if (lockSets.has(key) && lockSets.get(key) !== r.lockSet) {
    fail('§13.2 lock-set distinctness', `boundary ${key} carries two different lock sets`);
  }
  lockSets.set(key, r.lockSet);
}
if (!results.some((r) => r.name === '§13.2 lock-set distinctness')) {
  pass('§13.2 lock-set distinctness', `${new Set(bRows.map((r) => r.lockSet)).size} distinct lock sets preserved`);
}

/* 3. F1–F321 ------------------------------------------------------------ */
const { all: fAll, mutation: fMut } = fRows();
const fDup = dupes(fAll);
const expectedF = Array.from({ length: 321 }, (_, i) => `F${i + 1}`);
const fMissing = expectedF.filter((f) => !fAll.includes(f));
if (fAll.length !== 321 || fDup.length || fMissing.length) {
  fail(
    'Annex A F-row partition',
    `parsed ${fAll.length}; duplicates: ${fDup.join(', ') || 'none'}; gaps: ${fMissing.join(', ') || 'none'}`,
  );
} else {
  pass('Annex A F-row partition', 'F1–F321 present exactly once, no gaps');
}

/* Annex M must assign each F exactly one primary executable test location. */
// Scan the whole of §M.3 (which contains §M.3.1), not §M.3.1 alone: a second
// assignment table anywhere in the section must be detected as a duplicate.
// Scoping this to §M.3.1 is what let the duplicated F88/F118/F150/F196/
// F228–F236 rows survive earlier review.
const m3 = annexM.slice(annexM.indexOf('## M.3'), annexM.indexOf('## M.4'));
const assignments = new Map();
const dupAssign = [];
for (const line of m3.split('\n')) {
  const r = rowFor(line, /^F\d+$/);
  if (!r) continue;
  // "Primary executable test" is the first cell after the id that names a file.
  const loc = r.cells.slice(r.idx + 1).find((c) => /tests\/[\w./-]+\.(spec|test)\.tsx?/.test(c));
  if (assignments.has(r.id)) dupAssign.push(r.id);
  else assignments.set(r.id, loc ?? r.cells[r.idx + 2] ?? '');
}
const unassigned = expectedF.filter((f) => !assignments.has(f));
const unknownF = [...assignments.keys()].filter((f) => !expectedF.includes(f));
if (unassigned.length || dupAssign.length || unknownF.length) {
  fail(
    'Annex M F assignment',
    `unassigned: ${unassigned.length ? unassigned.slice(0, 12).join(', ') + (unassigned.length > 12 ? ` (+${unassigned.length - 12})` : '') : 'none'}` +
      `; duplicated: ${dupAssign.join(', ') || 'none'}` +
      `; unknown: ${unknownF.join(', ') || 'none'}`,
  );
} else {
  pass('Annex M F assignment', `${assignments.size} F rows, each assigned exactly one primary test location`);
}

/* Every assigned location must look like a real test file path. */
const badLoc = [...assignments.entries()].filter(([, loc]) => !/tests\/[\w./-]+\.(spec|test)\.tsx?/.test(loc));
if (badLoc.length) {
  fail('Annex M location shape', `${badLoc.length} rows without a test-file location, e.g. ${badLoc[0][0]} -> "${badLoc[0][1]}"`);
} else {
  pass('Annex M location shape', 'every F row names a test file');
}

/* 4. Mutation rows ------------------------------------------------------ */
if (fMut.length !== 47) {
  fail('Mutation row count', `parsed ${fMut.length} rows carrying **Mutation:** (expected 47)`);
} else {
  pass('Mutation row count', '47 mutation rows (the table, not the 46-item footer summary)');
}

const mutSection = annexM.slice(annexM.indexOf('## M.5'));
const mutMapped = new Set([...mutSection.matchAll(/\b(F\d+)\b/g)].map((m) => m[1]));
const mutMissing = fMut.filter((f) => !mutMapped.has(f));
if (mutMissing.length) {
  fail('Annex M mutation mapping', `unmapped mutants: ${mutMissing.join(', ')}`);
} else {
  pass('Annex M mutation mapping', `all ${fMut.length} mutation rows mapped`);
}

/* The TS-01.4 footer summary omits F260; record it rather than "fixing" it. */
const footer = /\*\*Mutation rows[^\n]*\n/.exec(ts014.slice(ts014.indexOf('| F321')));
const footerIds = footer ? [...footer[0].matchAll(/F\d+/g)].map((m) => m[0]) : [];
if (footerIds.length && footerIds.length !== fMut.length) {
  const diff = fMut.filter((f) => !footerIds.includes(f));
  pass(
    'TS-01.4 erratum E-1 (recorded)',
    `table lists ${fMut.length} mutation rows; footer summary lists ${footerIds.length}, omitting ${diff.join(', ')}. TS-02 binds to the table.`,
  );
}

/* 5. K-R1–K-R68 --------------------------------------------------------- */
const kr = krRows();
const krDup = dupes(kr);
const expectedKr = Array.from({ length: 68 }, (_, i) => `K-R${i + 1}`);
const krMissing = expectedKr.filter((k) => !kr.includes(k));
if (kr.length !== 68 || krDup.length || krMissing.length) {
  fail('§15 K-R partition', `parsed ${kr.length}; duplicates: ${krDup.join(', ') || 'none'}; gaps: ${krMissing.join(', ') || 'none'}`);
} else {
  pass('§15 K-R partition', 'K-R1–K-R68 present exactly once');
}

const krSection = annexM.slice(annexM.indexOf('## M.4'), annexM.indexOf('## M.5'));
const krAssign = new Map();
for (const line of krSection.split('\n')) {
  const r = rowFor(line, /^K-R\d+$/);
  if (r) krAssign.set(r.id, r.cells[r.idx + 1] ?? '');
}
const krUnassigned = expectedKr.filter((k) => !krAssign.has(k));
if (krUnassigned.length) {
  fail('Annex M K-R assignment', `unassigned: ${krUnassigned.join(', ')}`);
} else {
  pass('Annex M K-R assignment', '68 K-R rows each mapped to a harness');
}

/* A K-R row is satisfied only by a real multi-session harness. */
const krBad = [...krAssign.entries()].filter(([, loc]) => !/tests\/concurrency\/[\w./-]+\.(spec|test)\.tsx?/.test(loc));
if (krBad.length) {
  fail('Annex M K-R harness location', `${krBad.length} rows outside tests/concurrency/, e.g. ${krBad[0][0]} -> "${krBad[0][1]}"`);
} else {
  pass('Annex M K-R harness location', 'every K-R row maps into tests/concurrency/');
}

/* 6. No coverage percentages ------------------------------------------- */
const pct = [...annexM.matchAll(/(\d{1,3}(?:\.\d+)?)\s*%/g)].map((m) => m[0]);
if (pct.length) {
  fail('No claimed coverage percentage', `Annex M contains ${pct.length} percentage token(s): ${pct.slice(0, 5).join(', ')}`);
} else {
  pass('No claimed coverage percentage', 'Annex M claims correspondence, not coverage');
}

/* ------------------------------ report -------------------------------- */

const failed = results.filter((r) => !r.ok);

if (JSON_OUT) {
  console.log(JSON.stringify({ ok: failed.length === 0, results }, null, 2));
} else {
  for (const r of results) {
    console.log(`${r.ok ? '  ok  ' : ' FAIL '} ${r.name}\n         ${r.detail}`);
  }
  console.log(
    `\n${results.length - failed.length}/${results.length} checks passed.` +
      (failed.length ? ` ${failed.length} FAILED.` : ''),
  );
  console.log(
    '\nThis validator proves identifier correspondence between TS-01.4, TS-02 and',
  );
  console.log('Annex M. It does not assert that any named test exists, runs or passes.');
}

process.exit(failed.length ? 1 : 0);
