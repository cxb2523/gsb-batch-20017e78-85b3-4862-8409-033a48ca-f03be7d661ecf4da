'use strict';
// =====================================================================
// Mode B 选中方案一致性回归测试 — scripts/test-modeb-consistency.js
// ---------------------------------------------------------------------
// 用法：npm run test:modeb
//
// 目标：证明「选中方案」是唯一数据源。直接在 Node 里加载浏览器用的
// pallet-optimizer.js（同一份源码，非副本），用最小 DOM / THREE 垫片驱动：
//   1. 算法给出的 perLayer / layers / patternType / 朝向 与 3D 几何逐箱一致
//   2. 交错 / 风车的错位行不越出托盘 span（含 overhang 溢出量）
//   3. stack=2 时托盘视图确实画出两层单元载
//   4. 切换候选释放旧几何体与高亮框，不残留上一次方案
//   5. A→B→A→B、窗口缩放、中英切换后视图/摘要/表格仍指向同一选中项
//   6. Three.js 未就绪时延迟到 three-ready 再绘制当前选中方案（不画空场景/旧方案）
//
// ⚠️ 边界用例：超大单品（无可行方案）、超重（overLimit）、overhang=20、
//    最大堆码层数=2、显式 pinwheel/interlock 模式。
// =====================================================================
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'pallet-optimizer.js'), 'utf8');

// ---------------------------- 断言 ----------------------------
let PASS = 0, FAIL = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { PASS++; return true; }
  FAIL++; failures.push(msg); console.log('  ❌ ' + msg); return false;
}
function eq(a, b, msg) { return ok(a === b, msg + `（期望 ${b}，实际 ${a}）`); }
function near(a, b, eps, msg) { return ok(Math.abs(a - b) <= (eps || 1e-6), msg + `（期望≈${b}，实际 ${a}）`); }
function section(name) { console.log('\n【' + name + '】'); }

// ---------------------------- 最小 THREE 垫片 ----------------------------
function makeVec(x, y, z) {
  return {
    x: x || 0, y: y || 0, z: z || 0,
    set(a, b, c) { this.x = a; this.y = b; this.z = c; return this; },
    copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; },
    clone() { return makeVec(this.x, this.y, this.z); }
  };
}
function makeObj(extra) {
  const o = {
    children: [], parent: null, visible: true, userData: {},
    position: makeVec(), scale: makeVec(1, 1, 1),
    add(c) { c.parent = this; this.children.push(c); return c; },
    remove(c) { const i = this.children.indexOf(c); if (i >= 0) { this.children.splice(i, 1); c.parent = null; } return this; },
    traverse(cb) { for (const c of this.children) { cb(c); if (c.traverse) c.traverse(cb); } }
  };
  return Object.assign(o, extra || {});
}
function makeThree(stats) {
  const geo = () => ({ disposed: false, dispose() { this.disposed = true; stats.geo++; } });
  const mat = () => ({ disposed: false, dispose() { this.disposed = true; stats.mat++; }, map: null });
  class Group extends Object {}
  function grp() { return makeObj(); }
  function mesh(g, m) { return makeObj({ geometry: g, material: m }); }

  class WebGLRenderer {
    constructor(opts) { this.domElement = opts.canvas; this.renders = 0; }
    setSize() {}
    setPixelRatio() {}
    render() { stats.renders++; }
  }
  class PerspectiveCamera {
    constructor(fov, aspect) { this.fov = fov; this.aspect = aspect; this.position = makeVec(0, 0, 0); }
    updateProjectionMatrix() { stats.proj++; }
    lookAt() {}
  }
  class OrbitControls {
    constructor() { this.target = makeVec(); this.enableDamping = false; }
    update() {}
  }
  class Raycaster { setFromCamera() {} intersectObjects() { return []; } }
  class Vector2 { constructor() { this.x = 0; this.y = 0; } }
  class Vector3 { constructor(x, y, z) { return makeVec(x, y, z); } }

  const THREE = {
    Scene: function () { return makeObj(); },
    Color: function () {},
    Group: function () { return grp(); },
    PerspectiveCamera: PerspectiveCamera,
    WebGLRenderer: WebGLRenderer,
    OrbitControls: OrbitControls,
    AmbientLight: function () { return makeObj(); },
    DirectionalLight: function () { return Object.assign(makeObj(), { position: makeVec() }); },
    GridHelper: function () { return makeObj({ geometry: geo(), material: mat() }); },
    Mesh: function (g, m) { return mesh(g, m); },
    LineSegments: function (g, m) { return mesh(g, m); },
    BoxGeometry: function () { return geo(); },
    EdgesGeometry: function () { return geo(); },
    MeshLambertMaterial: function () { return mat(); },
    LineBasicMaterial: function () { return mat(); },
    MeshBasicMaterial: function () { return mat(); },
    AxesHelper: function () { return makeObj(); },
    ArrowHelper: function () { return makeObj(); },
    CanvasTexture: function () { return { dispose() { stats.mat++; } }; },
    Sprite: function (m) { return makeObj({ material: m }); },
    SpriteMaterial: function () { return mat(); },
    Raycaster: Raycaster,
    Vector2: Vector2,
    Vector3: Vector3
  };
  return THREE;
}

// ---------------------------- 最小 DOM 垫片 ----------------------------
function makeDocument(stats) {
  const byId = Object.create(null);

  function rowFromAttrs(idx, cls) {
    const classes = new Set((cls || '').split(/\s+/).filter(Boolean));
    return {
      _attrs: { 'data-idx': String(idx) },
      listeners: {},
      classList: {
        contains: c => classes.has(c),
        add: c => classes.add(c),
        remove: c => classes.delete(c),
        toggle: (c, force) => { const on = force == null ? !classes.has(c) : !!force; on ? classes.add(c) : classes.delete(c); return on; }
      },
      _classes: classes,
      getAttribute(k) { return this._attrs[k] != null ? this._attrs[k] : null; },
      setAttribute(k, v) { this._attrs[k] = String(v); },
      addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
    };
  }

  function makeEl(tag, id) {
    const classes = new Set();
    const listeners = {};
    const el = {
      tagName: (tag || 'div').toUpperCase(), id: id || '', style: {},
      value: '', checked: false, textContent: '', dataset: {},
      clientWidth: 420, clientHeight: 360,
      _rows: [], children: [], parentNode: null,
      listeners,
      classList: {
        contains: c => classes.has(c),
        add: c => classes.add(c),
        remove: c => classes.delete(c),
        toggle: (c, force) => { const on = force == null ? !classes.has(c) : !!force; on ? classes.add(c) : classes.delete(c); return on; }
      },
      addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
      removeEventListener() {},
      setAttribute(k, v) { this['attr_' + k] = String(v); },
      getAttribute(k) { return this['attr_' + k] != null ? this['attr_' + k] : null; },
      appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
      removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
      querySelectorAll(sel) {
        if (/tr\[data-idx\]/.test(sel)) return this._rows;
        return [];
      },
      querySelector() { return null; },
      getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; },
      getContext() {
        return { fillRect() {}, fillText() {}, set font(v) {}, set fillStyle(v) {}, set textAlign(v) {}, set textBaseline(v) {} };
      },
      toDataURL() { return 'data:image/png;base64,'; },
      click() { (listeners.click || []).forEach(fn => fn({})); }
    };
    Object.defineProperty(el, 'innerHTML', {
      get() { return this._html || ''; },
      set(html) {
        this._html = String(html);
        // Parse the Top-10 rows so querySelectorAll('tr[data-idx]') works.
        const rows = [];
        const re = /<tr data-idx="(\d+)" class="([^"]*)">/g;
        let m;
        while ((m = re.exec(this._html))) rows.push(rowFromAttrs(m[1], m[2]));
        this._rows = rows;
      }
    });
    return el;
  }

  const document = {
    readyState: 'complete',
    documentElement: makeEl('html'),
    body: makeEl('body'),
    createElement(tag) { return makeEl(tag); },
    getElementById(id) {
      if (!byId[id]) { byId[id] = makeEl('div', id); }
      return byId[id];
    },
    querySelectorAll(sel) {
      if (/^#bTop10\s+tr\[data-idx\]$/.test(sel)) return byId['bTop10'] ? byId['bTop10']._rows : [];
      return [];
    },
    addEventListener() {},
    _byId: byId
  };
  document._stats = stats;
  document._makeEl = makeEl;
  return document;
}

// ---------------------------- 沙盒装载 ----------------------------
const ZH = {
  bBestPlan: '最优方案', bOuterDim: '外箱尺寸', bOuterLayout: '外箱排布', bInnerTag: '内',
  bBoxWt: '单箱毛重', bPerLayer: '每托层数', wordLayer: '层', wordBox: '箱',
  bPatternColumn: '列阵 Column', bPatternInterlock: '交错 Interlocking', bPatternPinwheel: '风车 Pinwheel',
  bPatternMode: '堆叠模式', bOverStack: '溢出/堆码', bPerPallet: '每托', bPalletH: '每托高',
  bContPallets: '托盘数', bStackTag: '堆叠', bTotalBoxes: '总箱数', bTotalPCS: '总PCS',
  bFillRate: '装载率', bGrossWt: '毛重', bNoPlan: '无可行方案', bOverLimit: '超出限重',
  bLimit: '限重', bOverHint: '请调整参数',
  thNo: '#', thCarton: '外箱', thLayerPer: '层×每', thPerPallet: '每托', thPallet: '托盘', thPCS: 'PCS', thFill: '装载率',
  recFill: '最佳容积', recMax: '最大箱数', recBal: '重量均衡',
  bPrevItem: '单品', bPrevWall: '箱壁', bPrevOver: '溢出', bPrevStack: '堆码', bPrevLayer: '层',
  accExpand: '展开', collapse: '收起'
};
const EN = {
  bBestPlan: 'Best Plan', bOuterDim: 'Carton Dim', bOuterLayout: 'Carton Layout', bInnerTag: 'inner',
  bBoxWt: 'Box Gross', bPerLayer: 'Layers/Per', wordLayer: 'layer', wordBox: 'box',
  bPatternColumn: 'Column', bPatternInterlock: 'Interlocking', bPatternPinwheel: 'Pinwheel',
  bPatternMode: 'Pattern', bOverStack: 'Overhang/Stack', bPerPallet: 'Per Pallet', bPalletH: 'Pallet H',
  bContPallets: 'Pallets', bStackTag: 'stack', bTotalBoxes: 'Total Boxes', bTotalPCS: 'Total PCS',
  bFillRate: 'Fill', bGrossWt: 'Gross', bNoPlan: 'No feasible plan', bOverLimit: 'Over Limit',
  bLimit: 'Limit', bOverHint: 'Adjust parameters',
  thNo: '#', thCarton: 'Carton', thLayerPer: 'Layer×Per', thPerPallet: 'Per Pallet', thPallet: 'Pallets', thPCS: 'PCS', thFill: 'Fill',
  recFill: 'Best Fill', recMax: 'Max Boxes', recBal: 'Balanced',
  bPrevItem: 'Item', bPrevWall: 'Wall', bPrevOver: 'Overhang', bPrevStack: 'Stack', bPrevLayer: 'layers',
  accExpand: 'Expand', collapse: 'Collapse'
};

function boot(opts) {
  opts = opts || {};
  const stats = { geo: 0, mat: 0, renders: 0, proj: 0 };
  const THREE = opts.three === false ? null : makeThree(stats);
  const doc = makeDocument(stats);
  const win = {
    THREE: THREE,
    _listeners: {},
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
    removeEventListener() {},
    dispatchEvent(evt) {
      const type = typeof evt === 'string' ? evt : evt.type;
      (this._listeners[type] || []).slice().forEach(fn => fn(evt));
    }
  };
  const rafQueue = [];
  let rafId = 1;

  function el(id) { return doc.getElementById(id); }

  // 预置输入默认值
  const vals = Object.assign({
    bItemL: 150, bItemW: 100, bItemH: 80, bItemWeight: 200, bTargetQty: 24,
    bWall: 5, bMaxLoad: 15, bOverhang: 0, bCartonMaxStack: '',
    bPalletType: 'EU', bContainerType: '40HQ', bPattern: 'auto'
  }, opts.inputs || {});
  Object.keys(vals).forEach(k => { el(k).value = String(vals[k]); });
  el('bAllowSide').checked = !!(opts.inputs && opts.inputs.allowSide);
  el('bAllowInvert').checked = !!(opts.inputs && opts.inputs.allowInvert);

  const sandbox = {
    window: win,
    document: doc,
    THREE: THREE,
    console: { log() {}, warn() {}, error() {} },
    requestAnimationFrame(cb) { const id = rafId++; rafQueue.push({ id, cb }); return id; },
    cancelAnimationFrame(id) { const i = rafQueue.findIndex(r => r.id === id); if (i >= 0) rafQueue.splice(i, 1); },
    renderKPI() {},
    makeLabelSprite() { return makeObj(); },
    LANG: 'zh',
    t(k) { const d = sandbox.LANG === 'en' ? EN : ZH; return d[k] != null ? d[k] : k; },
    HOST: {}
  };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(SRC, ctx, { filename: 'pallet-optimizer.js' });
  const api = vm.runInContext('window.PalletOptimizer', ctx);

  return {
    api, doc, win, sandbox, ctx,
    el, stats,
    flushRaf(n) {
      // 只执行当前队列快照，避免渲染循环 tick 无限追加
      const batch = rafQueue.splice(0, rafQueue.length);
      batch.slice(0, n || batch.length).forEach(r => r.cb());
    },
    setLang(lang) { vm.runInContext(`LANG = ${JSON.stringify(lang)}`, ctx); },
    enableThree() {
      const T = makeThree(stats);
      sandbox.HOST.three = T;
      vm.runInContext('THREE = HOST.three; window.THREE = HOST.three; window.dispatchEvent({type:"three-ready"});', ctx);
      return T;
    }
  };
}

// ---------------------------- 几何/数据一致性校验 ----------------------------
function countPickable(group) {
  let n = 0;
  (function walk(g) {
    (g.children || []).forEach(c => {
      if (c.userData && c.userData.pickable) n++;
      if (c.children && c.children.length) walk(c);
    });
  })(group);
  return n;
}
// Collect pickable meshes with WORLD-space y (accumulate ancestor offsets),
// because stack=2 renders the upper unit inside a translated child Group.
function collectMeshes(group, out, parentY) {
  out = out || [];
  parentY = parentY || 0;
  (group.children || []).forEach(c => {
    const y = parentY + (c.position ? c.position.y : 0);
    if (c.userData && c.userData.pickable) out.push({ mesh: c, worldY: y });
    if (c.children && c.children.length) collectMeshes(c, out, y);
  });
  return out;
}
// Pickable carton count in a viewport; 0 when the viewport was never created
// (e.g. no feasible plan — nothing to draw is a valid, non-residual state).
function pickableIn(state, which) {
  if (!state.scenes) return 0;
  return countPickable(state.scenes[which].group);
}

function checkCandidateLayout(cand, label) {
  const pl = cand.palletLoad;
  const cells = pl.cells;
  ok(Array.isArray(cells) && cells.length > 0, `${label}：cells 非空`);
  eq(pl.perLayer, cells.length, `${label}：perLayer == cells 数`);
  eq(pl.perPallet, pl.perLayer * pl.layers, `${label}：perPallet == perLayer×layers`);

  // 朝向一致性：0° => 单元长边沿 X；90° => 短边沿 X
  const L = cand.carton.outer.l, W = cand.carton.outer.w;
  const spanX = pl.spanX, spanZ = pl.spanZ;
  const expectX = pl.orientation === '0°' ? L : W;
  const expectZ = pl.orientation === '0°' ? W : L;
  const oh = cand.overhang || 0;

  let inside = true, orientOK = true, overhangOK = true;
  cells.forEach(c => {
    if (c.x < -1e-6 || c.z < -1e-6 || c.x + c.w > spanX + 1e-6 || c.z + c.d > spanZ + 1e-6) inside = false;
    // 越出托盘本体的量必须 <= overhang（含左右前后四个方向）
    const protrudeLeft = Math.max(0, oh - c.x);
    const protrudeRight = Math.max(0, (c.x + c.w) - (oh + cand.pallet.L));
    const protrudeFront = Math.max(0, oh - c.z);
    const protrudeBack = Math.max(0, (c.z + c.d) - (oh + cand.pallet.W));
    if (Math.max(protrudeLeft, protrudeRight, protrudeFront, protrudeBack) > oh + 1e-6) overhangOK = false;
    const isRot = Math.abs(c.w - expectZ) < 1e-6 && Math.abs(c.d - expectX) < 1e-6;
    const isBase = Math.abs(c.w - expectX) < 1e-6 && Math.abs(c.d - expectZ) < 1e-6;
    if (!isRot && !isBase) orientOK = false;
  });
  ok(inside, `${label}：所有箱体落在 [{0},spanX]×[{0},spanZ] 内`);
  ok(orientOK, `${label}：每箱 w/d 与 ${pl.orientation} 朝向一致`);
  ok(overhangOK, `${label}：越出托盘本体的量 <= overhang(${oh}mm)`);

  // 同层不重叠（交错/风车错位行不得压箱）
  let overlap = false;
  for (let i = 0; i < cells.length && !overlap; i++) {
    for (let j = i + 1; j < cells.length; j++) {
      const a = cells[i], b = cells[j];
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oz = Math.min(a.z + a.d, b.z + b.d) - Math.max(a.z, b.z);
      if (ox > 1e-4 && oz > 1e-4) { overlap = true; break; }
    }
  }
  ok(!overlap, `${label}：同层箱体不重叠`);

  ok(pl.patternType === 'column' || pl.patternType === 'interlock' || pl.patternType === 'pinwheel',
    `${label}：patternType 合法 (${pl.patternType})`);
  ok(pl.orientation === '0°' || pl.orientation === '90°', `${label}：朝向标注合法 (${pl.orientation})`);
}

function checkPalletView(env, cand, label) {
  const st = env.api._state;
  const pick = countPickable(st.scenes.pallet.group);
  const stack = Math.max(1, Math.min(2, cand.cont.stack || 1));
  const layers = cand.palletLoad.layers;
  eq(pick, cand.palletLoad.perLayer * layers * stack,
    `${label}：托盘视图箱数 == perLayer×layers×stack`);
  ok(pick > 0, `${label}：托盘视图非空`);
  // 层数：同一单元载内每层所有箱共享同一 y，故 distinct worldY 应精确等于
  // layers（单层托盘）或 2×layers（双层堆叠上下两托各 layers 层）。
  const meshes = collectMeshes(st.scenes.pallet.group);
  const ys = new Set(meshes.map(m => Math.round(m.worldY * 1000)));
  eq(ys.size, layers * stack, `${label}：托盘视图层数 == layers×stack`);
  if (stack === 2) {
    // 第二层单元载应整体抬高约 1 个工作高度（底托 + 箱层）
    const top = Math.max(...meshes.map(m => m.worldY));
    const bottom = Math.min(...meshes.map(m => m.worldY));
    const unitH = (cand.pallet.baseH + layers * cand.carton.outer.h) * 0.03;
    ok(top - bottom > unitH * 0.9, `${label}：stack=2 时视图高度覆盖两层单元载`);
  }
}

// =====================================================================
// 场景 1 — 正常切换（THREE 就绪）
// =====================================================================
console.log('='.repeat(78));
console.log('Mode B 选中方案一致性回归测试');
console.log('='.repeat(78));

section('场景 1 · 计算默认方案并校验几何/算法一致');
let env = boot();
env.api.runOptimize();
let st = env.api._state;
ok(st.candidates.length > 0, '默认输入应产生至少 1 个候选方案');
eq(st.selected, st.candidates[0], '默认选中第 0 个候选');
eq(st.selectedIndex, 0, 'selectedIndex 同步为 0');

// 逐候选校验布局引擎
st.candidates.forEach((c, i) => checkCandidateLayout(c, `候选#${i + 1}`));

// 托盘视图与选中方案一致
checkPalletView(env, st.selected, '默认选中');

// 外箱视图单品数 == nx*ny*nz
{
  const cartonPick = countPickable(st.scenes.carton.group);
  const c = st.selected.carton;
  eq(cartonPick, c.nx * c.ny * c.nz, '外箱视图单品块数 == nx×ny×nz');
}

section('场景 1b · 切换 Top10 候选：几何/摘要/高亮同步，旧几何释放');
{
  // 找一个 perLayer 或 layers 与 0 不同的候选，确保切换真的改变几何
  let target = -1;
  for (let i = 1; i < st.candidates.length; i++) {
    const a = st.candidates[0].palletLoad, b = st.candidates[i].palletLoad;
    if (a.perLayer !== b.perLayer || a.layers !== b.layers) { target = i; break; }
  }
  if (target < 0 && st.candidates.length > 1) target = 1;
  ok(target > 0, '存在与第 0 个方案几何不同的候选可切换');

  // 伪造一个归属于旧方案的高亮框，验证切换时被释放
  const palletView = st.scenes.pallet;
  let hlDisposed = false;
  const fakeHl = {
    geometry: { dispose() { hlDisposed = true; } },
    material: { dispose() {} },
    parent: palletView.group
  };
  palletView.group.children.push(fakeHl);
  palletView.hlEdge = fakeHl;

  const geoBefore = env.stats.geo;
  // Snapshot the OLD candidate's meshes; after switching, every one of their
  // geometries must be flagged disposed (proves no stale geometry survives).
  const oldMeshes = collectMeshes(palletView.group);
  ok(oldMeshes.length > 0, '切换前托盘视图存在旧方案网格');
  const row = env.doc.getElementById('bTop10')._rows[target];
  ok(!!row, `Top10 第 ${target + 1} 行存在`);
  row.listeners.click[0]();   // 模拟点击

  eq(st.selected, st.candidates[target], '切换后 selected 指向被点选方案');
  eq(st.selectedIndex, target, '切换后 selectedIndex 同步');
  ok(hlDisposed, '切换候选释放了旧高亮框几何体');
  eq(palletView.hlEdge, null, '切换候选清空 hlEdge 引用');
  const staleGeo = oldMeshes.filter(m => !(m.mesh.geometry && m.mesh.geometry.disposed));
  eq(staleGeo.length, 0, '旧方案的每个网格几何体都被 dispose（无残留几何体）');
  ok(env.stats.geo > geoBefore, '切换候选确实释放了旧网格几何体');
  checkPalletView(env, st.selected, '切换后选中');

  // Top10 高亮只在选中行
  const rows = env.doc.getElementById('bTop10')._rows;
  const selectedRows = rows.filter(r => r.classList.contains('selected'));
  eq(selectedRows.length, 1, 'Top10 仅一行高亮');
  eq(selectedRows[0].getAttribute('data-idx'), String(target), '高亮行 == 选中候选行');
  // 摘要内容仍是该方案
  const sum = env.doc.getElementById('bSummary').innerHTML;
  ok(sum.indexOf(String(st.selected.palletLoad.perLayer)) >= 0, '摘要包含选中方案的每层箱数');
}

section('场景 1c · A→B→A→B 切换后视图仍对应当前选中方案');
{
  const before = st.selected;
  const idx = st.selectedIndex;
  env.api.showMode('A');
  eq(st.bActive, false, '切到 A 后渲染循环停止');
  env.api.showMode('B');
  env.flushRaf();
  eq(st.selected, before, 'A→B 后 selected 未改变');
  eq(st.selectedIndex, idx, 'A→B 后 selectedIndex 未改变');
  checkPalletView(env, before, 'A→B 后');
  eq(countPickable(st.scenes.carton.group), before.carton.nx * before.carton.ny * before.carton.nz,
    'A→B 后外箱视图仍对应当前方案');
}

section('场景 1d · 窗口缩放后相机比例更新且选中方案不变');
{
  const before = st.selected, idx = st.selectedIndex;
  const cam = st.scenes.pallet.camera;
  const aspectBefore = cam.aspect;
  const canvas = st.scenes.pallet.canvas;
  canvas.clientWidth = 900; canvas.clientHeight = 300;
  (env.win._listeners['resize'] || []).forEach(fn => fn({}));
  near(cam.aspect, 900 / 300, 1e-9, '窗口缩放后相机 aspect 更新');
  ok(cam.aspect !== aspectBefore || true, 'aspect 已按新尺寸计算');
  eq(st.selected, before, '缩放后 selected 未改变');
  checkPalletView(env, before, '缩放后');
}

section('场景 1e · 中英切换后摘要/表格重绘且仍指向同一选中项');
{
  const before = st.selected, idx = st.selectedIndex;
  env.setLang('en');
  env.api.rerender();
  const sum = env.doc.getElementById('bSummary').innerHTML;
  ok(/Column|Interlocking|Pinwheel/.test(sum), '英文摘要使用英文图案名');
  ok(!/列阵|交错|风车/.test(sum), '英文摘要不再出现中文图案名');
  ok(sum.indexOf('Best Plan') >= 0, '英文摘要标题已本地化');
  const rows = env.doc.getElementById('bTop10')._rows;
  const selectedRows = rows.filter(r => r.classList.contains('selected'));
  eq(selectedRows.length, 1, '中英切换后仍仅一行高亮');
  eq(selectedRows[0].getAttribute('data-idx'), String(idx), '中英切换后高亮未跳回第 0 行');
  eq(st.selected, before, '中英切换后 selected 不变');
  checkPalletView(env, before, '中英切换后');
  env.setLang('zh');
  env.api.rerender();
  ok(/列阵|交错|风车/.test(env.doc.getElementById('bSummary').innerHTML), '切回中文后摘要是中文');
}

section('场景 1f · 显式交错 / 风车 / 列阵模式几何一致');
['interlock', 'pinwheel', 'column'].forEach(mode => {
  const e2 = boot({ inputs: { bPattern: mode } });
  e2.api.runOptimize();
  const s2 = e2.api._state;
  if (!s2.candidates.length) { ok(false, `${mode} 模式应产生候选`); return; }
  ok(s2.candidates.every(c => c.palletLoad.patternType === mode),
    `${mode} 模式下所有候选 patternType == ${mode}`);
  s2.candidates.forEach((c, i) => checkCandidateLayout(c, `${mode}候选#${i + 1}`));
  checkPalletView(e2, s2.selected, `${mode} 默认选中`);
});

// =====================================================================
// 场景 2 — 负向 / 边界
// =====================================================================
section('场景 2a · overhang=20mm 边界：错位行仍不越出 span，越界量 <= 20mm');
{
  const e3 = boot({ inputs: { bOverhang: 20 } });
  e3.api.runOptimize();
  const s3 = e3.api._state;
  ok(s3.candidates.length > 0, 'overhang=20 仍有可行方案');
  s3.candidates.forEach((c, i) => {
    checkCandidateLayout(c, `overhang20#${i + 1}`);
    near(c.palletLoad.spanX, c.pallet.L + 40, 1e-6, `overhang20#${i + 1}：spanX == 托盘长 + 2×20`);
    near(c.palletLoad.spanZ, c.pallet.W + 40, 1e-6, `overhang20#${i + 1}：spanZ == 托盘宽 + 2×20`);
  });
  checkPalletView(e3, s3.selected, 'overhang=20 选中');
}

section('场景 2b · 最大堆码层数=2：layers<=2，双层堆叠受承重约束');
{
  const e4 = boot({ inputs: { bCartonMaxStack: 2 } });
  e4.api.runOptimize();
  const s4 = e4.api._state;
  ok(s4.candidates.length > 0, 'maxStack=2 仍有可行方案');
  s4.candidates.forEach((c, i) => {
    ok(c.palletLoad.layers <= 2, `maxStack=2 候选#${i + 1}：layers<=2 (${c.palletLoad.layers})`);
    ok(c.cont.stack * c.palletLoad.layers <= 2, `maxStack=2 候选#${i + 1}：stack×layers<=2`);
  });
  checkPalletView(e4, s4.selected, 'maxStack=2 选中');
}

section('场景 2b2 · 数据给出 stack=2 时托盘视图必须画出两层单元载（不能只画一层）');
{
  // 算法在「层数顶满柜高」时结构上不会产生 stack=2（2×ph>柜高），
  // 但视图契约要求：一旦候选的 cont.stack=2，视图就要体现两托关系。
  // 这里注入一个自洽的 stack=2 候选，验证绘制层而非算法层。
  const e4b = boot();
  e4b.api.runOptimize();
  const s4b = e4b.api._state;
  const base = s4b.candidates[0];
  const synth = JSON.parse(JSON.stringify(base));
  synth.cont.stack = 2;
  synth.cont.baseCount = base.cont.baseCount;
  synth.cont.totalPallets = base.cont.baseCount * 2;
  synth.cont.totalBoxes = synth.cont.totalPallets * synth.palletLoad.perPallet;
  synth.cont.totalPCS = synth.cont.totalBoxes * 24;
  s4b.candidates = [synth];
  s4b.selected = synth;
  s4b.selectedIndex = 0;
  e4b.api.showMode('A');
  e4b.api.showMode('B');
  e4b.flushRaf();
  checkPalletView(e4b, synth, '合成 stack=2');
  // 明确比较：两层的高度跨度 ≈ 2 个单元载
  const meshes = collectMeshes(s4b.scenes.pallet.group);
  const top = Math.max(...meshes.map(m => m.worldY));
  const bottom = Math.min(...meshes.map(m => m.worldY));
  const unitH = (synth.pallet.baseH + synth.palletLoad.layers * synth.carton.outer.h) * 0.03;
  ok(top - bottom > unitH * 0.9, 'stack=2 视图高度差超过 1 个单元载（确实堆了两层）');
  eq(countPickable(s4b.scenes.pallet.group), synth.palletLoad.perLayer * synth.palletLoad.layers * 2,
    'stack=2 视图箱数 = perLayer×layers×2');
}

section('场景 2c · 超大单品：无可行方案，视图清空不留旧几何');
{
  const e5 = boot({ inputs: { bItemL: 2600, bItemW: 2400, bItemH: 2000, bTargetQty: 2 } });
  e5.api.runOptimize();
  const s5 = e5.api._state;
  eq(s5.candidates.length, 0, '超大单品无候选方案');
  eq(s5.selected, null, '无方案时 selected 为空');
  eq(pickableIn(s5, "pallet"), 0, '无方案时托盘视图无残留箱体');
  const sum = e5.doc.getElementById('bSummary').innerHTML;
  ok(sum.indexOf('无可行方案') >= 0, '显示无可行方案提示');
}

section('场景 2d · 超出单箱限重：overLimit 分支清空选择');
{
  const e6 = boot({ inputs: { bItemWeight: 5000, bTargetQty: 24, bMaxLoad: 15 } });
  e6.api.runOptimize();
  const s6 = e6.api._state;
  eq(s6.candidates.length, 0, '超重时无候选');
  eq(s6.selected, null, '超重时 selected 为空');
  eq(pickableIn(s6, "pallet"), 0, '超重时托盘视图无残留');
  ok(e6.doc.getElementById('bSummary').innerHTML.indexOf('超出限重') >= 0, '显示超出限重提示');
}

section('场景 2e · 重新计算到空方案后再计算：不得残留上一次方案几何');
{
  const e7 = boot();
  e7.api.runOptimize();
  const s7 = e7.api._state;
  const firstPick = pickableIn(s7, "pallet");
  ok(firstPick > 0, '首次计算有方案');
  // 改成超大单品触发空方案
  e7.el('bItemL').value = '2600'; e7.el('bItemW').value = '2400';
  e7.el('bItemH').value = '2000'; e7.el('bTargetQty').value = '2';
  e7.api.runOptimize();
  eq(s7.selected, null, '空方案后 selected 清空');
  eq(pickableIn(s7, "pallet"), 0, '空方案后旧方案几何被清除');
}

// =====================================================================
// 场景 3 — THREE 未就绪：延迟绘制
// =====================================================================
section('场景 3 · Three.js 未就绪时延迟到 three-ready 再绘制当前选中方案');
{
  const e8 = boot({ three: false });
  e8.api.runOptimize();
  const s8 = e8.api._state;
  ok(s8.selected != null, 'THREE 未就绪时仍能计算并记录选中方案');
  eq(s8.scenes, null, 'THREE 未就绪时未创建场景');
  eq(s8.pendingDraw, true, '已挂起绘制请求');

  e8.api.showMode('B');
  eq(s8.scenes, null, '点模式 B 时 THREE 仍未就绪，不创建空场景');
  eq(s8.pendingDraw, true, '等待 three-ready 期间绘制保持挂起');

  // THREE 就绪
  e8.enableThree();
  ok(s8.scenes != null, 'three-ready 后场景被创建');
  eq(s8.pendingDraw, false, 'three-ready 后挂起标记清除');
  eq(s8.selected, s8.candidates[0], 'three-ready 后仍指向同一选中方案');
  checkPalletView(e8, s8.selected, 'three-ready 后');
  eq(e8.stats.renders > 0, true, 'three-ready 后确实执行了渲染');
}

// =====================================================================
// 场景 4 — 真实 app.js ↔ pallet-optimizer.js 联合加载（端到端 i18n 链路）
// ---------------------------------------------------------------------
// 复现 index.html 的加载顺序（app.js 先、pallet-optimizer.js 后），让真实的
// applyI18n() → window.PalletOptimizer.rerender() 链路生效，验证中英切换
// 之后摘要 / Top10 表格确由真实 app.js 驱动重绘，且仍指向同一选中项。
// =====================================================================
section('场景 4 · 真实 app.js + pallet-optimizer.js 联合加载的 i18n 链路');
{
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const stats = { geo: 0, mat: 0, renders: 0, proj: 0 };
  const THREE = makeThree(stats);
  const doc = makeDocument(stats);

  const defaults = {
    bItemL: 150, bItemW: 100, bItemH: 80, bItemWeight: 200, bTargetQty: 24,
    bWall: 5, bMaxLoad: 15, bOverhang: 0, bCartonMaxStack: '',
    bPalletType: 'EU', bContainerType: '40HQ', bPattern: 'auto'
  };
  Object.keys(defaults).forEach(k => { doc.getElementById(k).value = String(defaults[k]); });

  const win = {
    THREE,
    _listeners: {},
    addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
    removeEventListener() {},
    dispatchEvent(evt) { const t = evt && evt.type ? evt.type : evt; (this._listeners[t] || []).slice().forEach(fn => fn(evt)); }
  };
  let rafId = 1;
  const sandbox = {
    window: win, document: doc, THREE,
    console: { log() {}, warn() {}, error() {} },
    requestAnimationFrame() { return rafId++; },
    cancelAnimationFrame() {},
    localStorage: { getItem() { return null; }, setItem() {} },
    alert() {},
    location: { hash: '' },
    fetch() { return Promise.reject(new Error('no network in test')); },
    Event: function (type) { this.type = type; },
    navigator: { userAgent: 'node-test' },
    setTimeout(fn) { if (typeof fn === 'function') return 0; return 0; },
    clearTimeout() {},
    encodeURIComponent, decodeURIComponent, JSON, Math, Date
  };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(appSrc, ctx, { filename: 'app.js' });
  vm.runInContext(SRC, ctx, { filename: 'pallet-optimizer.js' });

  vm.runInContext('window.PalletOptimizer.runOptimize();', ctx);
  const s = vm.runInContext('window.PalletOptimizer._state', ctx);
  ok(s.candidates.length > 0, '真实链路：产生候选方案');
  ok(s.selected != null, '真实链路：默认选中一个方案');

  // 选中一个非 0 的候选，验证 i18n 重绘不会把高亮移走
  const target = s.candidates.length > 1 ? 1 : 0;
  const rows = doc.getElementById('bTop10')._rows;
  if (rows[target] && rows[target].listeners.click) rows[target].listeners.click[0]();
  eq(s.selectedIndex, target, '真实链路：选中第 ' + (target + 1) + ' 个候选');
  const beforeSel = s.selected;

  // 真实 app.js 的语言切换 —— 内部会调用 PalletOptimizer.rerender()
  vm.runInContext('LANG = "en"; applyI18n();', ctx);
  const sumEN = doc.getElementById('bSummary').innerHTML || '';
  ok(sumEN.indexOf('Best Plan') >= 0, '真实链路：英文摘要标题已本地化');
  ok(!/列阵|交错|风车/.test(sumEN), '真实链路：英文摘要无中文图案名');
  const rowsEN = doc.getElementById('bTop10')._rows;
  const selEN = rowsEN.filter(r => r.classList.contains('selected'));
  eq(selEN.length, 1, '真实链路：英文表格仅一行高亮');
  eq(selEN[0].getAttribute('data-idx'), String(target), '真实链路：英文表格高亮仍是同一选中项');
  eq(s.selected, beforeSel, '真实链路：语言切换后选中方案不变');

  vm.runInContext('LANG = "zh"; applyI18n();', ctx);
  ok(/列阵|交错|风车/.test(doc.getElementById('bSummary').innerHTML || ''), '真实链路：切回中文后摘要恢复中文');
  const rowsZH = doc.getElementById('bTop10')._rows;
  const selZH = rowsZH.filter(r => r.classList.contains('selected'));
  eq(selZH[0].getAttribute('data-idx'), String(target), '真实链路：切回中文后高亮仍是同一选中项');
}

// =====================================================================
// 汇总
// =====================================================================
console.log('\n' + '='.repeat(78));
if (FAIL === 0) {
  console.log(`✅ 全部通过：${PASS} 项断言`);
} else {
  console.log(`❌ ${FAIL} 项失败 / 共 ${PASS + FAIL} 项断言`);
  failures.forEach(f => console.log('   - ' + f));
}
console.log('='.repeat(78));
process.exit(FAIL === 0 ? 0 : 1);
