import { describe, expect, it } from 'vitest';
import { isDefinitiveOutcome } from '@/lib/commandId';

/**
 * The command-settlement contract.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THE BUG THIS ENCODES.                                             │
 * │                                                                    │
 * │  A wrapper used to run the command and `revalidatePath()` inside   │
 * │  one `try`. So:                                                    │
 * │                                                                    │
 * │    runCommand commits → revalidatePath throws → catch returns      │
 * │    UNKNOWN → client settles its id → retry mints a NEW id →        │
 * │    the SAME mutation executes a second time.                       │
 * │                                                                    │
 * │  Two independent corrections close it, and both are tested:        │
 * │  the server no longer converts a committed result into UNKNOWN     │
 * │  (`afterCommit`, proved in the integration suite), and the client  │
 * │  no longer releases an id it has no answer for (`isDefinitive`,    │
 * │  proved here).                                                     │
 * └────────────────────────────────────────────────────────────────────┘
 */

/** A minimal stand-in for the hook's ref, so the policy is testable. */
function commandIdSlot(mint: () => string) {
  let held: string | null = null;
  return {
    next() {
      if (held === null) held = mint();
      return held;
    },
    settleIfDefinitive(result: { ok: boolean; code?: string }) {
      if (isDefinitiveOutcome(result)) held = null;
    },
    peek: () => held,
  };
}

describe('isDefinitiveOutcome', () => {
  it('treats a success as definitive', () => {
    expect(isDefinitiveOutcome({ ok: true })).toBe(true);
  });

  it('treats a named domain rejection as definitive', () => {
    for (const code of [
      'AMOUNT_TOO_SMALL',
      'IDEMPOTENCY_CONFLICT',
      'NOT_A_PARTICIPANT',
      'LINK_CONSUMED',
      'ADAPTER_UNAVAILABLE',
    ]) {
      expect(isDefinitiveOutcome({ ok: false, code }), code).toBe(true);
    }
  });

  it('treats UNKNOWN as NOT definitive', () => {
    expect(isDefinitiveOutcome({ ok: false, code: 'UNKNOWN' })).toBe(false);
  });

  it('treats a missing code as NOT definitive', () => {
    // No code at all is the same epistemic position as UNKNOWN.
    expect(isDefinitiveOutcome({ ok: false })).toBe(false);
  });
});

describe('command id lifecycle', () => {
  let n = 0;
  const mint = () => `id-${++n}`;

  it('keeps one id across repeated reads of the same attempt', () => {
    const slot = commandIdSlot(mint);
    const first = slot.next();
    expect(slot.next()).toBe(first);
  });

  it('releases the id after a definitive success', () => {
    const slot = commandIdSlot(mint);
    const first = slot.next();
    slot.settleIfDefinitive({ ok: true });
    expect(slot.next()).not.toBe(first);
  });

  it('releases the id after a definitive rejection, so a correction is a new request', () => {
    const slot = commandIdSlot(mint);
    const first = slot.next();
    slot.settleIfDefinitive({ ok: false, code: 'AMOUNT_TOO_SMALL' });
    const corrected = slot.next();
    expect(corrected).not.toBe(first);
  });

  it('RETAINS the id when the outcome is UNKNOWN', () => {
    const slot = commandIdSlot(mint);
    const first = slot.next();
    slot.settleIfDefinitive({ ok: false, code: 'UNKNOWN' });
    // The retry must replay, not act again.
    expect(slot.next()).toBe(first);
  });

  it('RETAINS the id when the call throws before any answer', () => {
    const slot = commandIdSlot(mint);
    const first = slot.next();
    // A transport failure never reaches a settle call at all.
    expect(slot.peek()).toBe(first);
    expect(slot.next()).toBe(first);
  });

  it('a committed success reported as UNKNOWN cannot mint a second id', () => {
    /*
     * The exact defective sequence, replayed against the corrected
     * policy: the command committed, presentation failed, the action
     * reported UNKNOWN. The client must retry with the ORIGINAL id so the
     * boundary replays the committed result instead of duplicating it.
     */
    const slot = commandIdSlot(mint);
    const submitted = slot.next();
    slot.settleIfDefinitive({ ok: false, code: 'UNKNOWN' });
    const retried = slot.next();
    expect(retried).toBe(submitted);
  });

  it('an operator correcting a refused ruling receives a new id', () => {
    const slot = commandIdSlot(mint);
    const rejected = slot.next();
    slot.settleIfDefinitive({ ok: false, code: 'NOT_FOUND' }); // reason too short
    expect(slot.next()).not.toBe(rejected);
  });
});
