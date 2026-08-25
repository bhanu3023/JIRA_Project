import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const SRC = path.resolve(process.cwd(), 'src');

/** Candidate on-disk targets for a specifier TypeScript would have resolved for us. */
function candidates(base) {
  return [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')];
}

function firstExisting(base) {
  return candidates(base).find(existsSync);
}

export async function resolve(specifier, context, nextResolve) {
  // Cache-busting query (./hotjar.ts?case=3) must survive to the default resolver, which uses it
  // to hand back a fresh module instance -- strip it only while touching the filesystem.
  const [bare, ownQuery] = specifier.split('?');

  // Propagated down the whole subgraph, not just the module the test imported by name: without
  // this, a re-imported hotjar.ts?case=3 would still bind the runtimeConfig instance cached from
  // case 1, so every case after the first would read the first case's site ID.
  const inherited = context.parentURL?.split('?')[1];
  const query = ownQuery || inherited;
  const suffix = query ? `?${query}` : '';

  if (bare.startsWith('@/')) {
    const base = path.join(SRC, bare.slice(2));
    const hit = existsSync(base) ? base : firstExisting(base);
    if (hit) return nextResolve(pathToFileURL(hit).href + suffix, context);
  }

  if (bare.startsWith('.') && !path.extname(bare) && context.parentURL) {
    const base = path.resolve(path.dirname(fileURLToPath(context.parentURL)), bare);
    const hit = firstExisting(base);
    if (hit) return nextResolve(pathToFileURL(hit).href + suffix, context);
  }

  // Extension-bearing relative imports still need the inherited query to stay on the busted graph.
  if (bare.startsWith('.') && suffix && context.parentURL) {
    const abs = path.resolve(path.dirname(fileURLToPath(context.parentURL)), bare);
    if (existsSync(abs)) return nextResolve(pathToFileURL(abs).href + suffix, context);
  }

  return nextResolve(specifier, context);
}
