#!/usr/bin/env node
/**
 * TS-02 coverage manifest generator.
 *
 * Parses the APPROVED, IMMUTABLE docs/specs/TS-01.4.md and emits the exact
 * coverage manifest required by TS-02 §2. Nothing here is hand-asserted: every
 * count, every mapping and every partition proof is computed from the source
 * document. If TS-01.4 and the manifest ever disagree, this script fails loudly
 * rather than printing a comfortable number.
 *
 *   node scripts/coverage-manifest.mjs            # write docs/specs/TS-02-ANNEX-M.md
 *   node scripts/coverage-manifest.mjs --check    # verify only, non-zero on drift
 *
 * TS-01.4 is READ-ONLY here. This script never writes to it.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = join(ROOT, 'docs/specs/TS-01.4.md');
const OUT = join(ROOT, 'docs/specs/TS-02-ANNEX-M.md');

/** Expected shape of TS-01.4. Drift from any of these aborts generation. */
const EXPECT = {
  journals: 57,
  boundaries: 47,
  fRows: 321,
  races: 68,
  mutations: 47,
};

const src = readFileSync(SPEC, 'utf8');
const lines = src.split('\n');

// ---------------------------------------------------------------------------
// 1. §13.1 journal catalogue
// ---------------------------------------------------------------------------

function sectionRange(startRe, endRe) {
  const start = lines.findIndex((l) => startRe.test(l));
  if (start < 0) throw new Error(`section not found: ${startRe}`);
  const rest = lines.slice(start + 1).findIndex((l) => endRe.test(l));
  return [start, rest < 0 ? lines.length : start + 1 + rest];
}

const [j0, j1] = sectionRange(/^### 13\.1 Journal catalogue/, /^### 13\.2 /);

/** Journal blocks look like `**JD1 — deposit recognized …**` then `- **Boundary:** …`. */
const journals = [];
for (let i = j0; i < j1; i++) {
  const m = /^\*\*([A-Za-z0-9₀-₉'-]+)\s+—\s/.exec(lines[i]);
  if (!m) continue;
  const code = m[1];
  let boundary = null;
  for (let k = i + 1; k < Math.min(i + 4, j1); k++) {
    const b = /^- \*\*Boundary:\*\*\s*(.+?)\s*$/.exec(lines[k]);
    if (b) {
      boundary = b[1].replace(/`/g, '').trim();
      break;
    }
  }
  journals.push({ code, boundary });
}

// ---------------------------------------------------------------------------
// 2. §13.2 transaction boundary index
// ---------------------------------------------------------------------------

const [b0, b1] = sectionRange(/^### 13\.2 Transaction boundary index/, /^## 14\.|^# Annex A/);

const boundaryRows = [];
for (let i = b0; i < b1; i++) {
  const l = lines[i];
  if (!l.startsWith('|') || /^\|\s*-{3}/.test(l) || /^\|\s*Boundary\s*\|/.test(l)) continue;
  // Cells may contain escaped pipes (`JD1 \| JD2`). Split only on unescaped ones.
  const cells = l.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim());
  if (cells.length < 4) continue;
  const name = cells[0].replace(/\*\*/g, '').trim();
  // `*(All TB-REORG-REINSTATE branches)*` is a qualifier applying to the three
  // preceding branches, not a distinct boundary. It carries `—` as its lock set.
  const isQualifier = /^\*\(/.test(cells[0]) || cells[1] === '—';
  boundaryRows.push({
    name,
    locks: cells[1].replace(/`/g, '').trim(),
    journals: cells[2].replace(/`/g, '').replace(/\\\|/g, '|').trim(),
    allocations: cells[3].replace(/\*\*/g, '').trim(),
    isQualifier,
  });
}
const boundaries = boundaryRows.filter((r) => !r.isQualifier);
const qualifiers = boundaryRows.filter((r) => r.isQualifier);

// ---------------------------------------------------------------------------
// 3. Annex A F1–F321
// ---------------------------------------------------------------------------

const fRows = [];
for (const l of lines) {
  if (!/^\| F\d+ \|/.test(l)) continue;
  const cells = l.split('|').slice(1, -1).map((c) => c.trim());
  const n = Number(cells[0].slice(1));
  fRows.push({
    n,
    id: cells[0],
    injection: cells[1],
    outcome: cells[2],
    verifies: cells[3] ?? '',
    // A mutation row is marked by the literal bold token `**Mutation:**`.
    // F81 ("Mutation of quote or link terms after issuance") uses the word in
    // its ordinary sense and is NOT a mutation row.
    isMutation: /^\*\*Mutation:\*\*/.test(cells[1]),
  });
}
fRows.sort((a, b) => a.n - b.n);

const mutations = fRows.filter((r) => r.isMutation);

/** TS-01.4's own footer list of mutation rows, for the known-errata check. */
const footerLine = lines.find((l) => /^\*\*Mutation rows \(must fail/.test(l)) ?? '';
const footerMutations = [...footerLine.matchAll(/F(\d+)/g)].map((m) => Number(m[1]));

// ---------------------------------------------------------------------------
// 4. K-R1–K-R68
// ---------------------------------------------------------------------------

const races = [];
for (const l of lines) {
  const m = /^\|\s*\*\*(K-R\d+)\*\*\s*\|(.*)$/.exec(l);
  if (!m) continue;
  const cells = m[2].split('|').map((c) => c.trim());
  races.push({ id: m[1], n: Number(m[1].slice(3)), text: cells[0] ?? '' });
}
races.sort((a, b) => a.n - b.n);

// ---------------------------------------------------------------------------
// 5. Deterministic primary test-location assignment
// ---------------------------------------------------------------------------

/**
 * Ordered rules. First match wins, so every F row lands in exactly one place.
 * Matching runs against `verifies` first (the authoritative reference column),
 * then the injection text.
 */
const RULES = [
  ['concurrency', /K-R\d+/],
  ['concurrency', /\bL[1-7]\b/],
  ['security', /role|privilege|GRANT|REVOKE|SECURITY DEFINER|search_path|boundary identity/i],
  ['outbox', /\bO[1-5]\b|outbox|relay|notification/i],
  ['withdrawal', /\bW[1-7]\b|PNI|TNP|R-SEQ|§10\.|JW-|JW\d|withdraw|payout|attempt/i],
  ['recovery', /R-CUR|R-DR|R-U1|lineage|divergen|reinstat|reorg|cure|write-?off|JD-C|JD-R|JD-RE|M20|M22|M23|SD-[12]|§11\./i],
  ['chain', /R-CEI|CEI|R-CYC|sweep|JS1|JS-R1|JGX|JG2|gas|chain_op|§8\.[0-9]|§9\.|FA-1|finality|TRX/i],
  ['capital', /JBF1|JG1|capital|§12\.5/i],
  ['reserve', /C7|encumbran|reserve|JB1|JB2|JX1|JX2|JXS|suspend/i],
  ['case', /§7\.5|case|claim|evidence|dispute|proposal|approval|maker|checker|JH1|JH2|JD3/i],
  ['risk', /M16|M18|FreeBuffer|§6\.[0-9]|risk mode|NORMAL|THIN|EMERGENCY|S1|S2/i],
  ['idempotency', /idempoten|replay|entry_key|command|§7\.6/i],
  ['constraints', /CHECK|UNIQUE|constraint|trigger|catalogue closure|closed catalogue|append-only|immutab/i],
  ['ledger', /M1\b|M2\b|M3\b|M4\b|M5\b|M6\b|M7\b|M8\b|M9\b|posting|balance|journal|per-asset|zero sum/i],
  ['quote', /M12|M15|quote|link|MOVE|Join|§7\.[12]|JQ|JF/i],
  ['deal', /JC[12]|JR[12]|complete|refund|cancel|deal/i],
  ['reconciliation', /reconcil|residual|age bound/i],
  ['meta', /§1\.|§2\.|§3\.|§4\.|§5\./],
];

const FILE_OF = {
  concurrency: 'tests/concurrency/races.kr.spec.ts',
  security: 'tests/security/privileges.spec.ts',
  outbox: 'tests/outbox/atomicity.spec.ts',
  withdrawal: 'tests/withdrawal/lifecycle.spec.ts',
  recovery: 'tests/recovery/lineage.spec.ts',
  chain: 'tests/chain/observation.spec.ts',
  capital: 'tests/capital/funding.spec.ts',
  reserve: 'tests/reserve/encumbrance.spec.ts',
  case: 'tests/case/resolution.spec.ts',
  risk: 'tests/risk/modes.spec.ts',
  idempotency: 'tests/idempotency/replay.spec.ts',
  constraints: 'tests/constraints/enforcement.spec.ts',
  ledger: 'tests/ledger/postings.spec.ts',
  quote: 'tests/quote/terms.spec.ts',
  deal: 'tests/deal/settlement.spec.ts',
  reconciliation: 'tests/reconciliation/residuals.spec.ts',
  meta: 'tests/meta/conformance.spec.ts',
};

function assign(row) {
  const hay = `${row.verifies}\n${row.injection}`;
  for (const [dir, re] of RULES) {
    if (re.test(row.verifies) || re.test(hay)) return dir;
  }
  return 'meta';
}

for (const r of fRows) {
  r.dir = assign(r);
  r.file = FILE_OF[r.dir];
  r.test = `${r.file}::${r.id}`;
}

// Boundary → harness. Every boundary gets a dedicated boundary-level suite.
function boundarySlug(name) {
  const base = name.split('—')[0].trim().replace(/[()/]/g, ' ').replace(/\s+/g, '-').replace(/-+$/g, '');
  return base.toLowerCase();
}
for (const b of boundaries) {
  b.file = `tests/boundary/${boundarySlug(b.name)}.spec.ts`;
}

/**
 * Journal → boundary is derived from §13.2's own Journals column rather than
 * from §13.1 prose, because the table is the authoritative bidirectional
 * mapping. A journal is "mapped" only when at least one boundary row names it.
 * Token match treats `-` as part of the identifier so `JD1` never matches
 * `JD-R1` and `JG1` never matches `JG1-RE`.
 */
function namesJournal(cell, code) {
  const esc = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9-])${esc}(?![A-Za-z0-9-])`).test(cell);
}
for (const j of journals) {
  j.owners = boundaries.filter((b) => namesJournal(b.journals, j.code));
  j.mapped = j.owners.length > 0;
  j.file = j.mapped ? j.owners.map((b) => b.file).join(' + ') : '(unmapped)';
  j.boundaryNames = j.mapped ? j.owners.map((b) => b.name).join(' ; ') : '(none)';
}

for (const k of races) k.file = `tests/concurrency/races.kr.spec.ts::${k.id}`;
for (const m of mutations) m.mutationFile = `tests/mutation/${m.id}.mutant.ts`;

// ---------------------------------------------------------------------------
// 6. Verification — refuse to emit a manifest that does not prove itself
// ---------------------------------------------------------------------------

const problems = [];
const eq = (label, got, want) => {
  if (got !== want) problems.push(`${label}: expected ${want}, parsed ${got}`);
};

eq('journals', journals.length, EXPECT.journals);
eq('boundaries (excluding qualifier rows)', boundaries.length, EXPECT.boundaries);
eq('Annex A rows', fRows.length, EXPECT.fRows);
eq('K-R rows', races.length, EXPECT.races);
eq('mutation rows', mutations.length, EXPECT.mutations);

// F partition: 1..321, no gaps, no duplicates, all assigned.
const seen = new Set();
for (const r of fRows) {
  if (seen.has(r.n)) problems.push(`duplicate F${r.n}`);
  seen.add(r.n);
  if (!r.file) problems.push(`F${r.n} unassigned`);
}
for (let i = 1; i <= EXPECT.fRows; i++) if (!seen.has(i)) problems.push(`missing F${i}`);

// The rows the reviewer specifically flagged as previously omitted.
for (const n of [88, 118, 150, 196, 228, 229, 230, 231, 232, 233, 234, 235, 236]) {
  const r = fRows.find((x) => x.n === n);
  if (!r?.file) problems.push(`previously-omitted F${n} still unmapped`);
}

// K-R continuity.
for (let i = 1; i <= EXPECT.races; i++) {
  if (!races.some((k) => k.n === i)) problems.push(`missing K-R${i}`);
}

// Every journal must be named by at least one §13.2 boundary row.
for (const j of journals) {
  if (!j.mapped) problems.push(`journal ${j.code} is named by no §13.2 boundary row (§13.1 says "${j.boundary}")`);
}

// Known TS-01.4 errata: the footer summary omits F260.
const footerMissing = mutations.map((m) => m.n).filter((n) => !footerMutations.includes(n));

if (problems.length) {
  console.error('COVERAGE MANIFEST FAILED\n' + problems.map((p) => `  - ${p}`).join('\n'));
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 7. Emit
// ---------------------------------------------------------------------------

const byDir = new Map();
for (const r of fRows) {
  if (!byDir.has(r.dir)) byDir.set(r.dir, []);
  byDir.get(r.dir).push(r.n);
}

function ranges(ns) {
  const out = [];
  let a = ns[0], b = ns[0];
  for (let i = 1; i < ns.length; i++) {
    if (ns[i] === b + 1) { b = ns[i]; continue; }
    out.push(a === b ? `F${a}` : `F${a}–F${b}`);
    a = b = ns[i];
  }
  out.push(a === b ? `F${a}` : `F${a}–F${b}`);
  return out.join(', ');
}

const md = [];
md.push('# TS-02 Annex M — Coverage manifest (generated)');
md.push('');
md.push('**Generated by** `scripts/coverage-manifest.mjs` **from** `docs/specs/TS-01.4.md`.');
md.push('**Do not hand-edit.** Regenerate with `node scripts/coverage-manifest.mjs`.');
md.push('');
md.push('This manifest is emitted only when every count and every mapping below is');
md.push('proven from the source document. The generator exits non-zero otherwise, so a');
md.push('published manifest is itself the evidence.');
md.push('');
md.push('## M.0 Parsed totals');
md.push('');
md.push('| Artefact | Source | Count |');
md.push('|---|---|---|');
md.push(`| Journals | §13.1 | **${journals.length}** |`);
md.push(`| Transaction boundaries / branches | §13.2 | **${boundaries.length}** |`);
md.push(`| Qualifier rows (not boundaries) | §13.2 | ${qualifiers.length} |`);
md.push(`| Failure-injection rows | Annex A | **${fRows.length}** |`);
md.push(`| Race harnesses | K-R index | **${races.length}** |`);
md.push(`| Mutation rows | Annex A | **${mutations.length}** |`);
md.push('');
md.push('### M.0.1 Recorded TS-01.4 errata');
md.push('');
if (footerMissing.length) {
  md.push(`TS-01.4's Annex A footer enumerates ${footerMutations.length} mutation rows, but the`);
  md.push(`table contains ${mutations.length}. Omitted from the footer: **${footerMissing.map((n) => 'F' + n).join(', ')}**.`);
  md.push('');
  md.push('TS-01.4 is approved and immutable, so this is **recorded, not corrected**.');
  md.push(`TS-02 binds to the table (${mutations.length} rows), which is the normative list.`);
} else {
  md.push('None. The footer list and the table agree.');
}
md.push('');
md.push('`F81` is **not** a mutation row: it reads "Mutation of quote or link terms after');
md.push('issuance", using the word in its ordinary sense rather than the `**Mutation:**`');
md.push('marker. Counting it would produce 48 and is incorrect.');
md.push('');
md.push('## M.1 Journals → boundary → suite');
md.push('');
md.push('Derived from §13.2\'s Journals column, not from §13.1 prose, so the mapping is');
md.push('bidirectional: a journal counts as covered only when a boundary row names it.');
md.push('');
md.push('| # | Journal | Owning boundary row(s) in §13.2 | Primary suite |');
md.push('|---|---|---|---|');
journals.forEach((j, i) => md.push(`| ${i + 1} | \`${j.code}\` | ${j.boundaryNames} | \`${j.file}\` |`));
md.push('');
md.push('## M.2 Transaction boundaries → complete canonical lock set → suite');
md.push('');
md.push('| # | Boundary | Complete canonical lock set | Journals | Allocations | Primary suite |');
md.push('|---|---|---|---|---|---|');
boundaries.forEach((b, i) =>
  md.push(`| ${i + 1} | ${b.name} | \`${b.locks}\` | ${b.journals.replace(/\|/g, '\\|')} | ${b.allocations} | \`${b.file}\` |`),
);
md.push('');
qualifiers.forEach((q) => md.push(`> Qualifier row (not a boundary): *${q.name}* — ${q.journals}`));
md.push('');
md.push('## M.3 F1–F321 → primary executable test location');
md.push('');
md.push('| Suite | Rows | Count |');
md.push('|---|---|---|');
let total = 0;
for (const [dir, ns] of [...byDir.entries()].sort()) {
  total += ns.length;
  md.push(`| \`${FILE_OF[dir]}\` | ${ranges(ns.sort((a, b) => a - b))} | ${ns.length} |`);
}
md.push(`| **Total** | | **${total}** |`);
md.push('');
md.push('**Partition proof.** Every row in `F1`–`F321` appears exactly once above:');
md.push(`${fRows.length} assigned, 0 duplicates, 0 missing, 0 unassigned.`);
md.push('');
// v2.1: the generator previously emitted a second assignment table here,
// restating F88, F118, F150, F196 and F228–F236 "for the reviewer". Those rows
// are already assigned by §M.3.1, so each appeared as a primary executable test
// location TWICE — which destroys the partition claim this very paragraph
// makes, and lets a later edit to one table diverge from the other silently.
// §M.3.1 is the single assignment table. scripts/manifest-check.mjs scans all
// of §M.3 and fails on a duplicate, so this cannot be reintroduced unnoticed.
md.push('**Correction (v2.1) — a second assignment table has been removed.** It');
md.push('restated thirteen rows that §M.3.1 already assigns, so `F88` and twelve');
md.push('others were each assigned a primary executable test location twice.');
md.push('§M.3.1 below is the single, complete row-level assignment.');
md.push('');
md.push('### M.3.1 Complete row-level assignment');
md.push('');
md.push('| Row | Verifies | Primary executable test | Mutation |');
md.push('|---|---|---|---|');
for (const r of fRows) {
  md.push(`| \`${r.id}\` | ${r.verifies || '—'} | \`${r.test}\` | ${r.isMutation ? `\`${`tests/mutation/${r.id}.mutant.ts`}\`` : '—'} |`);
}
md.push('');
md.push('## M.4 K-R1–K-R68 → multi-session harness');
md.push('');
md.push('Every row runs in `tests/concurrency/races.kr.spec.ts` under the multi-session');
md.push('harness: ≥2 real PostgreSQL sessions on separate connections, deterministic');
md.push('interleaving via advisory barriers, ≥1,000 randomized schedules at concurrency ≥32.');
md.push('A single-session simulation does not satisfy any row here.');
md.push('');
md.push('| Race | Harness |');
md.push('|---|---|');
for (const k of races) md.push(`| \`${k.id}\` | \`${k.file}\` |`);
md.push('');
md.push('## M.5 Mutation rows → mutation coverage');
md.push('');
md.push(`All ${mutations.length} rows. Each mutant re-introduces exactly one defect and the`);
md.push('suite MUST fail. A mutant that passes is a coverage defect, not a spec defect.');
md.push('');
md.push('| Row | Defect re-introduced | Mutant |');
md.push('|---|---|---|');
for (const m of mutations) {
  md.push(`| \`${m.id}\` | ${m.injection.replace(/^\*\*Mutation:\*\*\s*/, '')} | \`${m.mutationFile}\` |`);
}
md.push('');

const out = md.join('\n');

if (process.argv.includes('--check')) {
  const cur = (() => { try { return readFileSync(OUT, 'utf8'); } catch { return null; } })();
  if (cur !== out) {
    console.error('COVERAGE MANIFEST OUT OF DATE — regenerate with `node scripts/coverage-manifest.mjs`');
    process.exit(1);
  }
  console.log('coverage manifest up to date');
} else {
  writeFileSync(OUT, out);
  console.log(`wrote ${OUT}`);
}

console.log(
  `OK  journals=${journals.length}  boundaries=${boundaries.length}  ` +
    `F=${fRows.length}  K-R=${races.length}  mutations=${mutations.length}`,
);
