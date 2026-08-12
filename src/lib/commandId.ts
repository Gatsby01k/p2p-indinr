'use client';

import { useRef } from 'react';

/**
 * Command identity, minted by the caller.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  WHY THE CLIENT SUPPLIES THIS AND NOT THE SERVER.                  │
 * │                                                                    │
 * │  A server-generated id cannot make a retry safe, because the retry │
 * │  would generate a second one. The whole point of an idempotency    │
 * │  key is that it is stable across the attempts the CALLER considers │
 * │  to be the same request — and only the caller knows that.          │
 * │                                                                    │
 * │  The retry that matters here is the ordinary one: a submit that    │
 * │  times out, a flaky mobile connection, a person tapping twice      │
 * │  because nothing visibly happened. Without a stable id each of     │
 * │  those creates a second deal.                                      │
 * └────────────────────────────────────────────────────────────────────┘
 */

export function newCommandId(): string {
  // `randomUUID` needs a secure context, which every origin this app is
  // served from provides — a Telegram Mini App is required to be HTTPS.
  // The fallback keeps a plain-HTTP development host working rather than
  // throwing where a UUID is only an identifier, never a secret.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Whether the server actually decided.
 *
 * `UNKNOWN` is the code the action returns when it could not determine
 * what happened — and it is exactly the case where a command id must be
 * KEPT, because the mutation may well have committed. Anything else,
 * success or a named domain rejection, is a decision.
 */
export function isDefinitiveOutcome(result: {
  readonly ok: boolean;
  readonly code?: string;
}): boolean {
  if (result.ok) return true;
  return result.code !== undefined && result.code !== 'UNKNOWN';
}

export interface CommandIdHandle {
  /** The id for the attempt starting now. Stable until it is settled. */
  next(): string;
  /**
   * Release the id: the server gave a definitive answer.
   *
   * Called for a success AND for a named domain rejection, because both
   * are decisions — a person told their amount is too small and then
   * correcting it is making a genuinely different request, and reusing
   * the id would earn them an idempotency conflict instead of a quote.
   */
  settle(): void;
  /**
   * Settle only if the server decided; otherwise KEEP the id.
   *
   * This is the safe default and what every flow should call. An
   * `UNKNOWN` result means the action could not tell whether the command
   * committed — a post-commit presentation failure looks exactly like a
   * pre-commit one from here — so the retry must carry the SAME id and
   * let the boundary replay rather than act twice.
   *
   * A thrown call never reaches this line at all, which is the other case
   * where the id must survive.
   */
  settleIfDefinitive(result: { readonly ok: boolean; readonly code?: string }): void;
}

/**
 * A command id that survives retries of the same submission.
 *
 * ```ts
 * const command = useCommandId();
 * const result = await claimAction(command.next(), dealId, utr, note);
 * command.settle();
 * ```
 */
export function useCommandId(): CommandIdHandle {
  const held = useRef<string | null>(null);
  const handle = useRef<CommandIdHandle | null>(null);

  if (handle.current === null) {
    handle.current = {
      next() {
        if (held.current === null) held.current = newCommandId();
        return held.current;
      },
      settle() {
        held.current = null;
      },
      settleIfDefinitive(result) {
        if (isDefinitiveOutcome(result)) held.current = null;
      },
    };
  }
  return handle.current;
}
