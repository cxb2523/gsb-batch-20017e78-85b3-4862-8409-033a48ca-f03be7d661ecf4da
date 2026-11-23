/* =====================================================================
 * wrpl-worker.js —— 把 .wrpl 解析放到 Web Worker 里，主线程只收结果
 * ---------------------------------------------------------------------
 * 主线程（wrpl-parse.js 的 parseInWorker）发来的消息：
 *   { cmd: 'ready' }                      → 回 { type: 'ready' }
 *   { cmd: 'parse', buf, fileName, ... }  → 回若干 { type: 'progress' | 'part' | 'debug' }
 *                                           最后 { type: 'done', parts } 或 { type: 'error' }
 * `buf` 是 **Transferable**（主线程 postMessage 时转交所有权）：
 * 主线程那边这个 ArrayBuffer 立刻 detached，主线程堆不背这份数据。
 *
 * 本文件与本目录的 fzstd / wrpl-parse.js 用 importScripts 加载（本机文件，不联网）。
 * 解析结束后主动清引用（大数组置 null 并触发一次 GC 友好的空转），
 * 主线程收到 done 后会 terminate()，整个 isolate 一起回收。
 * ===================================================================== */
'use strict';

importScripts('vendor/fzstd.min.js', 'ecs-comps.js', 'ecs-names.js', 'wrpl-parse.js');

/* 堆占用采样：**只在进度回调时采样**，峰值随进度一起上报。
 * 取不到 performance.memory 时返回 null（不是 0）——0 会被读成"堆占用 0 MB"这一事实陈述。 */
var peakHeapBytes = null;          // 仅由进度回调更新
var peakReportedMB = null;         // 最后一次进度上报过的峰值，done 原样回传
var progressClosed = false;        // 解析结束（progress phase='done'）后冻结峰值

function heapNow() {
  try {
    var mem = self.performance && self.performance.memory;
    var v = mem ? mem.usedJSHeapSize : null;
    return (typeof v === 'number' && isFinite(v) && v > 0) ? v : null;
  } catch (e) { return null; }
}

/** 字节 → MB，保留 1 位；null 保持 null。进度与 done 用同一套取整，保证两边数值可比。 */
function mbOf(bytes) { return bytes === null ? null : Math.round(bytes / 1048576 * 10) / 10; }

function sampleHeap() {
  var h = heapNow();
  if (h !== null && (peakHeapBytes === null || h > peakHeapBytes)) peakHeapBytes = h;
  return h;
}

WRPLParse.progress(function (p) {
  // 解析收尾后不再采样：后续分片 postMessage 引起的堆增长不能改写已经上报过的峰值，
  // 否则 done 的峰值可能比中途报过的小（或大），两个数对不上。
  var h = progressClosed ? null : sampleHeap();
  peakReportedMB = mbOf(peakHeapBytes);
  self.postMessage({ type: 'progress', phase: p.phase, pct: p.pct, note: p.note || '',
                     workerHeapMB: mbOf(h), workerHeapPeakMB: peakReportedMB });
  if (p.phase === 'done') progressClosed = true;
});

/** 单条 units 消息的数值上限（一个单位里所有数值列的元素总数）。 */
var UNITS_CHUNK_MAX_VALS = 120000;
var sliceSeq = 0;                 // 跨解析递增的切片组号：主线程按它把切片拼回单位

/** 一个 units 条目里**真实数值通道**：所有数组型字段（x/y/z/hdg，以及 playerCandidates
 *  之类的附加数组），各按自己的长度算。
 *  不用「长度 × 固定列数」粗估：不同单位的通道集合并不一样（静态点只有 1 个采样，
 *  空中航迹有 x/y/z/hdg 四列），粗估会让单条消息超出上限或切得过碎。 */
function unitChannels(u) {
  var keys = [];
  if (!u) return keys;
  Object.keys(u).forEach(function (k) {
    if (k !== '__slice' && Array.isArray(u[k])) keys.push(k);
  });
  return keys;
}
function unitValueCount(u) {
  return unitChannels(u).reduce(function (n, k) { return n + u[k].length; }, 0);
}

/** 单个单位自身就超过上限时：把它的数值列**按顺序切片**，每片 ≤ maxVals。
 *  切片带 __slice = { gid, i, n, key }；主线程按 gid 拼回原单位（数组顺序不变）。
 *  没有这条路径的话，一个超大单位会独占一条超限消息。 */
function splitUnit(u, maxVals) {
  var keys = unitChannels(u), pos = {}, slices = [];
  keys.forEach(function (k) { pos[k] = 0; });
  while (true) {
    var remain = keys.reduce(function (n, k) { return n + (u[k].length - pos[k]); }, 0);
    if (!remain) break;
    var budget = maxVals, piece = {};
    for (var i = 0; i < keys.length && budget > 0; i++) {
      var k = keys[i], avail = u[k].length - pos[k];
      if (avail <= 0) continue;
      var take = Math.min(avail, budget);
      piece[k] = u[k].slice(pos[k], pos[k] + take);
      pos[k] += take; budget -= take;
    }
    slices.push(piece);
  }
  var gid = ++sliceSeq;
  return slices.map(function (piece, idx) {
    var o = {};
    Object.keys(u).forEach(function (k) {
      if (keys.indexOf(k) < 0 && k !== '__slice') o[k] = u[k];   // 元信息（key/uid/…）每片都带
    });
    keys.forEach(function (k) { o[k] = piece[k] || []; });
    o.__slice = { gid: gid, i: idx, n: slices.length, key: String(u.key) };
    return o;
  });
}

/** 按真实数值个数把 units 切成若干条消息，单条不超过 maxVals。
 *  单位是**原子**的：按原顺序整条放进某一分片，不拆、不重排、不丢；
 *  单位自身超限时才切片（每片仍 ≤ maxVals），由主线程拼回。 */
function chunkUnits(units, maxVals) {
  var out = [], cur = [], curVals = 0;
  function flush() { if (cur.length) { out.push(cur); cur = []; curVals = 0; } }
  units.forEach(function (u) {
    var v = unitValueCount(u);
    if (v > maxVals) {
      flush();
      splitUnit(u, maxVals).forEach(function (s) { out.push([s]); });
      return;
    }
    if (cur.length && curVals + v > maxVals) flush();
    cur.push(u); curVals += v;
    if (curVals >= maxVals) flush();
  });
  flush();
  return out;
}

function sendOwn(own) {
  // 本机 17 个通道 × 5589 → 拆 4 条，单条 clone 不至于太长
  var groups = [['t0', 'hz', 'n'], ['x', 'y', 'z'], ['ias', 'tas', 'mach', 'hdg'],
                ['roll', 'pitch', 'g', 'aoa', 'ammo', 'fuel', 'vy', 'throttle']];
  groups.forEach(function (keys) {
    var part = {};
    keys.forEach(function (k) { part[k] = own[k]; });
    self.postMessage({ type: 'part', key: 'own', data: part });
  });
}

function sendMission(mission, wantDebug, dbg, timings) {
  var parts = 0, i;
  self.postMessage({ type: 'part', key: 'meta', data: mission.meta }); parts++;
  sendOwn(mission.own); parts += 4;
  var chunks = chunkUnits(mission.units || [], UNITS_CHUNK_MAX_VALS);
  for (i = 0; i < chunks.length; i++) {
    self.postMessage({ type: 'part', key: 'units', data: chunks[i] });
    parts++;
  }
  ['events', 'shots', 'runways', 'airfields', 'missiles'].forEach(function (k) {
    self.postMessage({ type: 'part', key: k, data: mission[k] }); parts++;
  });
  /* 飘带用的横滚序列（可能上百 KB）：按 uid 分片发，避免单条 structured clone 太长 */
  var att = mission.__attitude;
  if (att && att.units) {
    var uids = Object.keys(att.units), buf = {}, cnt = 0;
    var head = { note: att.note, secPerTick: att.secPerTick, tick0: att.tick0, dt: att.dt };
    uids.forEach(function (uid, i) {
      buf[uid] = att.units[uid];
      cnt++;
      if (cnt >= 8 || i === uids.length - 1) {
        var data = {};
        Object.keys(head).forEach(function (k) { data[k] = head[k]; });
        data.units = buf;
        self.postMessage({ type: 'part', key: '__attitude', data: data });
        parts++;
        buf = {}; cnt = 0;
      }
    });
  }
  self.postMessage({ type: 'part', key: 'terrain', data: mission.terrain }); parts++;
  self.postMessage({ type: 'part', key: 'names', data: mission.names }); parts++;
  if (wantDebug && dbg) self.postMessage({ type: 'debug', data: dbg });
  self.postMessage({ type: 'done', parts: parts,
                     timing: { parseMs: timings ? timings.parseMs : null,
                               sendMs: timings && timings.tParsed ? (Date.now() - timings.tParsed) : null },
                     /* 峰值原样回传**过程中最后一次上报过的值**（progress 里已经冻结）；
                        不在这里重新采样：分片 postMessage 之后堆还会涨，重新采会让 done
                        的峰值大于中途上报的峰值，两边对不上。
                        worker 里 performance.memory 往往取不到：取不到就是 null，不是 0。 */
                     workerHeapPeakMB: peakReportedMB });
}

self.onmessage = function (ev) {
  var msg = ev.data || {};
  if (msg.cmd === 'ready') {
    self.postMessage({ type: 'ready', hasFzstd: !!(self.fzstd && self.fzstd.decompress) });
    return;
  }
  if (msg.cmd !== 'parse') return;
  /* 每条 parse 指令都从空开始：峰值与"已冻结"标记不能跨解析残留 */
  peakHeapBytes = null;
  peakReportedMB = null;
  progressClosed = false;
  var dbg = msg.wantDebug ? {} : null;
  var opts = { fileName: msg.fileName, yieldEvery: msg.yieldEvery };
  if (dbg) opts.debug = dbg;
  /* 调 parseMain（原始解析）而不是公开的 parse：
   * 公开 parse 会把 __attitude 摘下来挂到 window.ACE_ATTITUDE，而 worker 里没有 window，
   * 结果就再也发不回主线程了（主线程那边 ACE_ATTITUDE 会是 0 个 uid）。 */
  var runner = (WRPLParse._internal && WRPLParse._internal.parseMain) || WRPLParse.parse;
  var tStart = Date.now();
  runner(msg.buf, opts).then(function (mission) {
    var tParsed = Date.now();
    /* 计时随 done 一起回（done 一到主线程就 resolve，单独发的 timing 会晚到、读不到） */
    sendMission(mission, msg.wantDebug, dbg, { parseMs: tParsed - tStart, tParsed: tParsed });
    // 主动清引用：大数组不再被 worker 持有（随后主线程会 terminate 整个 isolate）
    mission = null;
    if (dbg) dbg = null;
    self.setTimeout && self.setTimeout(function () {}, 0);
  }).catch(function (e) {
    self.postMessage({ type: 'error', message: String(e && e.message ? e.message : e),
                       code: e && e.code ? e.code : null, tech: e && e.tech ? e.tech : null,
                       fromWorkerParse: true });
  });
};
