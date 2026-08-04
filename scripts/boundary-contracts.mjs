#!/usr/bin/env node
/**
 * Emits TS-02 §7 — the 47 transaction-boundary contracts — as markdown on
 * stdout, built directly from TS-01.4 §13.1 and §13.2.
 *
 * Lock sets, journals, allocations, guards, CAS predicates, immutable records,
 * replay results and conflict codes are reproduced from the approved source
 * rather than paraphrased, so a boundary contract cannot silently drift from
 * the specification it implements.
 *
 *   node scripts/boundary-contracts.mjs > /tmp/section7.md
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(ROOT, 'docs/specs/TS-01.4.md'), 'utf8');
const lines = src.split('\n');

const idx = (re) => lines.findIndex((l) => re.test(l));
const j0 = idx(/^### 13\.1 Journal catalogue/);
const j1 = idx(/^### 13\.2 Transaction boundary index/);
// §13.2 ends at §14. Bounding at Annex A instead would sweep in the O1-O5,
// K-R and severity-1 tables, which are not boundaries.
const j2 = (() => {
  const rel = lines.slice(j1).findIndex((l) => /^## 14\./.test(l));
  return rel < 0 ? idx(/^# Annex A/) : j1 + rel;
})();

// ---- §13.1 journals -------------------------------------------------------
const journals = new Map();
for (let i = j0; i < j1; i++) {
  const m = /^\*\*([A-Za-z0-9-]+)\s+—\s+(.+?)\*\*$/.exec(lines[i]);
  if (!m) continue;
  const j = { code: m[1], title: m[2], fields: {} };
  for (let k = i + 1; k < j1 && lines[k].startsWith('- **'); k++) {
    const f = /^- \*\*(.+?):\*\*\s*(.*)$/.exec(lines[k]);
    if (f) j.fields[f[1]] = f[2].trim();
  }
  journals.set(j.code, j);
}

// ---- §13.2 boundaries -----------------------------------------------------
const boundaries = [];
for (let i = j1; i < j2; i++) {
  const l = lines[i];
  if (!l.startsWith('|') || /^\|\s*-{3}/.test(l) || /^\|\s*Boundary\s*\|/.test(l)) continue;
  const c = l.split(/(?<!\\)\|/).slice(1, -1).map((s) => s.trim());
  if (c.length < 4) continue;
  if (/^\*\(/.test(c[0]) || c[1] === '—') continue; // qualifier row, not a boundary
  boundaries.push({
    name: c[0].replace(/\*\*/g, '').trim(),
    locks: c[1].trim(),
    journalsCell: c[2].trim(),
    allocations: c[3].replace(/\*\*/g, '').trim(),
  });
}

// ---- boundary -> journal codes --------------------------------------------
const codes = [...journals.keys()].sort((a, b) => b.length - a.length);
for (const b of boundaries) {
  b.journals = codes.filter((c) =>
    new RegExp(`(?<![A-Za-z0-9-])${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9-])`).test(
      b.journalsCell,
    ),
  );
}

// ---- function naming ------------------------------------------------------
function fnName(name) {
  let s = name.split('—')[0].trim();
  s = s.replace(/\(([^)]*)\)/g, (_, inner) => '_' + inner.replace(/\*\*/g, ''));
  return (
    'inrp2p.' +
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/_+/g, '_')
  );
}

function clockNote(locks) {
  if (!locks.includes('decision_time()')) {
    return '**None.** This boundary reads no post-lock decision clock; it MUST NOT consult one.';
  }
  const clean = (s) => s.replace(/`/g, '').trim();
  const before = clean(locks.split('decision_time()')[0]).replace(/→\s*$/, '');
  const after = clean(locks.split('decision_time()')[1]).replace(/^→\s*/, '');
  return `\`decision_time()\` is read **after** \`${clean(before.split('→').pop())}\` and **before** \`${clean(after.split('→')[0])}\`.`;
}

const out = [];
out.push('### 7.4 The 47 boundary contracts');
out.push('');
out.push('Lock sets, journals, allocations, guards, CAS predicates, immutable records,');
out.push('replay results and conflict codes below are reproduced verbatim from TS-01.4');
out.push('§13.1/§13.2 by `scripts/boundary-contracts.mjs`. They are not paraphrases.');
out.push('');

boundaries.forEach((b, i) => {
  out.push(`#### 7.4.${i + 1} ${b.name}`);
  out.push('');
  out.push('| | |');
  out.push('|---|---|');
  out.push(`| **Function** | \`${fnName(b.name)}(p_command_id UUID, p_args JSONB) RETURNS inrp2p.boundary_result\` |`);
  out.push(`| **Complete canonical lock set** | ${b.locks} |`);
  out.push(`| **Post-lock clock** | ${clockNote(b.locks)} |`);
  out.push(`| **Journals** | ${b.journalsCell || 'none'} |`);
  out.push(`| **Allocations** | ${b.allocations || 'none'} |`);
  out.push(
    `| **Isolation / retry** | \`READ COMMITTED\`; every guarded write is a CAS asserting exactly one affected row. A serialization failure (\`40001\`) or deadlock (\`40P01\`) is retried by the caller from the **start of the boundary**, re-acquiring every lock in canonical order. A CAS returning zero rows is **not** retried: it is a deterministic conflict and is returned as such. |`,
  );
  out.push('');
  if (b.journals.length === 0) {
    out.push(
      '**No journal.** This boundary makes domain and/or allocation writes only. It still writes its audit event with `decision_time()` and the observed `mode_version` [B2], and still returns a deterministic result code.',
    );
    out.push('');
  } else {
    out.push('| Journal | Guard | CAS | Immutable records | Allocations | Replay | Conflict |');
    out.push('|---|---|---|---|---|---|---|');
    for (const c of b.journals) {
      const j = journals.get(c);
      const f = j.fields;
      const cell = (v) => (v ? v.replace(/\|/g, '\\|') : '—');
      out.push(
        `| \`${c}\` | ${cell(f['Guard'])} | ${cell(f['CAS'])} | ${cell(f['Immutable records'])} | ${cell(f['Allocations'])} | ${cell(f['Replay'])} | ${cell(f['Conflict'])} |`,
      );
    }
    out.push('');
  }
});

process.stdout.write(out.join('\n') + '\n');
process.stderr.write(`emitted ${boundaries.length} boundary contracts\n`);
