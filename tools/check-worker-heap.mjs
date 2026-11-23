#!/usr/bin/env node
/* Worker 进度/内存峰值与 units 分片自检。
 *
 * 用法：node tools/check-worker-heap.mjs
 *
 * 把 web/wrpl-worker.js 放进 vm 里跑（importScripts / WRPLParse 用可注入的桩），
 * 用**注入的假数据**验证：
 *   1. 分片按每个单位真实通道数（x/y/z/hdg 数组元素数）计算，单条不超过上限；
 *   2. 分片后所有单位完整、顺序与原始一致、不重不丢（含正好跨越上限的边界）；
 *   3. 每次 progress 都带当前堆占用与峰值（MB），峰值单调不减；
 *   4. done 的峰值 == 过程中最后上报过的峰值（分片发送导致的堆增长不能改写它）；
 *   5. 取不到 performance.memory 时当前值与峰值都是 null（不是 0）；
 *   6. 解析失败时只回 error、不回 done；下一次解析的峰值不累计上一次的。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const require = createRequire(import.meta.url);

/* 主线程侧的切片拼回逻辑在 wrpl-parse.js 里（真实实现，不复制一份） */
const fz = require(join(repo, 'web', 'vendor', 'fzstd.min.js'));
globalThis.fzstd = fz;
require(join(repo, 'web', 'wrpl-parse.js'));
const mergeUnitSlices = globalThis.WRPLParse._internal.mergeUnitSlices;

const workerSrc = readFileSync(join(repo, 'web', 'wrpl-worker.js'), 'utf8') +
  '\n;globalThis.__workerTest = { chunkUnits: chunkUnits, unitValueCount: unitValueCount, mbOf: mbOf };';

let failures = 0;
function check(ok, msg, detail) {
  if (ok) { console.log('ok   ' + msg); }
  else { failures++; console.error('FAIL ' + msg + (detail ? ' — ' + detail : '')); }
}

/** 造一个单位：x/y/z/hdg 各有 n 个元素（hdg 允许为 null 占位，但仍算真实通道元素）。 */
function mkUnit(i, n) {
  const x = [], y = [], z = [], hdg = [];
  for (let k = 0; k < n; k++) { x.push(i * 1000 + k); y.push(k); z.push(100 + k); hdg.push(k % 360); }
  return { key: 'u' + i, x, y, z, hdg };
}
function valsOf(u) { return u.x.length + u.y.length + u.z.length + u.hdg.length; }

/** 用主线程的真实拼回实现把切片还原，再与原始单位逐数值比较。 */
function mergeSlices(parts, original) {
  if (!mergeUnitSlices) return { ok: false, eq: false, why: 'mergeUnitSlices 未导出' };
  const rebuilt = mergeUnitSlices(parts.slice());
  if (rebuilt.length !== 1) return { ok: false, eq: false, why: '拼回得到 ' + rebuilt.length + ' 个' };
  const r = rebuilt[0];
  for (const k of ['x', 'y', 'z', 'hdg']) {
    if (r[k].length !== original[k].length) {
      return { ok: false, eq: false, why: k + ' 长度 ' + r[k].length + ' ≠ ' + original[k].length };
    }
    for (let i = 0; i < r[k].length; i++) {
      if (r[k][i] !== original[k][i]) {
        return { ok: false, eq: false, why: k + '[' + i + '] ' + r[k][i] + ' ≠ ' + original[k][i] };
      }
    }
  }
  return { ok: true, eq: true, why: '' };
}

const EMPTY_OWN = { t0: [], hz: 10, n: 0, x: [], y: [], z: [], ias: [], tas: [], mach: [], hdg: [],
  roll: [], pitch: [], g: [], aoa: [], ammo: [], fuel: [], vy: [], throttle: [] };
function missionWith(units) {
  return { meta: { limits: [], provenance: [] }, own: EMPTY_OWN, units,
           events: null, shots: null, runways: null, airfields: null, missiles: [],
           terrain: null, names: {}, __attitude: null };
}

/** 在 vm 里加载 worker；parseImpl(env) 返回 Promise<mission>（解析阶段的桩）。 */
function loadWorker(opts = {}) {
  const messages = [];
  const heap = { bytes: opts.heapStart === undefined ? null : opts.heapStart };
  let progressCb = null;
  const self = {
    postMessage(m) { messages.push(m); },
    performance: opts.noMemory ? {} : {
      get memory() { return heap.bytes === null ? undefined : { usedJSHeapSize: heap.bytes }; }
    },
    setTimeout
  };
  const WRPLParse = {
    progress(cb) { progressCb = cb; },
    _internal: { parseMain() { return opts.parseImpl({ emit, heap, messages }); } }
  };
  function emit(phase, pct, note) { if (progressCb) progressCb({ phase, pct, note }); }
  const context = vm.createContext({
    self, WRPLParse, console, setTimeout, Promise,
    importScripts() {},                     /* worker 里由浏览器加载；单测用桩 */
    Date, Math, JSON, Object, Array, Number, String, isFinite, Uint8Array
  });
  vm.runInContext(workerSrc, context, { filename: 'wrpl-worker.js' });
  const run = (buf) => { context.self.onmessage({ data: { cmd: 'parse', buf } }); };
  return { messages, heap, run, emit, t: context.__workerTest };
}

function settle() { return new Promise(r => setTimeout(r, 30)); }
const MB = 1048576;

/* ---------------------------------------------------------------- 1. 分片 */
function chunkTests() {
  const w = loadWorker();
  const { chunkUnits, unitValueCount } = w.t;
  check(unitValueCount(mkUnit(0, 5)) === 20, 'unitValueCount = x/y/z/hdg 各数组长度之和（5 点 → 20）');
  check(unitValueCount({ x: [1], y: [1], z: [1], hdg: [null] }) === 4,
        'null 占位也算真实通道元素（静态点 hdg:[null] 仍是 4 个数值）');

  /* 边界：3 个单位各 8 个数值，max=20 → 恰好 2 个一片，第三个新起一片。
   * 旧实现按「长度×5」估成 8×5=40，会切得比实际细；这里证明按真实通道数切。 */
  const u1 = { key: 'a', x: [1, 2], y: [1, 2], z: [1, 2], hdg: [null, null] }; // 8
  const u2 = { key: 'b', x: [1, 2], y: [1, 2], z: [1, 2], hdg: [null, null] }; // 8
  const u3 = { key: 'c', x: [1, 2], y: [1, 2], z: [1, 2], hdg: [null, null] }; // 8
  const chunks20 = chunkUnits([u1, u2, u3], 20);
  check(chunks20.length === 2 && chunks20[0].length === 2 && chunks20[1].length === 1,
        '边界：max=20 时 8+8+8 切成 [2,1]', JSON.stringify(chunks20.map(c => c.length)));
  check(chunks20.every(c => c.reduce((n, u) => n + unitValueCount(u), 0) <= 20),
        '边界：每片数值数不超过 max=20');
  /* 跨越上限：max=16（正好等于 8+8）能装两片；max=15（差 1）每个单独一片 */
  const c16 = chunkUnits([u1, u2, u3], 16);
  check(c16.length === 2 && c16[0].length === 2 && c16[1].length === 1,
        '边界：max=16（正好等于 8+8）仍能装下两片');
  const c15 = chunkUnits([u1, u2, u3], 15);
  check(c15.length === 3 && c15.every(c => c.length === 1),
        '边界：max=15（差 1）时每个单位单独一片');

  /* 单个超限：切片发送（每片仍 ≤ 上限），主线程按 __slice 拼回一个完整单位 */
  const big = mkUnit(99, 100);   // 400 个数值
  const cBig = chunkUnits([u1, big, u3], 20);
  const bigParts = cBig.map(c => c[0]).filter(p => p && p.__slice);
  check(bigParts.length >= 20, '单个单位超过上限：切成多片发送（400 数值 / 上限 20）',
        String(bigParts.length));
  check(cBig.every(c => c.every(p => valsOf(p) <= 20)),
        '单个单位超限：每片数值数仍不超过上限');
  check(cBig[0][0] === u1 && cBig[cBig.length - 1][0] === u3,
        '个别单位超限不影响邻居的顺序');
  {
    const merged = mergeSlices(bigParts, big);
    check(merged.ok && merged.eq,
          '拼回后与原始单位逐数值相等（x/y/z/hdg 顺序一致、长度不变）', merged.why);
  }

  /* 混合：普通单位 + 超限单位 + 普通单位，拼回后整体顺序不变 */
  {
    const normalA = mkUnit(1, 3), normalB = mkUnit(2, 3), huge = mkUnit(3, 300);
    const parts = chunkUnits([normalA, huge, normalB], 40).flat();
    const rebuilt = mergeUnitSlices ? mergeUnitSlices(parts) : null;
    const hugeMerged = rebuilt && rebuilt.filter(u => u.key === huge.key);
    check(hugeMerged && hugeMerged.length === 1, '超限单位在拼回结果里恰好出现一次');
    if (hugeMerged && hugeMerged.length === 1) {
      const merged = mergeSlices([hugeMerged[0]], huge);
      check(merged.ok && merged.eq, '超限单位拼回后逐数值相等', merged.why);
    }
    if (rebuilt) {
      check(rebuilt.length === 3 && rebuilt[0].key === normalA.key &&
            rebuilt[1].key === huge.key && rebuilt[2].key === normalB.key,
            '拼回后整体顺序与原始 units 一致', rebuilt.map(u => u.key));
      check(!('__slice' in rebuilt[1]), '拼回后的单位不带内部切片标记');
    }
  }

  /* 完整性 + 顺序 + 不重不丢 */
  const many = [];
  for (let i = 0; i < 500; i++) many.push(mkUnit(i, 1 + (i % 17)));
  const maxVals = 300;
  const cut = chunkUnits(many, maxVals);
  const flat = cut.flat();
  check(flat.length === many.length, '分片后单位总数不变（' + many.length + '）');
  check(flat.every((u, i) => u === many[i]), '分片后单位顺序与原始一致、无重复对象');
  const over = cut.filter(c => c.reduce((n, u) => n + unitValueCount(u), 0) > maxVals);
  check(over.length === 0 || over.every(c => c.length === 1 && unitValueCount(c[0]) > maxVals),
        '除「单个单位自身超限」外，单条 units 消息不超上限');

  /* 真实上限 120000：一个单位正好装满一片，下一个单位另起一片 */
  const exact = mkUnit(0, 120000 / 4);
  const ex = chunkUnits([exact, mkUnit(1, 1)], 120000);
  check(ex.length === 2 && ex[0].length === 1 && ex[1].length === 1,
        '真实上限 120000：正好装满一片后，下个单位另起一片');
  check(valsOf(ex[0][0]) === 120000, '真实上限 120000：该片数值数恰好等于上限');
}

/* ------------------------------------------- 2. 峰值随进度、done 与之一致 */
async function heapProgressTests() {
  /* 解析期堆占用先涨后跌再涨；解析结束（done 阶段）后分片发送期间又涨到 500 MB。 */
  const series = [10, 40, 25, 90, 60];
  const w = loadWorker({
    heapStart: series[0] * MB,
    parseImpl({ emit, heap }) {
      for (let i = 0; i < series.length; i++) {
        heap.bytes = series[i] * MB;
        emit('fm', 20 + i * 10, 'stage ' + i);
      }
      emit('done', 100, '完成');        // 解析收尾：随后的分片发送不在解析阶段
      return Promise.resolve(missionWith([mkUnit(0, 3), mkUnit(1, 3)]));
    }
  });
  /* 分片发送在 Promise.then 里发生：发送阶段堆涨到 500 MB；
   * 但 worker 在 'done' 进度之后不再采样，不能把 500 写进峰值。 */
  const realPost = w.messages.push.bind(w.messages);
  w.messages.push = function (m) {
    if (m.type === 'part') { w.heap.bytes = 500 * MB; }
    return realPost(m);
  };
  w.run(new ArrayBuffer(8));
  await settle();

  const progresses = w.messages.filter(m => m.type === 'progress');
  const done = w.messages.find(m => m.type === 'done');
  check(progresses.length === series.length + 1, 'progress 条数 = 解析阶段数 + done 阶段');
  check(progresses.every(m => 'workerHeapMB' in m && 'workerHeapPeakMB' in m),
        '每条 progress 都带当前堆占用与峰值');
  const peaks = progresses.map(m => m.workerHeapPeakMB);
  check(peaks.every((v, i) => i === 0 || v >= peaks[i - 1]), 'progress 峰值单调不减', JSON.stringify(peaks));
  check(peaks[peaks.length - 1] === 90,
        '峰值 = 过程中观察到的最大值（90 MB，不含发送阶段的 500）', String(peaks[peaks.length - 1]));
  check(progresses[2].workerHeapMB === 25 && progresses[2].workerHeapPeakMB === 40,
        '当前值可回落，但峰值保持最大（第 3 次：当前 25 / 峰值 40）',
        JSON.stringify(progresses[2]));
  check(done && done.workerHeapPeakMB === peaks[peaks.length - 1],
        'done 峰值 == 过程中最后上报的峰值（发送阶段堆增长不影响它）',
        done && String(done.workerHeapPeakMB));
  check(done && done.workerHeapPeakMB >= Math.max(...peaks),
        'done 峰值不小于任何中途上报的峰值');
  check(progresses.every(m => m.workerHeapMB === null || m.workerHeapMB > 0),
        '当前堆占用要么是正数、要么是 null（从不伪造成 0）');
  check(w.messages.filter(m => m.type === 'part' && m.key === 'units').length === 1,
        'units 分片仍然全部送达（本例 2 个单位按真实数值数装进 1 片）');
}

/* --------------------------------------------------- 3. 取不到内存 → null */
async function noMemoryTests() {
  const w = loadWorker({
    noMemory: true,
    parseImpl({ emit }) {
      emit('fm', 20, 'x'); emit('done', 100, '完成');
      return Promise.resolve(missionWith([]));
    }
  });
  w.run(new ArrayBuffer(8));
  await settle();
  const progresses = w.messages.filter(m => m.type === 'progress');
  const done = w.messages.find(m => m.type === 'done');
  check(progresses.every(m => m.workerHeapMB === null && m.workerHeapPeakMB === null),
        '取不到 performance.memory：progress 的当前值与峰值都是 null');
  check(done && done.workerHeapPeakMB === null, '取不到时 done 峰值是 null（不是 0）');
}

/* ------------------------------------------------------- 4. 失败与重置 */
async function failureAndResetTests() {
  let call = 0;
  const w = loadWorker({
    heapStart: 50 * MB,
    parseImpl({ emit, heap }) {
      call++;
      if (call === 1) {
        heap.bytes = 80 * MB;
        emit('fm', 20, '解析到一半');
        return Promise.reject(new Error('bad replay'));
      }
      heap.bytes = 30 * MB;
      emit('fm', 20, '第二次');
      emit('done', 100, '完成');
      return Promise.resolve(missionWith([]));
    }
  });
  w.run(new ArrayBuffer(8));
  await settle();
  const first = w.messages.slice();
  const err = first.find(m => m.type === 'error');
  check(!!err && err.message === 'bad replay', '解析失败：只回 error（带原始 message）');
  check(!first.some(m => m.type === 'done'), '解析失败：不回 done（没有"完成"假象）');

  w.messages.length = 0;
  w.run(new ArrayBuffer(8));
  await settle();
  const second = w.messages.slice();
  const progresses = second.filter(m => m.type === 'progress');
  const done = second.find(m => m.type === 'done');
  check(progresses.length > 0 && progresses[0].workerHeapPeakMB === 30,
        '下一次解析的峰值从空开始（不累计上一次的 80 MB）',
        progresses[0] && String(progresses[0].workerHeapPeakMB));
  check(done && done.workerHeapPeakMB === 30, '第二次解析 done 峰值 = 本次最大值');
}

async function main() {
  chunkTests();
  await heapProgressTests();
  await noMemoryTests();
  await failureAndResetTests();
  if (failures) { console.error('\n失败 ' + failures + ' 项'); process.exit(1); }
  console.log('\nWorker 进度/峰值与 units 分片自检通过');
}

main().catch((e) => { console.error(e); process.exit(1); });
