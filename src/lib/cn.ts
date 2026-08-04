/** Minimal class joiner. No dependency, no runtime surprises. */
export type ClassValue = string | number | false | null | undefined;

export function cn(...values: ClassValue[]): string {
  let out = '';
  for (const v of values) {
    if (!v && v !== 0) continue;
    const s = String(v).trim();
    if (!s) continue;
    out = out ? `${out} ${s}` : s;
  }
  return out;
}
