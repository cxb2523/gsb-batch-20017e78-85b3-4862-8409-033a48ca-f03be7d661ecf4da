// Differential invalidation harness: for every effect, a long-lived view driven through state
// transitions must match a freshly-constructed view after each transition. Any leftover per-frame
// state (ground bake, edge buffers, light buffers, guides, transparent flag...) shows up as a diff.
// Run: node tools/diff-check.mjs [id...]
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
vm.runInThisContext(fs.readFileSync(path.join(root, 'engine', 'pxfx.js'), 'utf8'), {});
vm.runInThisContext(fs.readFileSync(path.join(root, 'engine', 'kit.js'), 'utf8'), {});
const PXFX = globalThis.PXFX;
const SIZE = { '3d': [240, 150], '25d': [240, 150], '2d': [160, 100] };

const only = process.argv.slice(2);
const ids = only.length ? only : fs.readdirSync(path.join(root, 'fx')).filter(f => f.endsWith('.js')).map(f => f.slice(0, -3));
let totalFails = 0;

const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const count = (a, pred) => { let n = 0; for (const x of a) if (pred(x)) n++; return n; };

// a sequence of (label, apply) transitions applied to BOTH a reused view and fresh views per step
function transitionsFor(mode) {
  const seq = [
    ['baseline', v => { v.mode = mode; }],
    ['night-on', v => { v.mode = mode; v.night = true; }],
    ['night-off', v => { v.mode = mode; v.night = false; }],
    ['size-up', v => { v.mode = mode; v.night = false; v.tune = { size: 1.4 }; }],
    ['size-back', v => { v.mode = mode; v.tune = { size: 1 }; }],
    ['density-low', v => { v.mode = mode; v.tune = { density: .4 }; }],
    ['guide-1', v => { v.mode = mode; v.tune = {}; v.guide = 1; }],
    ['guide-2', v => { v.mode = mode; v.guide = 2; }],
    ['guide-off', v => { v.mode = mode; v.guide = 0; }],
    ['transparent', v => { v.mode = mode; v.transparent = true; v.noProps = true; }],
    ['opaque-again', v => { v.mode = mode; v.transparent = false; v.noProps = false; }],
  ];
  if (mode === '3d') {
    seq.push(['yaw-drag', v => { v.mode = '3d'; v.yaw = 1.15; }]);
    seq.push(['yaw-back', v => { v.mode = '3d'; v.yaw = .5; }]);
  }
  return seq;
}

for (const id of ids) {
  let def;
  try {
    vm.runInThisContext(fs.readFileSync(path.join(root, 'fx', id + '.js'), 'utf8'), { filename: `fx/${id}.js` });
    def = PXFX.get(id);
  } catch (e) { console.log('LOAD FAIL', id, e.message); totalFails++; continue; }
  if (!def) continue;

  for (const mode of ['3d', '25d', '2d']) {
    const [w, h] = SIZE[mode];
    const tm = PXFX.timing(def, {});
    const times = [0.05, .35, .7, .95].map(u => PXFX.frameTime(u * Math.min(def.loop, tm.length), mode));
    const seq = transitionsFor(mode);
    const reused = new PXFX.View(null, w, h);
    // warm up so module caches exist in both worlds equally
    reused.mode = mode; if (mode === '3d') reused.yaw = .5;
    reused.render(def, times[0]);

    for (const [label, apply] of seq) {
      apply(reused);
      for (const t of times) reused.renderAt(def, t, tm, { noShake: true });
      // fresh reference after the same transition
      const fresh = new PXFX.View(null, w, h);
      apply(fresh);
      fresh.renderAt(def, times[times.length - 1], tm, { noShake: true });
      reused.renderAt(def, times[times.length - 1], tm, { noShake: true });
      if (!eq(reused.pix, fresh.pix)) {
        let d = 0; const kd = {};
        for (let i = 0; i < reused.pix.length; i++) if (reused.pix[i] !== fresh.pix[i]) { d++; const k = reused.kind[i]; kd[k] = (kd[k] || 0) + 1; }
        console.log(`FAIL ${id} [${mode}] ${label}: ${d} px differ, kinds=${JSON.stringify(kd)}`);
        totalFails++;
      }
    }

    // multi-frame export simulation on one view: transparent, sequential frames must each be
    // fully rebuilt (frame k must not carry pixels from frame k-1) and match a fresh per-frame view
    {
      const ev = new PXFX.View(null, w, h);
      ev.mode = mode; ev.transparent = true; ev.noProps = true; ev.guide = 1;
      const prevHashes = new Set();
      let groundLeak = 0, bgOpaque = 0, mismatch = 0;
      for (let k = 0; k < 5; k++) {
        const t = times[k % times.length];
        ev.renderAt(def, t, tm, { noShake: true });
        const fv = new PXFX.View(null, w, h);
        fv.mode = mode; fv.transparent = true; fv.noProps = true; fv.guide = 1;
        fv.renderAt(def, t, tm, { noShake: true });
        if (!eq(ev.pix, fv.pix)) mismatch++;
        // transparent-export invariants: no ground pixels (kind 1), and nothing opaque may sit on
        // untouched background (kind 0) — opaque pixels must come from the effect itself (kinds 2/3/4)
        for (let i = 0; i < ev.pix.length; i++) {
          if (ev.kind[i] === 1) groundLeak++;
          if ((ev.pix[i] >>> 24) && ev.kind[i] === 0) bgOpaque++;
        }
        prevHashes.add(ev.pix.reduce((a, x) => (a * 31 + x) | 0, 7));
      }
      if (mismatch || groundLeak || bgOpaque) {
        console.log(`FAIL ${id} [${mode}] export-sim mismatch=${mismatch}/5 groundKind1=${groundLeak} opaqueKind0=${bgOpaque}`);
        totalFails++;
      }
    }
  }
}
console.log(totalFails ? `\n${totalFails} DIFFERENTIAL FAILURES` : '\nall differential checks passed across ' + ids.length + ' effects');
process.exitCode = totalFails ? 1 : 0;
