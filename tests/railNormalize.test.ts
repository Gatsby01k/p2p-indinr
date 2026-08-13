import { describe, expect, it } from 'vitest';
import {
  assetForRail,
  networkBelongsToRail,
  normalizeReference,
  normalizeTronAddress,
  normalizeTxHash,
  normalizeUtr,
  parseMinor,
  redactDestination,
  redactReference,
} from '@/lib/railReference';

/**
 * Normalization, tested on its own.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  EVERY UNIQUENESS GUARANTEE IN DEL-05 RESTS ON THESE FUNCTIONS.    │
 * │                                                                    │
 * │  If `0xAB…` and `ab…` do not collapse to one string, the unique    │
 * │  index sees two references and the same on-chain transfer settles  │
 * │  two deals. That is a money-losing bug that no integration test    │
 * │  would necessarily reach, so the collapsing itself is tested       │
 * │  directly and exhaustively here.                                   │
 * └────────────────────────────────────────────────────────────────────┘
 */

const HASH = 'a'.repeat(64);

describe('UTR normalization', () => {
  it('upper-cases and trims', () => {
    const result = normalizeUtr('  utr123456  ');
    expect(result).toEqual({ ok: true, value: 'UTR123456' });
  });

  it('collapses case differences to ONE value', () => {
    const forms = ['abc123456789', 'ABC123456789', 'AbC123456789', ' abc123456789 '];
    const normalized = forms.map((f) => normalizeUtr(f));
    expect(normalized.every((n) => n.ok)).toBe(true);
    expect(new Set(normalized.map((n) => (n.ok ? n.value : '')))).toEqual(
      new Set(['ABC123456789']),
    );
  });

  it('REFUSES rather than repairs a reference with a space in it', () => {
    // A UTR with a space is a UTR that was not read correctly. Stripping
    // the space would invent a reference nobody's bank ever issued.
    const result = normalizeUtr('ABC 123456');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('no spaces');
  });

  it('refuses punctuation, emptiness and the wrong length', () => {
    for (const bad of ['', '   ', 'ABC-123', 'ABC_123', 'AB1', 'A'.repeat(33), 'ÀBC123456']) {
      expect(normalizeUtr(bad).ok, bad).toBe(false);
    }
  });
});

describe('transaction hash normalization', () => {
  it('strips the 0x prefix and lower-cases', () => {
    expect(normalizeTxHash(`0x${HASH.toUpperCase()}`)).toEqual({ ok: true, value: HASH });
    expect(normalizeTxHash(`0X${HASH.toUpperCase()}`)).toEqual({ ok: true, value: HASH });
  });

  it('collapses every spelling of the SAME transfer to one value', () => {
    // The same hash copied from two explorers must not settle two deals.
    const forms = [HASH, HASH.toUpperCase(), `0x${HASH}`, `0X${HASH.toUpperCase()}`, ` ${HASH} `];
    const values = forms.map((f) => normalizeTxHash(f)).map((r) => (r.ok ? r.value : 'FAILED'));
    expect(new Set(values).size).toBe(1);
    expect(values[0]).toBe(HASH);
  });

  it('refuses a hash of the wrong length or alphabet', () => {
    for (const bad of ['', 'abc', HASH.slice(0, 63), `${HASH}a`, `${'z'.repeat(64)}`]) {
      expect(normalizeTxHash(bad).ok, bad).toBe(false);
    }
  });
});

describe('TRC20 address validation', () => {
  it('accepts a well-formed address', () => {
    const address = `T${'a'.repeat(33)}`;
    expect(normalizeTronAddress(address)).toEqual({ ok: true, value: address });
  });

  it('refuses the base58-excluded characters', () => {
    // 0, O, I and l are excluded precisely because people confuse them
    // when copying by hand — accepting them defeats the point of base58.
    for (const c of ['0', 'O', 'I', 'l']) {
      expect(normalizeTronAddress(`T${c}${'a'.repeat(32)}`).ok, c).toBe(false);
    }
  });

  it('refuses an address that is not TRON-shaped', () => {
    for (const bad of [
      '',
      'T',
      `0x${'a'.repeat(40)}`,
      `A${'a'.repeat(33)}`,
      `T${'a'.repeat(32)}`,
    ]) {
      expect(normalizeTronAddress(bad).ok, bad).toBe(false);
    }
  });
});

describe('minor-unit parsing', () => {
  it('accepts a positive integer string and a positive bigint', () => {
    expect(parseMinor('1000', 'x')).toEqual({ ok: true, value: '1000' });
    expect(parseMinor(12_345n, 'x')).toEqual({ ok: true, value: '12345' });
  });

  it('REFUSES a decimal instead of silently scaling it', () => {
    // A provider sending "1.5" speaks major units, and guessing the
    // conversion here turns 1.5 USDT into 15 or into 1.
    for (const bad of ['1.5', '1.0', '0.000001', '1e6']) {
      expect(parseMinor(bad, 'x').ok, bad).toBe(false);
    }
  });

  it('refuses a JS number, however innocent it looks', () => {
    // A money value that passed through a float is a money value that
    // cannot be trusted to be exact.
    expect(parseMinor(1000, 'x').ok).toBe(false);
    expect(parseMinor(1.5, 'x').ok).toBe(false);
  });

  it('refuses zero, negatives and leading zeros', () => {
    for (const bad of ['0', '-1', '007', '', ' ', '+5']) {
      expect(parseMinor(bad, 'x').ok, bad).toBe(false);
    }
    expect(parseMinor(0n, 'x').ok).toBe(false);
    expect(parseMinor(-1n, 'x').ok).toBe(false);
  });
});

describe('rail and network pairing', () => {
  it('accepts only the networks each rail actually has', () => {
    expect(networkBelongsToRail('INR', 'UPI')).toBe(true);
    expect(networkBelongsToRail('INR', 'IMPS')).toBe(true);
    expect(networkBelongsToRail('INR', 'NEFT')).toBe(true);
    expect(networkBelongsToRail('USDT', 'TRC20')).toBe(true);
  });

  it('REFUSES a USDT network on the INR rail and the reverse', () => {
    // This is the check that stops a TRC20 transfer reconciling against
    // a UPI intent.
    expect(networkBelongsToRail('INR', 'TRC20')).toBe(false);
    expect(networkBelongsToRail('USDT', 'UPI')).toBe(false);
  });

  it('refuses an unknown rail or network rather than defaulting', () => {
    expect(networkBelongsToRail('USDT', 'ERC20')).toBe(false);
    expect(networkBelongsToRail('USDT', 'BEP20')).toBe(false);
    expect(networkBelongsToRail('BTC', 'TRC20')).toBe(false);
    expect(networkBelongsToRail('', '')).toBe(false);
  });

  it('binds one asset to each rail', () => {
    expect(assetForRail('INR')).toBe('INR');
    expect(assetForRail('USDT')).toBe('USDT');
  });

  it('routes each rail to its own reference rule', () => {
    // Normalizing a UTR with the hash rule produces references that never
    // match anything, and payments that never settle.
    expect(normalizeReference('INR', 'utr123456').ok).toBe(true);
    expect(normalizeReference('INR', HASH).ok).toBe(false); // too long for a UTR
    expect(normalizeReference('USDT', HASH).ok).toBe(true);
    expect(normalizeReference('USDT', 'utr123456').ok).toBe(false);
  });
});

describe('redaction', () => {
  it('keeps enough of a reference to correlate and not enough to reuse', () => {
    const redacted = redactReference('ABCD12345678WXYZ');
    expect(redacted.startsWith('ABCD')).toBe(true);
    expect(redacted.endsWith('WXYZ')).toBe(true);
    expect(redacted).not.toContain('12345678');
    expect(redacted).toHaveLength('ABCD12345678WXYZ'.length);
  });

  it('hides a short value entirely', () => {
    expect(redactReference('ABC123')).toBe('******');
  });

  it('keeps a VPA handle and hides the identifier', () => {
    const redacted = redactDestination('somebody.real@bank');
    expect(redacted.endsWith('@bank')).toBe(true);
    expect(redacted).not.toContain('somebody');
  });

  it('redacts an address like any other reference', () => {
    const address = `T${'a'.repeat(33)}`;
    const redacted = redactDestination(address);
    expect(redacted).not.toBe(address);
    expect(redacted).toContain('*');
  });
});
