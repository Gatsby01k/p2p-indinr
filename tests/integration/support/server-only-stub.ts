/**
 * `server-only` is a Next.js build-time guard: importing it from a client
 * component is a compile error. It has no runtime behaviour, so under Vitest's
 * Node environment it is aliased to this empty module.
 *
 * This does not weaken the guard — `next build` still enforces it against the
 * real package (see the production build in the verification run).
 */
export {};
