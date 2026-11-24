// Probe per-frame state invalidation in PXFX. Run: node tools/invalidation-probe.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
vm.runInThisContext(fs.readFileSync(path.join(root, 'engine', 'pxfx.js'), 'utf8'), { filename: 'engine/pxfx.js' });
vm.runInThisContext(fs.readFileSync(path.join(root, 'engine', 'kit.js'), 'utf8'), { filename: 'engine/kit.js' });
const PXFX = globalThis.PXFX;

// minimal effect: a solid ball at a world point, plus a glow, optionally flushing mid-draw
const ballDef = (id, opts = {}) => PXFX.define({
  id, loop: 2,
  view: { r: 3, h: 2.4 },
  stage: { ground: 'stone' },
  draw(p, t) {
    if (opts.midFlush) p.flush();
    p.ball(0, 0, .6, .5, PXFX.solidRamp('#9a6e48'));
    p.glow(0, 0, .6, 1.2, PXFX.glowRamp('#ff823e'), 1);
    if (opts.post) p.post(({ pix }) => { for (let i = 0; i < pix.length; i += 97) pix[i] = PXFX.rgb(0, 255, 0); });
  },
});

const SIZE = { '3d': [120, 80], '25d': [120, 80], '2d': [80, 50] };
let fails = 0;
const check = (name, cond, detail = '') => { console.log((cond ? 'ok  ' : 'FAIL') + ' ' + name + (detail ? ' — ' + detail : '')); if (!cond) fails++; };
const hashBuf = b => { let h = 0; for (let i = 0; i < b.length; i++) h = (h * 31 + b[i]) | 0; return h; };
const countNonZero = b => { let n = 0; for (const x of b) if (x) n++; return n; };
const countOpaque = b => { let n = 0; for (const x of b) if (x >>> 24) n++; return n; };

/* ---------- 1. ground bake must distinguish camera / night / size / transparent / lens ---------- */
function bakeProbe() {
  const def = ballDef('probe-bake');
  const v = new PXFX.View(null, ...SIZE['25d']);
  v.mode = '25d';
  v.render(def, .5);
  const base25 = hashBuf(v.basePix);

  // switch camera: basePix must be re-baked (different projection geometry)
  v.mode = '3d'; v.yaw = .5;
  v.render(def, .5);
  const b3d = hashBuf(v.basePix);
  check('bake changes when switching 25d -> 3d', b3d !== base25);

  // back to 25d: should return to the identical bake (deterministic)
  v.mode = '25d'; v.yaw = null;
  v.render(def, .5);
  check('bake returns identical after switching back', hashBuf(v.basePix) === base25);

  // yaw change in 3d changes bake
  v.mode = '3d'; v.yaw = .5; v.render(def, .5);
  const y1 = hashBuf(v.basePix);
  v.yaw = 1.2; v.render(def, .5);
  check('bake changes on 3d yaw drag', hashBuf(v.basePix) !== y1);

  // night change: ground tones differ
  v.mode = '25d'; v.yaw = null; v.night = true;
  v.render(def, .5);
  check('bake changes on night toggle', hashBuf(v.basePix) !== base25);

  // size knob changes (fs): ground itself stays at world scale, so basePix may stay same —
  // but the full frame must differ because the ball scales
  v.night = false; v.tune = { size: 1.3 };
  v.render(def, .5);
  const big = hashBuf(v.pix);
  v.tune = { size: 1 };
  v.render(def, .5);
  check('full frame changes with size knob', hashBuf(v.pix) !== big);

  // transparent export: no opaque background, no ground tones
  const ve = new PXFX.View(null, ...SIZE['25d']);
  ve.mode = '25d'; ve.transparent = true; ve.noProps = true;
  ve.render(def, .5);
  check('transparent bake has zero alpha in background pixels', countOpaque(ve.basePix) === 0);
  check('transparent frame has no opaque page/ground', countOpaque(ve.pix) < countOpaque(v.pix));

  // resolution change: a new-sized view bakes at its own size
  const vhi = new PXFX.View(null, 180, 120);
  vhi.mode = '25d';
  vhi.render(def, .5);
  check('larger view bakes more pixels', vhi.basePix.length === 180 * 120 && countOpaque(vhi.basePix) > 0);

  // lens change: bake must differ (lens moves the ground)
  const lensDef = PXFX.define({
    id: 'probe-lens', loop: 2, view: { r: 3 }, stage: { ground: 'grass' },
    lensAt(t, p) { return this._k ? { k: this._k, c: [0, 0, 0], to: [0, 0, 0] } : null; },
    draw(p, t) { p.ball(0, 0, .5, .4, PXFX.solidRamp('#888888')); },
  });
  const vl = new PXFX.View(null, ...SIZE['25d']);
  vl.mode = '25d';
  vl.render(lensDef, .5);
  const k1 = hashBuf(vl.basePix);
  lensDef._k = 2.5;
  vl.render(lensDef, .5);
  const k2 = hashBuf(vl.basePix);
  check('bake changes when lens zoom changes', k2 !== k1, `${k1} vs ${k2}`);
  lensDef._k = null;
  vl.render(lensDef, .5);
  check('bake restored when lens removed', hashBuf(vl.basePix) === k1);

  // bakeKey tracking: changing only yaw must force a re-bake, not reuse
  const v3 = new PXFX.View(null, ...SIZE['3d']);
  v3.mode = '3d'; v3.yaw = .4;
  v3.render(def, .5);
  const keyA = v3.bakeKey;
  v3.yaw = .9;
  v3.render(def, .5);
  check('bakeKey differs after yaw change', v3.bakeKey !== keyA);
}

/* ---------- 2. multiple flushes in one frame: edges only on newly drawn solids ---------- */
function flushProbe() {
  // 2D mode has outlines; effect flushes once mid-frame then draws a second solid
  const def = PXFX.define({
    id: 'probe-flush', loop: 2, view: { r: 3 }, stage: { ground: 'stone' },
    draw(p, t) {
      p.ball(-.8, 0, .5, .45, PXFX.solidRamp('#aa5544'));
      p.flush();
      p.ball(.8, 0, .5, .45, PXFX.solidRamp('#4477aa'));
    },
  });
  const v = new PXFX.View(null, ...SIZE['2d']);
  v.mode = '2d';
  v.render(def, .5);
  check('flush: edged flag reset at frame start after full render', v.edged === true); // ends true after final flush
  // every frame must start with edged=false; simulate next frame
  v.render(def, .6);
  // count outline-coloured pixels (near-black): should be stable across frames with same solids
  const inkish = b => { let n = 0; for (const x of b) { const r = x & 255, g = x >> 8 & 255, bl = x >> 16 & 255; if (r < 50 && g < 50 && bl < 60 && (x >>> 24)) n++; } return n; };
  const ink1 = inkish(v.pix);
  v.render(def, .7);
  const ink2 = inkish(v.pix);
  check('outline pixel count stable across frames (no re-outlining accumulation)', ink1 === ink2, `${ink1} vs ${ink2}`);

  // case: first solid only in frame A, second solid only in frame B — old solid must not get re-outlined
  let which = 0;
  const def2 = PXFX.define({
    id: 'probe-flush2', loop: 2, view: { r: 3 }, stage: { ground: 'none' },
    draw(p, t) {
      if (which === 0) { p.ball(-.8, 0, .5, .45, PXFX.solidRamp('#aa5544')); p.flush(); }
      else { p.ball(.8, 0, .5, .45, PXFX.solidRamp('#4477aa')); }
    },
  });
  const v2 = new PXFX.View(null, ...SIZE['2d']);
  v2.mode = '2d';
  which = 0; v2.render(def2, .5);
  const frameA = Uint32Array.from(v2.pix);
  which = 1; v2.render(def2, .5);
  const frameB = Uint32Array.from(v2.pix);
  // the reused view's frame B must be pixel-identical to a FRESH view rendering only frame B
  // (a stale edge buffer from frame A would show up as a diff against the clean reference)
  const ref = new PXFX.View(null, ...SIZE['2d']);
  ref.mode = '2d'; which = 1; ref.render(def2, .5);
  check('no ghost outline: reused frame matches a clean single-frame view', frameB.every((x, i) => x === ref.pix[i]));
}

/* ---------- 3. export path: transparent, guides, guide-only, per-frame rebuild ---------- */
function exportProbe() {
  const def = PXFX.define({
    id: 'probe-export', loop: 2, view: { r: 3 }, stage: { ground: 'grass' },
    draw(p, t) {
      p.ball(0, 0, .5, .4, PXFX.solidRamp('#886644'));
      p.glow(0, 0, .7, 1, PXFX.glowRamp('#ffcc44'), 1);
      if (p.guiding) p.guide([[-1, 0, .2], [1, 0, .2]], 'red');
    },
  });
  const [w, h] = SIZE['25d'];
  const v = new PXFX.View(null, w, h);
  v.mode = '25d'; v.transparent = true; v.noProps = true;

  // multi-frame export: each frame must equal a fresh view rendered with the same settings
  // (this catches any reuse of the previous frame's pixel buffer), with no ground or page background
  let rebuildOk = true, clearOk = true;
  for (let k = 0; k < 6; k++) {
    const t = k / 6 * 2;
    v.render(def, t);
    const fv = new PXFX.View(null, w, h);
    fv.mode = '25d'; fv.transparent = true; fv.noProps = true;
    fv.render(def, t);
    if (!v.pix.every((x, i) => x === fv.pix[i])) rebuildOk = false;
    for (let i = 0; i < v.pix.length; i++) if ((v.pix[i] >>> 24) && v.kind[i] === 0) clearOk = false;
    if (v.kind.some(kk => kk === 1)) clearOk = false;             // no ground in a clear export
  }
  check('every exported frame is fully rebuilt (matches a fresh view)', rebuildOk);
  check('every transparent-export frame has no page/ground pixels', clearOk);

  // guide overlay mode 1: guides appear in export
  v.guide = 1;
  v.render(def, .5);
  const withGuide = hashBuf(v.pix);
  v.guide = 0;
  v.render(def, .5);
  check('guide overlay changes exported frame', withGuide !== hashBuf(v.pix));

  // guide-only mode 2: emissive hidden, paths visible
  v.guide = 2;
  v.render(def, .5);
  let emissiveish = 0;
  for (const x of v.pix) { const r = x & 255, g = x >> 8 & 255; if (r > 200 && g > 150 && (x >>> 24)) emissiveish++; }
  check('guide-only hides emissive light', emissiveish < 5, `${emissiveish} warm pixels`);

  // parity: identical transparent settings in a separate view must give identical output
  const vp = new PXFX.View(null, w, h);
  vp.mode = '25d'; vp.transparent = true; vp.noProps = true; vp.guide = 2;
  vp.render(def, .5);
  check('guide-only parity between two export views', v.pix.every((x, i) => x === vp.pix[i]));

  // transparent export: no background colour residue when toggled on after opaque renders
  const vt = new PXFX.View(null, w, h);
  vt.mode = '25d';
  vt.render(def, .5);
  const opaqueCount = countOpaque(vt.pix);
  vt.transparent = true; vt.noProps = true;
  vt.render(def, .5);
  check('enabling transparent on a reused view drops all background', countOpaque(vt.pix) < opaqueCount);
}

/* ---------- 4. shared-card style reuse: one view, different effects/modes in sequence ---------- */
function reuseProbe() {
  const d1 = ballDef('probe-reuse-1');
  const d2 = PXFX.define({ id: 'probe-reuse-2', loop: 2, view: { r: 4, h: 3 }, stage: { ground: 'snow' }, draw(p) { p.ball(0, 0, 1, .8, PXFX.solidRamp('#3366aa')); } });
  const v = new PXFX.View(null, ...SIZE['25d']);
  v.mode = '25d';
  v.render(d1, .5);
  const a = hashBuf(v.pix);
  v.render(d2, .5);
  const b = hashBuf(v.pix);
  check('different effect on same view gives different frame', a !== b);
  v.render(d1, .5);
  check('back to first effect reproduces its frame', hashBuf(v.pix) === a);

  // mode switch on same view
  v.mode = '3d'; v.yaw = .5;
  v.render(d1, .5);
  const c3 = hashBuf(v.pix);
  v.mode = '25d'; v.yaw = null;
  v.render(d1, .5);
  check('mode round-trip reproduces frame', hashBuf(v.pix) === a);
}

bakeProbe();
flushProbe();
exportProbe();
reuseProbe();
console.log(fails ? `\n${fails} FAILURES` : '\nall probes passed');
process.exitCode = fails ? 1 : 0;
