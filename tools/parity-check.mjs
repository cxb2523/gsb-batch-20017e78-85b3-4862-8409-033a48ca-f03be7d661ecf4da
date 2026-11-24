// Visual parity guard: the invalidation fixes must not change normal (opaque) rendering.
// Renders every effect in all three modes, day + night, at several times, and compares each frame
// against a reference captured from a pristine engine checkout (baseline/ directory, outside the repo).
// Run once with --write to capture the baseline, then plain to compare.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const write = process.argv.includes('--write');
const baseDir = path.join(os.tmpdir(), 'pxfx-parity-baseline');
vm.runInThisContext(fs.readFileSync(path.join(root, 'engine', 'pxfx.js'), 'utf8'), {});
vm.runInThisContext(fs.readFileSync(path.join(root, 'engine', 'kit.js'), 'utf8'), {});
const PXFX = globalThis.PXFX;
const SIZE = { '3d': [160, 100], '25d': [160, 100], '2d': [120, 75] };
const ids = fs.readdirSync(path.join(root, 'fx')).filter(f => f.endsWith('.js')).map(f => f.slice(0, -3));
let mismatches = 0, compared = 0;
if (write) fs.rmSync(baseDir, { recursive: true, force: true });
fs.mkdirSync(baseDir, { recursive: true });

for (const id of ids) {
  try { vm.runInThisContext(fs.readFileSync(path.join(root, 'fx', id + '.js'), 'utf8'), {}); }
  catch (e) { console.log('LOAD FAIL', id, e.message); mismatches++; continue; }
  const def = PXFX.get(id);
  if (!def) continue;
  for (const mode of ['3d', '25d', '2d']) for (const night of [false, true]) {
    const [w, h] = SIZE[mode];
    const v = new PXFX.View(null, w, h);
    v.mode = mode; v.night = night; if (mode === '3d') v.yaw = .62;
    const tm = PXFX.timing(def, {});
    const buf = [];
    for (const u of [.12, .5, .88]) {
      v.renderAt(def, PXFX.frameTime(u * Math.min(def.loop, tm.length), mode), tm, { noShake: true });
      buf.push(...v.pix);
    }
    const key = `${id}-${mode}-${night ? 'n' : 'd'}.bin`;
    const fp = path.join(baseDir, key);
    const out = Buffer.from(new Uint8Array(new Uint32Array(buf).buffer));
    if (write) fs.writeFileSync(fp, out);
    else {
      compared++;
      if (!fs.existsSync(fp) || !fs.readFileSync(fp).equals(out)) { console.log('VISUAL DIFF', key); mismatches++; }
    }
  }
}
if (write) console.log('baseline written to', baseDir);
else console.log(mismatches ? `${mismatches}/${compared} frames differ from baseline` : `all ${compared} opaque frames match baseline`);
process.exitCode = mismatches ? 1 : 0;
