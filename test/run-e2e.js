/**
 * 画布混剪播放器端到端验证：跳转 / 自动切换 / 关闭重开
 *
 * 运行前提：
 *   1. 已执行 `npm run build` 生成 lib/
 *   2. 安装 puppeteer-core（可全局或临时目录）：npm i -D puppeteer-core
 *   3. 准备一个可用的浏览器可执行文件（推荐 chrome-headless-shell / Chrome for Testing）
 *
 * 环境变量：
 *   CHROME_EXE     浏览器可执行文件路径（必填，除非默认路径存在）
 *   PUPPETEER_PATH puppeteer-core 模块路径（默认直接 require('puppeteer-core')）
 *   PORT           本地静态服务端口（默认 8917）
 *
 * 用法：node test/run-e2e.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const PORT = parseInt(process.env.PORT || '8917', 10);
const CHROME =
  process.env.CHROME_EXE ||
  'D:\\workspace\\11-24\\60\\A\\attempt-1\\temp\\browsers\\chrome-headless-shell\\win64-158.0.8127.88\\chrome-headless-shell-win64\\chrome-headless-shell.exe';
const puppeteer = require(process.env.PUPPETEER_PATH || 'puppeteer-core');

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.mp4': 'video/mp4', '.map': 'application/json', '.json': 'application/json',
};

function serve(root, port) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      const rel = urlPath === '/' ? '/test/player.test.html' : urlPath;
      const file = path.join(root, rel);
      if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
      fs.stat(file, (err, st) => {
        if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
        const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
        const range = req.headers.range;
        if (range) {
          const m = /bytes=(\d*)-(\d*)/.exec(range);
          let start = m && m[1] ? parseInt(m[1], 10) : 0;
          let end = m && m[2] ? parseInt(m[2], 10) : st.size - 1;
          end = Math.min(end, st.size - 1);
          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${st.size}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': end - start + 1,
            'Content-Type': type,
          });
          fs.createReadStream(file, { start, end }).pipe(res);
        } else {
          res.writeHead(200, {
            'Content-Length': st.size,
            'Content-Type': type,
            'Accept-Ranges': 'bytes',
          });
          fs.createReadStream(file).pipe(res);
        }
      });
    });
    srv.on('error', reject);
    srv.listen(port, () => resolve(srv));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, cond, extra) {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'} - ${name}${extra !== undefined ? ' | ' + extra : ''}`);
}

async function drawRate(page, ms = 1000) {
  const c0 = await page.evaluate(() => window.__drawCount);
  await sleep(ms);
  const c1 = await page.evaluate(() => window.__drawCount);
  return (c1 - c0) / (ms / 1000);
}

async function videoCount(page) {
  return page.evaluate(() => document.querySelectorAll('video').length);
}

(async () => {
  const srv = await serve(REPO, PORT);
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
      '--window-size=1280,800',
    ],
  });
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(`http://127.0.0.1:${PORT}/test/player.test.html`, { waitUntil: 'load' });

    // ---------- 1. 启动播放 ----------
    await page.waitForFunction('window.p && window.p.showDom === true', { timeout: 20000 });
    check('启动后进入播放状态(showDom)', true);
    check('初始片段 playIndex===0', await page.evaluate(() => window.p.playIndex === 0));
    check('视频元素恰好 2 个(主+预加载)', (await videoCount(page)) === 2, await videoCount(page));
    check('画布已创建', await page.evaluate(() => !!document.getElementById('AutoCanvasId')));
    check('总时长计算正确(11s)', await page.evaluate(() => Math.abs(window.p.totalTime - 11) < 0.001),
      await page.evaluate(() => window.p.totalTime));

    const t0 = await page.evaluate(() => window.p.playedTime);
    await sleep(1200);
    const t1 = await page.evaluate(() => window.p.playedTime);
    check('播放进度持续推进', t1 > t0 + 0.3, `${t0.toFixed(2)} -> ${t1.toFixed(2)}`);

    // ---------- 2. 进度条累计时间与实际播放位置一致 ----------
    const drift = await page.evaluate(() => {
      const p = window.p;
      const seg = p.segment;
      const expected = seg.baseTime + (p.mainVideoObj.currentTime - seg.start);
      return Math.abs(p.playedTime - expected);
    });
    check('进度条累计时间与实际播放位置一致(漂移<0.4s)', drift < 0.4, `drift=${drift.toFixed(3)}`);

    const rate1 = await drawRate(page);
    check('绘制循环只有一个(5~90 帧/秒)', rate1 > 5 && rate1 < 90, `rate=${rate1.toFixed(1)}/s`);

    // ---------- 3. 点击进度条跳转 ----------
    const bar = await page.$('.bar');
    const barBox = await bar.boundingBox();
    const clickX = barBox.x + barBox.width * 0.7; // 0.7*11 = 7.7s -> 第3段(idx2, 6~9)
    await page.mouse.click(clickX, barBox.y + barBox.height / 2);
    await sleep(1000);
    const afterClick = await page.evaluate(() => ({
      idx: window.p.playIndex,
      played: window.p.playedTime,
      cur: window.p.mainVideoObj.currentTime,
      segStart: window.p.segment.start,
      baseTime: window.p.segment.baseTime,
      src: window.p.mainVideoObj.src,
    }));
    check('点击跳转到正确片段(playIndex===2)', afterClick.idx === 2, `idx=${afterClick.idx}`);
    check('跳转后累计进度从 7.7s 继续前进', afterClick.played > 7.4 && afterClick.played < 9.2,
      `played=${afterClick.played.toFixed(2)}`);
    check('片段内偏移与累计进度一致',
      Math.abs(afterClick.played - (afterClick.baseTime + (afterClick.cur - afterClick.segStart))) < 0.5,
      `played=${afterClick.played.toFixed(2)} cur=${afterClick.cur.toFixed(2)}`);
    check('切换到正确视频源(v3)', afterClick.src.includes('v3.mp4'), afterClick.src);

    // ---------- 4. 跳转到最后一段 ----------
    await page.evaluate(() => { window.p.playedTime = 10.3; window.p.skipProgress(); });
    await sleep(400);
    const lastSeg = await page.evaluate(() => ({ idx: window.p.playIndex, played: window.p.playedTime }));
    check('可跳转到最后一段(playIndex===3)', lastSeg.idx === 3, `idx=${lastSeg.idx}`);
    check('末段进度≈10.3s', Math.abs(lastSeg.played - 10.3) < 0.7, `played=${lastSeg.played.toFixed(2)}`);

    // ---------- 5. 播放到全部结束 ----------
    await page.waitForFunction('window.p.endFlag === true', { timeout: 15000 });
    const endState = await page.evaluate(() => ({
      paused: window.p.paused, played: window.p.playedTime, total: window.p.totalTime,
    }));
    check('全部播完后进入暂停结束态', endState.paused === true);
    check('结束时进度停在总时长', Math.abs(endState.played - endState.total) < 0.01,
      `played=${endState.played}`);

    // ---------- 6. 重播并验证自动切换 ----------
    await page.evaluate(() => { window.p.changeVideoState(); });
    await page.waitForFunction('window.p.playIndex === 1 && window.p.showDom === true', { timeout: 15000 });
    const sw1 = await page.evaluate(() => ({
      videos: document.querySelectorAll('video').length,
      mainSrc: window.p.mainVideoObj.src,
      preloadSrc: window.p.preloadVideoObj ? window.p.preloadVideoObj.src : '',
      mainPaused: window.p.mainVideoObj.paused,
    }));
    check('自动切到第 2 段后仍只有 2 个视频元素', sw1.videos === 2, `videos=${sw1.videos}`);
    check('主元素切换到 v2', sw1.mainSrc.includes('v2.mp4'), sw1.mainSrc);
    check('预加载元素指向第 3 段(v3)', sw1.preloadSrc.includes('v3.mp4'), sw1.preloadSrc);
    check('新片段在播放(未暂停)', sw1.mainPaused === false);
    await page.evaluate(() => { window.__preAt1 = window.p.preloadVideoObj; });
    const rate2 = await drawRate(page);
    check('切换后仍只有一个绘制循环', rate2 > 5 && rate2 < 90, `rate=${rate2.toFixed(1)}/s`);

    await page.waitForFunction('window.p.playIndex === 2', { timeout: 15000 });
    const sw2 = await page.evaluate(() => ({
      videos: document.querySelectorAll('video').length,
      promoted: window.p.mainVideoObj === window.__preAt1,
      mainSrc: window.p.mainVideoObj.src,
      drift: Math.abs(
        window.p.playedTime -
          (window.p.segment.baseTime + (window.p.mainVideoObj.currentTime - window.p.segment.start))
      ),
    }));
    check('切到第 3 段后视频元素仍为 2 个', sw2.videos === 2, `videos=${sw2.videos}`);
    check('预加载元素被复用提升为主播放元素', sw2.promoted === true);
    check('主元素切换到 v3', sw2.mainSrc.includes('v3.mp4'), sw2.mainSrc);
    check('切换后进度条与实际位置一致(漂移<0.4s)', sw2.drift < 0.4, `drift=${sw2.drift.toFixed(3)}`);

    // ---------- 7. 拖动进度条跳转 ----------
    const circle = await page.$('#circle');
    const cBox = await circle.boundingBox();
    const barBox2 = await (await page.$('.bar')).boundingBox();
    await page.mouse.move(cBox.x + cBox.width / 2, cBox.y + cBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(barBox2.x + barBox2.width * 0.3, barBox2.y + barBox2.height / 2, { steps: 5 });
    await page.mouse.up();
    await sleep(1000);
    const afterDrag = await page.evaluate(() => ({ idx: window.p.playIndex, played: window.p.playedTime }));
    // 0.3*11 = 3.3s -> 第2段(idx1, 2~6)
    check('拖动后定位到正确片段(playIndex===1)', afterDrag.idx === 1, `idx=${afterDrag.idx}`);
    check('拖动后累计进度≈3.3s', Math.abs(afterDrag.played - 3.3) < 0.9, `played=${afterDrag.played.toFixed(2)}`);

    // ---------- 8. 关闭释放 ----------
    await page.evaluate(() => { window.p.close(); });
    await sleep(600);
    const closed = await page.evaluate(() => ({
      videos: document.querySelectorAll('video').length,
      canvas: !!document.getElementById('AutoCanvasId'),
      popup: !!document.querySelector('.popup-layer'),
      raf: window.p.RAFCancelReq,
    }));
    check('关闭后视频元素全部移除', closed.videos === 0, `videos=${closed.videos}`);
    check('关闭后画布节点移除', closed.canvas === false);
    check('关闭后播放器 DOM 移除', closed.popup === false);
    check('关闭后无挂起的动画帧', closed.raf === null, `raf=${closed.raf}`);
    const dc0 = await page.evaluate(() => window.__drawCount);
    await sleep(500);
    const dc1 = await page.evaluate(() => window.__drawCount);
    check('关闭后绘制循环完全停止', dc1 === dc0, `${dc0} -> ${dc1}`);

    // ---------- 9. 再次打开 ----------
    await page.evaluate(() => {
      window.p2 = Vue.prototype.$canvasVideoPlayer(window.__testData);
    });
    await page.waitForFunction('window.p2 && window.p2.showDom === true', { timeout: 20000 });
    const reopen = await page.evaluate(() => ({
      videos: document.querySelectorAll('video').length,
      idx: window.p2.playIndex,
      played: window.p2.playedTime,
    }));
    check('重开后正常播放(showDom)', true);
    check('重开后视频元素为 2 个', reopen.videos === 2, `videos=${reopen.videos}`);
    await sleep(1000);
    const played2 = await page.evaluate(() => window.p2.playedTime);
    check('重开后进度持续推进', played2 > reopen.played, `${reopen.played.toFixed(2)} -> ${played2.toFixed(2)}`);
    await page.evaluate(() => { window.p2.close(); });
    await sleep(400);
  } catch (e) {
    failures++;
    console.log('FATAL:', e.message);
  } finally {
    await browser.close();
    srv.close();
  }
  console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
