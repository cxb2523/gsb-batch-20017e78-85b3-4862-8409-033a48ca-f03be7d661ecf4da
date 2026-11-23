#!/usr/bin/env python
"""浏览器端到端自检：解析页的内存读数与 units 分片（可选，需 Playwright）。

    pip install playwright && playwright install chromium
    python tools/check-worker-heap-browser.py

`tools/check-worker-heap.mjs` 已覆盖 worker 协议本身（Node + vm，CI 必跑）。
这边补的是 **真浏览器里** 的三条路径（任务验收要求的正常 / 边界 / 失败）：

  * 正常解析：progress 带当前/峰值，页面解析中就显示，done 后保留最终峰值；
  * 边界：单位数值正好等于上限（装满一片）+ 超限单位（切片发送、主线程拼回）；
  * 解析失败：错误态显示原因，进行中的当前值/峰值被清空，下一次解析不残留；
  * 主线程回退：没有 worker 读数时 UI 显示"不可用"，meta 键仍为 null。

做法：拦截 `wrpl-worker.js`，把桩注入到真实 worker 脚本尾部 —— 页面、主线程合并逻辑、
UI 全是真代码，只有「解析耗时/结果/堆序列」是注入的假数据。Worker 里 Chromium 不暴露
`performance.memory`，所以假堆序列用 defineProperty 装上去，才能验证 MB 显示。
"""
import base64
import json
import os
import subprocess
import sys
import time

try:
    from playwright.sync_api import sync_playwright
except ImportError:  # pragma: no cover - 环境没装就跳过
    print('跳过：未安装 playwright（pip install playwright && playwright install chromium）')
    sys.exit(0)

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORKER_JS = os.path.join(REPO, 'web', 'wrpl-worker.js')
PORT = int(os.environ.get('WRPL_VERIFY_PORT', '8161'))
BASE = 'http://127.0.0.1:%d' % PORT

failures = []


def check(ok, msg, detail=''):
    if ok:
        print('ok   ' + msg)
    else:
        failures.append(msg)
        print('FAIL ' + msg + (('  — ' + str(detail)) if detail != '' else ''))


HARNESS = r"""
;(function () {
  /* 仅验证用：Chromium 的 Worker 里没有 performance.memory，这里装一个假读数 */
  var HAS_HEAP = %(hasHeap)s;
  var heapSeq = %(heapSeq)s;
  var heapIdx = 0;
  if (HAS_HEAP) {
    try {
      Object.defineProperty(self.performance, 'memory', {
        configurable: true,
        get: function () {
          var v = heapSeq[Math.min(heapIdx, heapSeq.length - 1)];
          heapIdx += 1;
          return { usedJSHeapSize: v };
        }
      });
    } catch (e) {}
  }

  var CFG = %(cfg)s;
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function mkUnits(spec) {
    var out = [];
    for (var i = 0; i < spec.length; i++) {
      var n = spec[i].n, key = spec[i].key || ('u' + i);
      var x = [], y = [], z = [], hdg = [];
      for (var k = 0; k < n; k++) { x.push(i * 10000 + k); y.push(k); z.push(100 + k); hdg.push(k %% 360); }
      out.push({ key: key, side: 'enemy', sideDecoded: 'enemy', domain: 'air',
                 vehicle: 'f_15a', vehicleName: 'F-15A', vehicleCategory: 'FIGHTER',
                 hidden: false, player: null, playerCandidates: [], hasAlt: true,
                 t0: 0, hz: 1, n: n, x: x, y: y, z: z, hdg: hdg, uid: i + 1, segment: 1 });
    }
    return out;
  }
  function mkMission(units) {
    return {
      meta: {
        source: 'wrpl',
        window: { t0: 0, t1: 10, duration: 10 },
        counts: { ownSamples: 2, airTracks: units.length, groundTracks: 0, kills: 0,
                  shots: 0, runways: 0, airfields: 0 },
        limits: [], provenance: [],
        replayHeader: { level: 'gameData/Levels/synth_verify.bin' }
      },
      own: { t0: 0, hz: 10, n: 2, x: [0, 10], y: [0, 10], z: [100, 100], hdg: [0, 0],
             ias: [100, 100], tas: [100, 100], mach: [0.3, 0.3], roll: [0, 0], pitch: [0, 0],
             g: [1, 1], aoa: [0, 0], ammo: [0, 0], fuel: [1, 1], vy: [0, 0], throttle: [1, 1] },
      units: units, events: [], shots: [], runways: [], airfields: [], missiles: [],
      terrain: null, names: {}, __attitude: null
    };
  }

  /* 记录每条 units 分片（真实数值数），随 done 前的一条 progress 回传 */
  var chunkLog = [];
  var origPost = self.postMessage;
  self.postMessage = function (m) {
    if (m && m.type === 'part' && m.key === 'units') {
      var vals = 0;
      (m.data || []).forEach(function (u) {
        Object.keys(u).forEach(function (k) {
          if (k !== '__slice' && Array.isArray(u[k])) vals += u[k].length;
        });
      });
      chunkLog.push(vals);
    }
    if (m && m.type === 'done') {
      origPost.call(self, { type: 'progress', phase: 'test-stats', pct: 0,
                            note: JSON.stringify({ chunks: chunkLog }) });
    }
    return origPost.call(self, m);
  };

  WRPLParse._internal.parseMain = function () {
    return (async function () {
      var stages = CFG.stages || [];
      for (var i = 0; i < stages.length; i++) {
        WRPLParse._internal.emit(stages[i][0], stages[i][1], 'stage ' + i);
        await sleep(CFG.stageMs || 40);
      }
      if (CFG.fail) throw new Error(CFG.fail);
      WRPLParse._internal.emit('done', 100, '完成');
      return mkMission(mkUnits(CFG.units || []));
    })();
  };
})();
"""


def worker_body(has_heap, heap_seq, cfg):
    src = open(WORKER_JS, encoding='utf-8').read()
    return src + '\n' + HARNESS % {
        'hasHeap': 'true' if has_heap else 'false',
        'heapSeq': json.dumps(heap_seq),
        'cfg': json.dumps(cfg),
    }


RAW_WORKER_JS = r"""
async () => {
  const w = new Worker('wrpl-worker.js');
  const msgs = [];
  await new Promise((resolve, reject) => {
    w.onmessage = e => { if (e.data && e.data.type === 'ready') resolve(); };
    w.onerror = e => reject(new Error('worker load error: ' + e.message));
    w.postMessage({ cmd: 'ready' });
  });
  await new Promise((resolve, reject) => {
    w.onmessage = e => {
      msgs.push(e.data);
      if (e.data.type === 'done' || e.data.type === 'error') resolve();
    };
    w.onerror = e => reject(new Error('worker error: ' + e.message));
    w.postMessage({ cmd: 'parse', buf: new ArrayBuffer(8) });
  });
  w.terminate();
  return msgs;
}
"""

DROP_JS = r"""
async (b64) => {
  const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const file = new File([bin], 'synth.wrpl', {type: 'application/octet-stream'});
  const dt = new DataTransfer(); dt.items.add(file);
  const heapEl = document.getElementById('upload-heap');
  const read = () => ({
    heap: heapEl.textContent.split('\n').map(s => s.trim()).filter(Boolean).join(' '),
    stage: document.getElementById('upload-stage').textContent
  });
  const samples = [];
  const timer = setInterval(() => samples.push(read()), 20);
  window.dispatchEvent(new DragEvent('drop', {dataTransfer: dt, bubbles: true, cancelable: true}));
  await new Promise(r => setTimeout(r, 4000));
  clearInterval(timer);
  samples.push(read());
  const last = window.__WRPL_LAST;
  const huge = last ? last.units.find(u => u.key === 'huge') : null;
  return {
    samples,
    className: document.getElementById('upload').className,
    note: document.getElementById('upload-note').textContent,
    errVisible: getComputedStyle(document.getElementById('errbox')).display,
    errDetail: document.getElementById('err-detail').textContent,
    last: last ? {
      units: last.units.length,
      unitKeys: last.units.map(u => u.key),
      hugeLen: huge ? huge.x.length : null,
      hugeOrderOK: huge ? huge.x.every((v, i) => v === i) : null,
      peak: last.meta.__workerHeapPeakMB,
      hasPeakKey: '__workerHeapPeakMB' in last.meta,
      limits: last.meta.limits.filter(l => l.indexOf('解析路径') >= 0)
    } : null
  };
}
"""


def heap_pair(text):
    """把「内存 12.0 MB / 峰值 34.0 MB」解析成 (12.0, 34.0)；"不可用" → None。"""
    body = text.replace('内存', '').replace('/ 峰值', '|').replace('MB', '')
    left, right = body.split('|')
    def num(s):
        s = s.strip()
        return float(s) if s and s != '不可用' else None
    return num(left), num(right)


# 空 zstd 帧（包流为空）：容器头 + 这一帧就是一个能"解析成功但 0 个包"的最小 .wrpl。
# 用来验证主线程回退路径（真实解析器、真实容器层）而不用带外部回放文件。
EMPTY_ZSTD_FRAME = bytes.fromhex('28b52ffd2000010000')


def minimal_wrpl():
    """按 wrpl-parse.js 的 parseReplayHeader 布局拼一个 1224 B 头（settingsSize=0）。"""
    h = bytearray(1224)
    def u32(off, v):
        h[off:off + 4] = int(v).to_bytes(4, 'little')
    def cstr(off, size, s):
        b = s.encode('utf-8')[:size - 1]
        h[off:off + len(b)] = b
    u32(0, 0x1000ACE5)
    u32(4, 1)
    cstr(8, 128, 'gameData/Levels/synth_verify.bin')   # level
    cstr(136, 260, '')                                 # levelSettings
    cstr(396, 128, 'arcade')                           # battleType
    u32(684, 0)                                        # rezOffset
    u32(744, 0)                                        # mSetSize
    u32(748, 0)                                        # settingsSize
    u32(908, 0)                                        # startTime
    u32(912, 20)                                       # timeLimit
    u32(916, 1000)                                     # scoreLimit
    return bytes(h) + b'\x00\x00' + EMPTY_ZSTD_FRAME    # 头后有固定 2 B 填充（HEADER_PAD_AFTER）


def main():
    srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT), '--bind', '127.0.0.1'],
                           cwd=REPO, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.2)
    current = {'body': None}
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            ctx = browser.new_context()
            ctx.route('**/wrpl-worker.js',
                      lambda r: r.fulfill(status=200, content_type='application/javascript',
                                          body=current['body']))

            def new_page():
                pg = ctx.new_page()
                pg.errs = []
                pg.on('pageerror', lambda e: pg.errs.append(str(e)))
                pg.goto(BASE + '/web/index.html', wait_until='load')
                return pg

            # ---------------- 正常解析 ----------------
            current['body'] = worker_body(
                True, [v * 1048576 for v in [40, 55, 43, 90, 50]],
                {'units': [{'n': 4000, 'key': 'a%d' % i} for i in range(10)],
                 'stages': [['fm', 20], ['ecs', 50], ['units', 80], ['side', 82]], 'stageMs': 5})
            pg = new_page()
            msgs = pg.evaluate(RAW_WORKER_JS)
            units_parts = [m for m in msgs if m.get('type') == 'part' and m.get('key') == 'units']
            progress = [m for m in msgs if m.get('type') == 'progress' and m.get('phase') != 'test-stats']
            done = next(m for m in msgs if m.get('type') == 'done')
            vals = [sum(len(u['x']) + len(u['y']) + len(u['z']) + len(u['hdg'])
                        for u in m['data']) for m in units_parts]
            keys = [u['key'] for m in units_parts for u in m['data']]
            peaks = [m.get('workerHeapPeakMB') for m in progress]
            check(len(units_parts) == 2 and all(v <= 120000 for v in vals),
                  '正常解析：160000 数值切成 2 片，每片 ≤ 120000', vals)
            check(keys == ['a%d' % i for i in range(10)],
                  '正常解析：单位顺序与原始一致、不重不丢', keys)
            check(all(m.get('workerHeapMB') is not None for m in progress),
                  '正常解析：每条 progress 都带当前堆占用', peaks)
            check(all(peaks[i] >= peaks[i - 1] for i in range(1, len(peaks))) and peaks[-1] == 90,
                  '正常解析：峰值单调不减，等于采到的最大值 90', peaks)
            check(done.get('workerHeapPeakMB') == peaks[-1],
                  '正常解析：done 峰值 == 中途最后上报的峰值', done.get('workerHeapPeakMB'))
            stats = [m for m in msgs if m.get('type') == 'progress' and m.get('phase') == 'test-stats']
            check(len(stats) == 1 and json.loads(stats[0]['note'])['chunks'] == vals,
                  '正常解析：worker 自报的分片数值数与主线程收到的一致')
            check(not pg.errs, '正常解析：无 JS 异常', pg.errs)
            pg.close()

            # ---------------- 边界：正好装满 + 超限切片 ----------------
            current['body'] = worker_body(
                True, [50 * 1048576],
                {'units': [{'n': 30000, 'key': 'exact'}, {'n': 1, 'key': 'tiny'}],
                 'stages': [['fm', 20]], 'stageMs': 5})
            pg = new_page()
            msgs = pg.evaluate(RAW_WORKER_JS)
            parts = [m for m in msgs if m.get('type') == 'part' and m.get('key') == 'units']
            vals = [sum(len(u['x']) + len(u['y']) + len(u['z']) + len(u['hdg'])
                        for u in m['data']) for m in parts]
            check(len(parts) == 2 and vals == [120000, 4],
                  '边界：正好 120000 装满一片，下个单位另起一片', vals)
            pg.close()

            current['body'] = worker_body(
                True, [50 * 1048576],
                {'units': [{'n': 30001, 'key': 'huge'}, {'n': 1, 'key': 'tiny'}],
                 'stages': [['fm', 20]], 'stageMs': 5})
            pg = new_page()
            msgs = pg.evaluate(RAW_WORKER_JS)
            parts = [m for m in msgs if m.get('type') == 'part' and m.get('key') == 'units']
            vals = [sum(len(u['x']) + len(u['y']) + len(u['z']) + len(u['hdg'])
                        for u in m['data']) for m in parts]
            sliced = [u for m in parts for u in m['data'] if '__slice' in u]
            check(all(v <= 120000 for v in vals) and len(sliced) == 2,
                  '边界：超限单位切片发送，每片仍 ≤ 120000', vals)
            pg.close()

            # ---------------- 页面 UI：解析中显示、done 保留峰值 ----------------
            current['body'] = worker_body(
                True, [v * 1048576 for v in [30, 44, 38, 66, 83, 52]],
                {'units': [{'n': 30001, 'key': 'huge'}, {'n': 7, 'key': 'tiny'}],
                 'stages': [['container', 1], ['fm', 40], ['ecs', 70], ['units', 88]],
                 'stageMs': 120})
            pg = new_page()
            res = pg.evaluate(DROP_JS, base64.b64encode(b'\x00' * 64).decode())
            mid = [s for s in res['samples'] if heap_pair(s['heap'])[0] is not None]
            check(len(mid) > 0, '页面：解析过程中就显示堆占用（不是只在 done 时）',
                  [s['heap'] for s in res['samples'][:6]])
            pairs = [heap_pair(s['heap']) for s in mid]
            check(all(pk is None or nw <= pk for nw, pk in pairs),
                  '页面：显示值满足 当前 ≤ 峰值', pairs[:5])
            check(res['className'].startswith('is-done'), '页面：正常解析进入完成态', res['className'])
            final_now, final_peak = heap_pair(res['samples'][-1]['heap'])
            check(final_peak == 83.0, '页面：done 后保留最终峰值 83 MB', res['samples'][-1]['heap'])
            check(final_now is None or final_now <= 83.0,
                  '页面：done 后的当前值不伪造（不可用或真实读数）', res['samples'][-1]['heap'])
            check(res['last'] and res['last']['peak'] == 83,
                  '页面：meta.__workerHeapPeakMB == 过程中峰值 83', res['last'])
            check(res['last'] and res['last']['unitKeys'] == ['huge', 'tiny'] and
                  res['last']['hugeLen'] == 30001 and res['last']['hugeOrderOK'] is True,
                  '页面：超限单位拼回后完整、顺序一致', res['last'])
            check(not pg.errs, '页面：无 JS 异常', pg.errs)
            pg.close()

            # ---------------- 解析失败 ----------------
            current['body'] = worker_body(
                True, [v * 1048576 for v in [45, 60, 52]],
                {'units': [], 'stages': [['fm', 30], ['ecs', 60]],
                 'stageMs': 120, 'fail': 'synthetic parse failure'})
            pg = new_page()
            res = pg.evaluate(DROP_JS, base64.b64encode(b'\x00' * 64).decode())
            saw = any(heap_pair(s['heap'])[0] is not None for s in res['samples'])
            check(saw, '失败路径：失败前确实显示过堆占用（排除本来就没显示）',
                  [s['heap'] for s in res['samples'][:5]])
            check(res['className'].startswith('is-error'), '失败路径：进入错误态', res['className'])
            check('synthetic parse failure' in res['errDetail'], '失败路径：错误明细带原因',
                  res['errDetail'])
            tail = heap_pair(res['samples'][-1]['heap'])
            check(tail == (None, None), '失败路径：清掉进行中的当前值/峰值', res['samples'][-1]['heap'])
            check(res['last'] is None, '失败路径：没有留下 __WRPL_LAST')
            check(not pg.errs, '失败路径：无未捕获异常提示以外的问题', pg.errs)
            pg.close()

            # ---------------- 失败后再成功：不残留 ----------------
            current['body'] = worker_body(
                True, [12 * 1048576],
                {'units': [{'n': 2}], 'stages': [['fm', 20]], 'stageMs': 20})
            pg = new_page()
            res = pg.evaluate(DROP_JS, base64.b64encode(b'\x00' * 64).decode())
            check(res['last'] and res['last']['peak'] == 12,
                  '失败后的下一次解析：峰值是本次的 12 MB（不残留）', res['last'])
            pg.close()

            # ---------------- 主线程回退：没有 worker 读数 ----------------
            # 用最小真实 .wrpl（真解析器 + 真容器层）走回退路径：worker 被拦截 → 建不起来
            ctx.unroute('**/wrpl-worker.js')
            ctx.route('**/wrpl-worker.js', lambda r: r.abort())
            pg = new_page()
            res = pg.evaluate(DROP_JS, base64.b64encode(minimal_wrpl()).decode())
            check(res['className'].startswith('is-done'), '回退路径：解析仍完成', res['className'])
            check(res['last'] and res['last']['hasPeakKey'] and res['last']['peak'] is None,
                  '回退路径：__workerHeapPeakMB 键存在且为 null', res['last'])
            check(heap_pair(res['samples'][-1]['heap']) == (None, None) and
                  any('主线程' in l for l in (res['last'] or {}).get('limits', [])),
                  '回退路径：UI 显示不可用，limits 写明主线程回退',
                  (res['samples'][-1]['heap'], (res['last'] or {}).get('limits')))
            check(not pg.errs, '回退路径：无 JS 异常', pg.errs)
            pg.close()

            browser.close()
    finally:
        srv.terminate()
        try:
            srv.wait(timeout=5)
        except Exception:
            pass

    print()
    if failures:
        print('失败 %d 项：' % len(failures))
        for f in failures:
            print(' - ' + f)
        return 1
    print('浏览器端到端验收通过')
    return 0


if __name__ == '__main__':
    sys.exit(main())
