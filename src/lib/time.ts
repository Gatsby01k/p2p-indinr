/** Deterministic clock helpers. Fixed epoch keeps mock scenarios reproducible. */

export const MOCK_EPOCH_MS = Date.UTC(2026, 7, 2, 9, 30, 0);

export function nowMs(): number {
  return Date.now();
}

export function iso(offsetMs: number, base: number = MOCK_EPOCH_MS): string {
  return new Date(base + offsetMs).toISOString();
}

export function minutes(n: number): number {
  return n * 60_000;
}

export function secondsUntil(isoTime: string, from: number = Date.now()): number {
  const target = Date.parse(isoTime);
  if (Number.isNaN(target)) return 0;
  return Math.max(0, Math.round((target - from) / 1000));
}

export function formatCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${String(rem).padStart(2, '0')}`;
}

/** "2 Aug 2026, 15:00" — Indian reading order, unambiguous month. */
export function formatDateTime(isoTime: string): string {
  const d = new Date(isoTime);
  if (Number.isNaN(d.getTime())) return '—';
  const day = d.getDate();
  const month = d.toLocaleString('en-IN', { month: 'short' });
  const year = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${day} ${month} ${year}, ${hh}:${mm}`;
}

export function formatRelative(isoTime: string, from: number = Date.now()): string {
  const t = Date.parse(isoTime);
  if (Number.isNaN(t)) return '—';
  const diff = Math.round((from - t) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
