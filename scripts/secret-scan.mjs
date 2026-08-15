#!/usr/bin/env node
/**
 * Scan committed content for credentials.
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  THE POINT IS NOT TO CATCH EVERY SECRET. IT IS TO CATCH THE ONES │
 * │  PEOPLE ACTUALLY COMMIT BY ACCIDENT.                             │
 * │                                                                  │
 * │  Private keys pasted into a config, an AWS key in a script, a    │
 * │  connection string with a real password in a README. High-signal │
 * │  patterns, run over tracked files only — an untracked local      │
 * │  `.env` is not a leak, and flagging it trains people to ignore   │
 * │  this tool.                                                      │
 * │                                                                  │
 * │  This repository DELIBERATELY contains published sandbox keys    │
 * │  that are labelled as worthless. Those are allow-listed by their │
 * │  own text, so the scanner stays quiet about them and loud about  │
 * │  everything else.                                                │
 * └──────────────────────────────────────────────────────────────────┘
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const PATTERNS = [
  { name: 'private-key-block', re: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'stripe-key', re: /\bsk_(live|test)_[A-Za-z0-9]{16,}\b/ },
  { name: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  {
    name: 'db-url-with-password',
    /*
     * A connection string carrying a LITERAL password.
     *
     * Deliberately narrow. `${PASSWORD}` is a template that builds a URL
     * at runtime, and `user:password@host` is documentation — neither is
     * a leak, and flagging them trains people to ignore this tool. The
     * password segment must therefore contain no interpolation and must
     * not be one of the obvious placeholder words.
     */
    re: /\bpostgres(ql)?:\/\/[^:\s/$]+:(?!password@|PASSWORD@|sandbox-local-only)[^@\s${}]{8,}@/,
  },
  { name: 'generic-assignment', re: /\b(SECRET|PASSWORD|PRIVATE_KEY|ACCESS_TOKEN)\s*[:=]\s*['"][^'"\s]{12,}['"]/ },
];

/**
 * Text that marks a deliberate, published non-secret.
 *
 * The sandbox HMAC keys in this repository are checked in on purpose and
 * say so in their own names. Recognising that phrasing keeps the scanner
 * credible instead of permanently noisy.
 */
const ALLOWED = [
  /not-a-secret/,
  /sandbox-local-only/,
  /placeholder/i,
  /example\.com/,
  // A shell or template interpolation is a reference, not a value.
  /\$\{[A-Za-z_]/,
  /\$[A-Z_]{3,}/,
];

const SKIP_PATH = /(^|\/)(node_modules|\.next|\.git|dist|coverage|\.sandbox-db)(\/|$)/;
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|eot|zip|gz|dump)$/i;

function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], { encoding: 'buffer' });
  return out.toString('utf8').split('\0').filter((f) => f.length > 0);
}

const findings = [];

for (const file of trackedFiles()) {
  if (SKIP_PATH.test(file) || BINARY_EXT.test(file)) continue;
  let size;
  try {
    size = statSync(file).size;
  } catch {
    continue;
  }
  if (size > 2 * 1024 * 1024) continue;

  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, index) => {
    if (ALLOWED.some((a) => a.test(line))) return;
    for (const pattern of PATTERNS) {
      if (pattern.re.test(line)) {
        findings.push({ file, line: index + 1, pattern: pattern.name });
      }
    }
  });
}

if (findings.length === 0) {
  console.log('secret scan: no findings across tracked files');
  process.exit(0);
}

// The MATCH IS NEVER PRINTED. Echoing a leaked credential into CI logs
// leaks it a second time, somewhere with a longer retention.
console.error(`secret scan: ${findings.length} finding(s)`);
for (const f of findings) console.error(`  ${f.file}:${f.line}  [${f.pattern}]`);
process.exit(1);
