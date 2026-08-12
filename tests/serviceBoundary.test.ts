import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The adapter boundary, enforced rather than intended.
 *
 * UX-01 §9 requires the interface to depend on a stable service boundary
 * so the sandbox can be swapped for a real backend without editing
 * screens. TS-00 `SD-4` found the opposite: 66 files under `src/app` and
 * `src/components` imported `@/server/sandbox/*` directly.
 *
 * A convention nothing checks decays back the first time somebody is in a
 * hurry, so this is a build gate. It fails with the exact file and import
 * that crossed the line.
 */

// `process.cwd()` is the project root under Vitest, and unlike a
// `file://` URL it needs no percent-decoding — which matters because a
// checkout path may contain characters a URL would escape.
const ROOT = `${process.cwd()}/`;

function sourceFilesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (/\.(ts|tsx)$/.test(entry)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/** `import ... from '<specifier>'`, including type-only imports. */
function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
}

describe('application-service boundary (UX-01 §9)', () => {
  const uiFiles = [
    ...sourceFilesUnder(join(ROOT, 'src/app')),
    ...sourceFilesUnder(join(ROOT, 'src/components')),
  ];

  it('covers the whole interface, so a passing result is not vacuous', () => {
    expect(uiFiles.length).toBeGreaterThan(30);
  });

  it('no interface file imports a server module directly', () => {
    const offenders: string[] = [];
    for (const file of uiFiles) {
      const source = readFileSync(file, 'utf8');
      for (const spec of importSpecifiers(source)) {
        if (spec.startsWith('@/server/')) {
          offenders.push(`${file.replace(ROOT, '')} → ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the interface reaches the server only through @/services', () => {
    const seen = new Set<string>();
    for (const file of uiFiles) {
      for (const spec of importSpecifiers(readFileSync(file, 'utf8'))) {
        if (spec.startsWith('@/services')) seen.add(spec);
      }
    }
    // Exactly three entry points, and no deeper reach into the module.
    expect([...seen].sort()).toEqual(['@/services', '@/services/actions', '@/services/contract']);
  });

  /**
   * The no-bypass gate.
   *
   * `src/services/actions.ts` is the only mutation surface the browser can
   * reach — and every export of a `'use server'` module is an addressable
   * endpoint whether or not a screen links to it. So it is not enough that
   * the DEL-02 mutations go through `runCommand`; nothing in this file may
   * import a domain function that opens its own transaction and writes no
   * command record.
   *
   * The throwing primitives (`issueFirmQuote`, `createDealLink`,
   * `joinDealLink`, `closeDealLink`, `submitPaymentClaim`, …) are exactly
   * such functions. They exist for the integration suite. If one is ever
   * imported here again, this fails and names it.
   */
  it('the mutation surface imports no transaction-owning primitive', () => {
    const actions = readFileSync(join(ROOT, 'src/services/actions.ts'), 'utf8');
    const forbidden = new Set([
      'issueFirmQuote',
      'issueExchangeQuoteFromInr',
      'issueProtectedQuote',
      'createDealLink',
      'closeDealLink',
      'joinDealLink',
      'submitPaymentClaim',
      'confirmReceipt',
      'cancelDeal',
      'postMessage',
      'raiseDispute',
      'runLifecycleSweep',
    ]);

    /*
     * The BOUND NAMES are what matter, not the file's prose — the comment
     * above the import block names several of these deliberately, in order
     * to explain why they are absent. An earlier version of this check
     * scanned raw text and failed on its own documentation, which is a
     * reminder that a gate matching substrings is a gate that will be
     * silenced rather than fixed.
     */
    const bound = [...actions.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*'([^']+)'/g)]
      .flatMap((match) => (match[1] ?? '').split(','))
      .map((part) =>
        part
          .replace(/\btype\b/, '')
          .trim()
          .split(/\s+as\s+/)[0]!
          .trim(),
      )
      .filter(Boolean);

    expect(bound.length).toBeGreaterThan(10); // the parse actually found imports
    expect(bound.filter((name) => forbidden.has(name))).toEqual([]);
  });

  it('every DEL-02 mutation is constructed through runCommand', () => {
    const commands = readFileSync(join(ROOT, 'src/services/commands.ts'), 'utf8');
    for (const commandType of [
      'DEAL_INTENT_CREATE',
      'LINK_JOIN',
      'LINK_CLOSE',
      'PAYMENT_CLAIM',
      'CONFIRM_RECEIPT',
      'DEAL_CANCEL',
      'DISPUTE_RAISE',
      'MESSAGE_POST',
      // The operator ruling terminates a deal, so it is a deal-state
      // mutation and belongs inside the boundary like every other.
      'DISPUTE_RULE',
    ]) {
      expect(commands, `${commandType} must be a runCommand command type`).toContain(
        `commandType: '${commandType}'`,
      );
    }
  });

  /**
   * The wrapper may not decide anything.
   *
   * `'use server'` exports are addressable endpoints, so if an action
   * reconstructed a mutation itself it could drift away from the command
   * the tests exercise. Every DEL-02 action must delegate to `./commands`
   * and do nothing else that could change an outcome.
   */
  it('the action wrapper only delegates, redirects and revalidates', () => {
    const actions = readFileSync(join(ROOT, 'src/services/actions.ts'), 'utf8');

    // It constructs no commands of its own…
    expect(actions).not.toContain('runCommand(');
    expect(actions).not.toContain('commandType:');

    // …and every DEL-02 action calls its command counterpart.
    const delegations: Array<[string, string]> = [
      ['createDealAction', 'createDealCommand'],
      ['createLinkAction', 'createLinkFromForm'],
      ['closeLinkAction', 'closeLinkCommand'],
      ['joinAction', 'joinCommand'],
      ['claimAction', 'claimCommand'],
      ['confirmAction', 'confirmCommand'],
      ['cancelDealAction', 'cancelCommand'],
      ['messageAction', 'messageCommand'],
      ['disputeAction', 'disputeCommand'],
      ['ruleAction', 'rulingCommand'],
    ];
    for (const [action, command] of delegations) {
      const body = actions.slice(actions.indexOf(`export async function ${action}(`));
      const end = body.indexOf('\nexport async function ');
      const scoped = end === -1 ? body : body.slice(0, end);
      expect(scoped, `${action} must delegate to ${command}`).toContain(`${command}(`);
    }
  });

  it('the ruling mutation cannot bypass the boundary either', () => {
    const commands = readFileSync(join(ROOT, 'src/services/commands.ts'), 'utf8');
    // The boundary form, not the throwing wrapper.
    expect(commands).toContain('ruleOnDisputeIn');
    expect(commands).not.toMatch(/\bruleOnDispute\b(?!In)/);
  });

  it('the no-JavaScript form renders a command id it does not mint per retry', () => {
    const page = readFileSync(join(ROOT, 'src/app/app/new/page.tsx'), 'utf8');
    expect(page).toContain('name="commandId"');
    expect(page).toContain('newCommandId()');
    // The command layer must refuse a missing id rather than inventing one.
    const commands = readFileSync(join(ROOT, 'src/services/commands.ts'), 'utf8');
    expect(commands).toMatch(/isCommandId\(input\.commandId\)/);
    expect(commands).not.toMatch(/createLinkFromForm[\s\S]*?newCommandId\(\)/);
  });

  it('the contract module stays free of server-only imports', () => {
    const contract = readFileSync(join(ROOT, 'src/services/contract.ts'), 'utf8');
    expect(contract).not.toContain("'server-only'");
    for (const spec of importSpecifiers(contract)) {
      // It may name types from the boundary, but must pull in no runtime
      // server module — a client component imports this file.
      expect(spec.startsWith('pg')).toBe(false);
      expect(spec.includes('/db/')).toBe(false);
    }
  });
});
