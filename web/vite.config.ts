import { svelte } from '@sveltejs/vite-plugin-svelte';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

// Where the dev server forwards /ws and /api (see `make web-dev`).
const engine = process.env.ILS_ENGINE ?? 'http://127.0.0.1:8642';

// Dev only: serves the repository's sessions/ folder under /sessions/, so a
// recorded session opens with ?session=sessions/samples/<file>.ils and no engine.
function devSessions(): Plugin {
  const root = resolve(import.meta.dirname, '../sessions');
  return {
    name: 'ils-dev-sessions',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/sessions', (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? '').split('?')[0]);
        const file = resolve(root, '.' + rel);
        if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) {
          next();
          return;
        }
        res.setHeader('Content-Type', 'application/octet-stream');
        createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  // Relative URLs: the same build is served by the binary and as a static site.
  base: './',
  // `make web-shots` runs its own dev server next to others: a cache of its own.
  cacheDir: process.env.ILS_VITE_CACHE ?? 'node_modules/.vite',
  plugins: [svelte(), devSessions()],
  build: {
    target: 'es2022',
    // The relief chunk is three.js (~580 kB, ~145 kB gzip): loaded with
    // import() after the page is usable, so its size does not delay start-up.
    chunkSizeWarningLimit: 650,
  },
  server: {
    proxy: {
      '/ws': { target: engine, ws: true },
      '/api': { target: engine },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
