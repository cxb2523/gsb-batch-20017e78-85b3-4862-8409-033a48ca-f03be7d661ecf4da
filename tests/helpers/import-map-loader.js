// Node ESM loader: resolve the browser import-map bare specifiers to the
// locally installed packages so the unmodified js/ sources run under node --test.
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

// require.resolve('three') gives build/three.cjs; the package root is one up.
const threeRoot = path.dirname(path.dirname(require.resolve('three')));
const earcutRoot = path.dirname(path.dirname(require.resolve('earcut')));

const RESOLVE_ALIASES = {
  three: pathToFileURL(path.join(threeRoot, 'build/three.module.js')).href,
  earcut: pathToFileURL(path.join(earcutRoot, 'src/earcut.js')).href,
};

export async function resolve(specifier, context, nextResolve) {
  if (RESOLVE_ALIASES[specifier]) {
    return { url: RESOLVE_ALIASES[specifier], shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
