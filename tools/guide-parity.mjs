// Guide-mode parity: capture opaque frames with guides on (modes 1 and 2) for --write, then compare.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const write = process.argv.includes('--write');
const baseDir = path.join(os.tmpdir(), 'pxfx-guide-baseline');
vm.runInThisContext(fs.readFileSync(path.join(root, 'engine', 'pxfx.js'), 'utf8'), {});
vm.runInThisContext(fs.readFileSync(path.join(root, 'engine', 'kit.js'), 'utf8'), {});
const PXFX = globalThis.PXFX;
const SIZE = { '3d': [160, 100], '25d': [160, 100], '2d': [120, 75] };
// effects known to register guides
const ids = ['endless-blade', 'echo-blade', 'drawn-lightning', 'rune-projector', 'anvil-field', 'fireball'];
if (write) fs.rmSync(baseDir, { recursive: true, force: true });
fs.mkdirSync(baseDir, { recursive: true });
let bad = 0, n = 0;
for (const id of ids) {
  try { vm.runInThisContext(fs.readFileSync(path.join(root, 'fx', id + '.js'), 'utf8'), {}); } catch (e) { continue; }
  const def = PXFX.get(id); if (!def) continue;
  for (const mode of ['3d', '25d', '2d']) for (const guide of [1, 2]) {
    const [w, h] = SIZE[mode];
    const v = new PXFX.View(null, w, h);
    v.mode = mode; v.guide = guide; if (mode === '3d') v.yaw = .62;
    const tm = PXFX.timing(def, {});
    const buf = [];
    for (const u of [.2, .5, .8]) { v.renderAt(def, PXFX.frameTime(u * Math.min(def.loop, tm.length), mode), tm, { noShake: true }); buf.push(...v.pix); }
    const fp = path.join(baseDir, `${id}-${mode}-g${guide}.bin`);
    const out = Buffer.from(new Uint8Array(new Uint32Array(buf).buffer));
    if (write) fs.writeFileSync(fp, out);
    else { n++; if (!fs.existsSync(fp) || !fs.readFileSync(fp).equals(out)) { console.log('GUIDE DIFF', id, mode, guide); bad++; } }
  }
}
if (write) console.log('guide baseline written');
else console.log(bad ? `${bad}/${n} guide frames differ` : `all ${n} guide frames match baseline`);
process.exitCode = bad ? 1 : 0;
