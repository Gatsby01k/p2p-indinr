#!/usr/bin/env node
/**
 * Generate a dependency inventory (CycloneDX-shaped SBOM).
 *
 * Built from the LOCKFILE, not from `node_modules`. A tree read off disk
 * describes whatever happens to be installed on the machine that ran it;
 * the lockfile describes what a clean install will produce, which is the
 * thing an auditor is actually asking about.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

const components = [];
for (const [path, entry] of Object.entries(lock.packages ?? {})) {
  if (path === '') continue;
  const name = entry.name ?? path.replace(/^.*node_modules\//, '');
  if (!name || !entry.version) continue;
  components.push({
    type: 'library',
    name,
    version: entry.version,
    purl: `pkg:npm/${name.replace('@', '%40')}@${entry.version}`,
    scope: entry.dev === true ? 'excluded' : 'required',
    ...(entry.integrity ? { hashes: [{ alg: 'SHA-512', content: entry.integrity }] } : {}),
  });
}

// Deduplicated and sorted, so two runs of the same lockfile produce a
// byte-identical document — an SBOM that churns is one nobody diffs.
const unique = [...new Map(components.map((c) => [`${c.name}@${c.version}`, c])).values()].sort(
  (a, b) => (a.purl < b.purl ? -1 : a.purl > b.purl ? 1 : 0),
);

const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  version: 1,
  metadata: {
    // No timestamp: a changing field would make every SBOM differ from
    // the last for no reason, and hide the changes that matter.
    component: { type: 'application', name: pkg.name, version: pkg.version ?? '0.0.0' },
    tools: [{ name: 'inrp2p-sbom', version: '1' }],
  },
  components: unique,
};

const json = JSON.stringify(sbom, null, 2);
writeFileSync('sbom.json', `${json}\n`);

console.log(`sbom.json: ${unique.length} components`);
console.log(`sha256: ${createHash('sha256').update(json).digest('hex')}`);
console.log(`production components: ${unique.filter((c) => c.scope === 'required').length}`);
