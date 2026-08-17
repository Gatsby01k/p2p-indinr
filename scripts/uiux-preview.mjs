#!/usr/bin/env node
/**
 * A built server for LOOKING at the product while finishing it.
 *
 * The same stack the gate uses — production build, isolated cluster,
 * `next start` — so what is being judged is the artefact that ships and
 * not a development server's approximation of it. Rebuilds on each
 * start; there is no watch mode, deliberately, because a hot-reloaded
 * dev bundle is exactly what this stage must not be judging.
 *
 *   node scripts/uiux-preview.mjs            build, then serve
 *   node scripts/uiux-preview.mjs --no-build  serve the last build
 */
import { buildProduction, startServer, GATE_LOG } from './e2e/stack.mjs';
import { rmSync } from 'node:fs';

const PORT = Number(process.env.UIUX_PORT ?? 3230);
if (!process.argv.includes('--no-build')) buildProduction();
rmSync(GATE_LOG, { force: true });
const server = await startServer({ port: PORT, log: GATE_LOG, label: 'uiux-preview' });
console.log(`preview on ${server.base}`);
// Held open by the child; nothing else to do.
await new Promise(() => {});
