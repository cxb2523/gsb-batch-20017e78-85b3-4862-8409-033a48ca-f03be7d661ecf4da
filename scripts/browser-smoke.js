'use strict';
// =====================================================================
// 浏览器冒烟测试 — 用真实 index.html + Chrome 无头渲染驱动 Mode B
// ---------------------------------------------------------------------
// 通过 Chrome DevTools Protocol（CDP）在无头浏览器里加载页面，执行：
//   1. 切到模式 B，计算方案
//   2. 抓取控制台错误（任何 JS 异常即失败）
//   3. 读取 PalletOptimizer._state 与 3D 场景对象数，验证与摘要一致
//   4. 切换候选 / A↔B / 中英切换，验证选中项与视图不变
// 用法：node scripts/browser-smoke.js [port]
// 依赖：本机 Chrome（自动探测）或 CHROME_PATH 环境变量。无需 npm 依赖。
// =====================================================================
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.argv[2] || 7011);

function findChrome() {
  const cands = [
    process.env.CHROME_PATH,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'
  ].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (e) {} }
  return null;
}

function httpGET(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => { let b = ''; res.on('data', d => b += d);
      res.on('end', () => resolve({ status: res.statusCode, body: b })); }).on('error', reject);
  });
}
function httpJSON(url) {
  return httpGET(url).then(r => JSON.parse(r.body));
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 极简 WebSocket 客户端（只支持 CDP 所需的文本帧，免第三方依赖）
const crypto = require('crypto');
function wsConnect(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13'
      }
    });
    req.on('upgrade', (res, socket) => {
      let buf = Buffer.alloc(0);
      const listeners = [];
      socket.on('data', chunk => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 2) {
          const b0 = buf[0], b1 = buf[1];
          const opcode = b0 & 0x0f;
          let len = b1 & 0x7f, off = 2;
          if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
          else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
          const masked = (b1 & 0x80) !== 0;
          if (buf.length < off + (masked ? 4 : 0) + len) return;
          let payload;
          if (masked) {
            const mask = buf.slice(off, off + 4); off += 4;
            payload = Buffer.alloc(len);
            for (let i = 0; i < len; i++) payload[i] = buf[off + i] ^ mask[i % 4];
          } else payload = buf.slice(off, off + len);
          buf = buf.slice(off + len);
          if (opcode === 1 || opcode === 2) listeners.forEach(fn => fn(payload.toString('utf8')));
          else if (opcode === 8) { socket.end(); }
        }
      });
      socket.on('error', reject);
      resolve({
        send(str) {
          const data = Buffer.from(str, 'utf8');
          const mask = crypto.randomBytes(4);
          const masked = Buffer.alloc(data.length);
          for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i % 4];
          let header;
          if (data.length < 126) { header = Buffer.from([0x81, 0x80 | data.length]); }
          else if (data.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(data.length, 2); }
          else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(data.length), 2); }
          socket.write(Buffer.concat([header, mask, masked]));
        },
        onMessage(fn) { listeners.push(fn); },
        close() { try { socket.end(); } catch (e) {} }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  const chrome = findChrome();
  if (!chrome) { console.log('⚠ 未找到 Chrome/Edge，跳过浏览器冒烟测试（Node 验收脚本已覆盖核心逻辑）'); process.exit(0); }

  // 启动静态服务器（若调用方未启动）
  let serverProc = null;
  const probe = await httpGET(`http://127.0.0.1:${PORT}/`).catch(() => null);
  if (!probe) {
    serverProc = spawn(process.execPath, [path.join(__dirname, 'static-server.js'), String(PORT)], { stdio: 'ignore' });
    await sleep(900);
  }

  // Chrome/Edge refuse --remote-debugging with the default profile, and on
  // Windows the profile dir must be an absolute path. Prefer a short temp path
  // (avoid non-ASCII / long paths), falling back to os.tmpdir().
  const userDir = (process.platform === 'win32' ? 'D:\\tmp\\' : path.join(os.tmpdir(), '')) +
    'mb-smoke-' + process.pid;
  try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (e) {}
  fs.mkdirSync(userDir, { recursive: true });
  const dbgPort = 9333;
  const args = [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-first-run', '--disable-crash-reporter', '--remote-allow-origins=*',
    `--remote-debugging-port=${dbgPort}`, `--user-data-dir=${userDir}`,
    `http://127.0.0.1:${PORT}/`
  ];
  const chromeProc = spawn(chrome, args, { stdio: 'ignore' });

  const cleanup = () => {
    try { chromeProc.kill(); } catch (e) {}
    if (serverProc) { try { serverProc.kill(); } catch (e) {} }
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (e) {}
  };

  let PASS = 0, FAIL = 0;
  const fails = [];
  const ok = (c, m) => { if (c) PASS++; else { FAIL++; fails.push(m); console.log('  ❌ ' + m); } };

  try {
    // 等 devtools 端点（用 localhost：Chromium 在部分 Windows 环境只监听 ::1）
    let target = null;
    for (let i = 0; i < 60; i++) {
      try {
        const list = await httpJSON(`http://localhost:${dbgPort}/json`);
        target = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
        if (target) break;
      } catch (e) {}
      await sleep(250);
    }
    if (!target) throw new Error('无法连接 Chrome DevTools');

    const ws = await wsConnect(target.webSocketDebuggerUrl);
    let msgId = 0;
    const pending = new Map();
    const consoleErrors = [];
    ws.onMessage(raw => {
      let msg; try { msg = JSON.parse(raw); } catch (e) { return; }
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        consoleErrors.push(d.exception ? (d.exception.description || d.exception.value) : d.text);
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        consoleErrors.push(msg.params.args.map(a => a.value || a.description || '').join(' '));
      }
    });
    const call = (method, params) => new Promise(res => {
      const id = ++msgId;
      pending.set(id, m => res(m.result));
      ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
    const evalJS = async (expr) => {
      const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r && r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.text || ''));
      return r && r.result ? r.result.value : undefined;
    };

    await call('Runtime.enable', {});
    await call('Page.enable', {});
    await sleep(1500);   // let lib-loader + app boot

    // 1) 页面与依赖就绪
    const boot = await evalJS(`({three: !!window.THREE, opt: !!window.PalletOptimizer, i18n: typeof applyI18n})`);
    ok(boot.opt, '浏览器：PalletOptimizer 已加载');
    ok(boot.three, '浏览器：THREE 已就绪');
    ok(boot.i18n === 'function', '浏览器：applyI18n 可用');

    // 2) 进入模式 B 并计算
    await evalJS(`window.PalletOptimizer.showMode('B'); window.PalletOptimizer.runOptimize(); true`);
    await sleep(700);
    const s1 = await evalJS(`(function(){
      var s=window.PalletOptimizer._state;
      function cnt(g){var n=0;(function w(x){(x.children||[]).forEach(function(c){if(c.userData&&c.userData.pickable)n++;if(c.children&&c.children.length)w(c);});})(g);return n;}
      return { n:s.candidates.length, sel:!!s.selected, idx:s.selectedIndex,
        perLayer:s.selected&&s.selected.palletLoad.perLayer,
        layers:s.selected&&s.selected.palletLoad.layers,
        stack:s.selected&&s.selected.cont.stack,
        pickable:s.scenes?cnt(s.scenes.pallet.group):-1,
        summary:document.getElementById('bSummary').innerHTML };
    })()`);
    ok(s1.n > 0, '浏览器：产生候选方案');
    ok(s1.sel, '浏览器：已选中方案');
    ok(s1.pickable === s1.perLayer * s1.layers * Math.max(1, Math.min(2, s1.stack)),
      `浏览器：托盘视图箱数(${s1.pickable}) == perLayer×layers×stack`);
    ok(String(s1.summary).indexOf(String(s1.perLayer)) >= 0, '浏览器：摘要显示选中方案 perLayer');

    // 3) 切换候选
    const s2 = await evalJS(`(function(){
      var rows=document.querySelectorAll('#bTop10 tr[data-idx]');
      if(rows.length<2)return {skip:true};
      rows[1].click();
      var s=window.PalletOptimizer._state;
      function cnt(g){var n=0;(function w(x){(x.children||[]).forEach(function(c){if(c.userData&&c.userData.pickable)n++;if(c.children&&c.children.length)w(c);});})(g);return n;}
      var selRows=document.querySelectorAll('#bTop10 tr.selected');
      return { idx:s.selectedIndex, selPicks:selRows.length,
        pickable:cnt(s.scenes.pallet.group),
        expect:s.selected.palletLoad.perLayer*s.selected.palletLoad.layers*Math.max(1,Math.min(2,s.selected.cont.stack)) };
    })()`);
    if (!s2.skip) {
      ok(s2.idx === 1, '浏览器：切换后 selectedIndex == 1');
      ok(s2.selPicks === 1, '浏览器：Top10 仅一行高亮');
      ok(s2.pickable === s2.expect, '浏览器：切换后托盘视图箱数与选中方案一致');
    }

    // 4) A→B→A→B
    const s3 = await evalJS(`(function(){
      window.PalletOptimizer.showMode('A');
      window.PalletOptimizer.showMode('B');
      var s=window.PalletOptimizer._state;
      function cnt(g){var n=0;(function w(x){(x.children||[]).forEach(function(c){if(c.userData&&c.userData.pickable)n++;if(c.children&&c.children.length)w(c);});})(g);return n;}
      return { idx:s.selectedIndex, pickable:cnt(s.scenes.pallet.group),
        expect:s.selected.palletLoad.perLayer*s.selected.palletLoad.layers*Math.max(1,Math.min(2,s.selected.cont.stack)) };
    })()`);
    await sleep(300);
    ok(s3.pickable === s3.expect, '浏览器：A→B 后托盘视图仍对应当前方案');

    // 5) 中英切换
    const s4 = await evalJS(`(function(){
      var before=window.PalletOptimizer._state.selectedIndex;
      toggleLang();
      var s=window.PalletOptimizer._state;
      var selRows=document.querySelectorAll('#bTop10 tr.selected');
      var hlIdx = selRows.length ? selRows[0].getAttribute('data-idx') : null;
      var sum=document.getElementById('bSummary').innerHTML;
      toggleLang();
      return { before:before, after:s.selectedIndex, selRows:selRows.length,
        hlIdx:hlIdx, enTitle:/Best Plan/.test(sum) };
    })()`);
    ok(s4.before === s4.after, '浏览器：语言切换后选中索引不变');
    ok(s4.selRows === 1, '浏览器：语言切换后仍仅一行高亮');
    ok(s4.hlIdx !== null && Number(s4.hlIdx) === s4.after,
      '浏览器：语言切换后高亮行 == 选中索引（未跳回第 0 行）');
    ok(s4.enTitle, '浏览器：英文摘要标题本地化');

    // 6) 无控制台异常
    ok(consoleErrors.length === 0, '浏览器：无 JS 运行时错误' + (consoleErrors.length ? ' → ' + consoleErrors.slice(0, 2).join(' | ') : ''));

    ws.close();
  } catch (e) {
    FAIL++; fails.push('浏览器冒烟：' + e.message);
    console.log('  ❌ 浏览器冒烟异常：' + e.message);
  } finally {
    cleanup();
  }

  console.log('\n' + '='.repeat(78));
  if (FAIL === 0) console.log(`✅ 浏览器冒烟通过：${PASS} 项断言`);
  else { console.log(`❌ 浏览器冒烟 ${FAIL} 项失败`); fails.forEach(f => console.log('   - ' + f)); }
  console.log('='.repeat(78));
  process.exit(FAIL === 0 ? 0 : 1);
}

main();
