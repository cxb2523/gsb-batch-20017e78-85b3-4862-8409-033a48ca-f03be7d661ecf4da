// Copies sessions/index.json and the session files it lists into the static
// build (`make web-static`). Run from web/: node scripts/static-sessions.mjs <outDir>
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const out = join(process.argv[2] ?? 'dist-static', 'sessions');
const src = '../sessions';
const index = JSON.parse(readFileSync(join(src, 'index.json'), 'utf8'));
mkdirSync(out, { recursive: true });
copyFileSync(join(src, 'index.json'), join(out, 'index.json'));
for (const { file } of index) {
  mkdirSync(dirname(join(out, file)), { recursive: true });
  copyFileSync(join(src, file), join(out, file));
}
console.log(`static-sessions: ${index.length} sessions copied into ${out}`);
