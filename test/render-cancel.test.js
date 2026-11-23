// Cancellation and cache lifecycle for project renders. Needs Chrome, ffmpeg and ffprobe, like test/render.test.js.
// The machine these tests run on shares Chrome with other work, and a fresh headless Chrome intermittently fails to
// expose the page contract in time. That is an environment flake, not the behaviour under test, so a run that dies on
// page launch is retried with a fresh project. Assertions never retry; only the flaky launch does.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { liveChromeCount } from '../src/chrome.js';
import { liveProcessCount, probeVideo } from '../src/ffmpeg.js';
import { renderProject } from '../src/project.js';

const quiet = { log: () => {} };
// Retries only the "Chrome never came up" failures; a render that got past launch is never re-attempted.
const FLAKE = /did not expose|Chrome connection closed|Chrome exited early|DevTools|could not connect/i;
async function withFlakeRetries(run, tries = 6) {
  let last;
  for (let attempt = 0; attempt < tries; attempt++) {
    try { return await run(attempt); }
    catch (e) {
      last = e;
      if (!FLAKE.test(String(e?.message))) throw e;
      await sleep(300);
    }
  }
  throw last;
}

function flatScene(dir, name, colour, total = 1) {
  writeFileSync(join(dir, name), `<!doctype html><canvas id="c" width="320" height="180"></canvas><script>
    const c = document.getElementById('c').getContext('2d'); window.TOTAL = ${total}; window.ready = Promise.resolve(true);
    window.renderAt = () => { c.fillStyle = '${colour}'; c.fillRect(0, 0, 320, 180); };</script>`);
}
// A scene whose first frame parks on an HTTP gate, so a render can be stopped deterministically mid-encode. The fetch
// is best-effort: after the gate releases, a dead connection left by the aborted render must not fail the re-render.
function gatedScene(dir, name, gatePort, total = 2) {
  writeFileSync(join(dir, name), `<!doctype html><canvas id="c" width="320" height="180"></canvas><script>
    const c = document.getElementById('c').getContext('2d'); window.TOTAL = ${total}; window.ready = Promise.resolve(true);
    window.renderAt = async () => { try { await fetch('http://127.0.0.1:${gatePort}/gate'); } catch (e) {} c.fillStyle = '#f80'; c.fillRect(0, 0, 320, 180); };</script>`);
}
function gateServer() {
  const waiters = [];
  let open = false;   // once released, every later /gate answers at once, so a re-render does not park again
  const server = createServer((req, res) => {
    if (new URL(req.url, 'http://x').pathname === '/gate') {
      if (open) return res.end('ok');
      waiters.push(res); return;
    }
    res.end('ok');
  });
  return {
    waiters,
    async start() { await new Promise(r => server.listen(0, '127.0.0.1', r)); return server.address().port; },
    reset() { open = false; waiters.splice(0).forEach(r => r.destroy()); },   // drop waiters left by a flake-killed render
    release() { open = true; waiters.splice(0).forEach(r => r.end('ok')); },
    close() { this.release(); return new Promise(r => server.close(r)); },
  };
}
const makeProject = dir => {
  const cache = join(dir, 'cache');
  process.env.MOTLAB_CACHE_DIR = cache;   // cacheDir() reads it when a render runs, so a per-project cache is isolated
  return { cache, partsRoot: join(cache, 'parts'), run: opts => renderProject({ dir, signal: undefined, ...quiet, ...opts }) };
};
const partDirOf = partsRoot => join(partsRoot, readdirSync(partsRoot)[0]);
const listCache = partsRoot => existsSync(partsRoot) ? readdirSync(partDirOf(partsRoot)).sort() : [];
// Resolves true once the render job settles (reject or fulfil), false after one poll interval, without unhandled rejections.
const settledSoon = job => Promise.race([job.then(() => true, () => true), sleep(1, false)]);
// Park until the gated scene starts (waiters queued) or the render job dies first; returns whether the gate was hit.
async function waitForGate(gate, job, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (gate.waiters.length) return true;
    if (await settledSoon(job)) return false;
    await sleep(100);
  }
  return gate.waiters.length > 0;
}

test('parallel render of several scenes and transitions keeps the right frame count and duration', { timeout: 420000 }, async () => {
  await withFlakeRetries(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'motlab-ok-'));
    const proj = makeProject(dir);
    try {
      ['a.html', 'b.html', 'c.html', 'd.html'].forEach((n, i) => flatScene(dir, n, ['#000', '#fff', '#f00', '#00f'][i]));
      const fade = { type: 'fade', duration: 0.5, ease: 'linear' };
      writeFileSync(join(dir, 'project.json'), JSON.stringify({
        fps: 30, scenes: ['a.html', { file: 'b.html', transition: fade }, 'c.html', { file: 'd.html', transition: fade }],
      }));
      const out = join(dir, 'video.mp4');
      await proj.run({ out, scale: 1, parallel: 3 });
      const v = await probeVideo(out);
      assert.equal(v.frames, 90);                                   // four 30-frame scenes, two 15-frame overlaps
      assert.ok(Math.abs(v.duration - 3) < 0.02, `duration ${v.duration}`);
      assert.ok(!existsSync(out + '.part'));
      assert.equal(listCache(proj.partsRoot).filter(f => f.endsWith('.mp4')).length, 6);   // 4 scenes + 2 transitions
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

test('cancelling a parallel render closes every Chrome and ffmpeg, leaves no .part, and writes no new manifest', { timeout: 420000 }, async () => {
  const gate = gateServer();
  const port = await gate.start();
  await withFlakeRetries(async () => {
    gate.reset();
    const dir = mkdtempSync(join(tmpdir(), 'motlab-cancel-'));
    const proj = makeProject(dir);
    try {
      flatScene(dir, 'a.html', '#08f');                 // finishes first and alone
      gatedScene(dir, 'b.html', port);                  // parks mid-encode
      flatScene(dir, 'c.html', '#0f8');
      writeFileSync(join(dir, 'project.json'), JSON.stringify({
        fps: 24, scenes: ['a.html', { file: 'b.html', transition: { type: 'fade', duration: 0.5 } }, 'c.html'],
      }));
      const out = join(dir, 'video.mp4');
      const controller = new AbortController();
      const job = proj.run({ out, scale: 1, parallel: 2, signal: controller.signal });
      assert.ok(await waitForGate(gate, job), 'the gated scene never started rendering');
      const before = listCache(proj.partsRoot);                 // scene a may already be committed
      controller.abort(new Error('user cancel'));
      await assert.rejects(job, e => /user cancel/.test(String(e?.message)));
      await sleep(800);                                          // let every child process wind down
      assert.equal(liveChromeCount(), 0, 'a Chrome process survived the cancel');
      assert.equal(liveProcessCount(), 0, 'an ffmpeg/ffprobe process survived the cancel');
      assert.ok(!existsSync(out + '.part'), 'a .part file was left behind');
      assert.ok(!existsSync(out), 'no output may exist after a cancel');
      const after = listCache(proj.partsRoot);
      assert.deepEqual(after, before, 'the cancel added or removed cache files');
      assert.ok(!after.some(f => f.endsWith('.new')), 'an unfinished manifest temp file was left behind');
      assert.equal(after.filter(f => f.endsWith('.mp4')).length, after.filter(f => f.endsWith('.json')).length,
        'an mp4 without its manifest (or vice versa) was registered');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  await gate.close();
});

test('a render after a cancel reuses the finished part and renders the missing ones, with no stale .part', { timeout: 420000 }, async () => {
  const gate = gateServer();
  const port = await gate.start();
  await withFlakeRetries(async () => {
    gate.reset();
    const dir = mkdtempSync(join(tmpdir(), 'motlab-resume-'));
    const proj = makeProject(dir);
    try {
      flatScene(dir, 'a.html', '#08f');
      gatedScene(dir, 'b.html', port);
      flatScene(dir, 'c.html', '#0f8');
      writeFileSync(join(dir, 'project.json'), JSON.stringify({
        fps: 24, scenes: ['a.html', { file: 'b.html', transition: { type: 'fade', duration: 0.5 } }, 'c.html'],
      }));
      const out = join(dir, 'video.mp4');
      // 1) cancel once scene a has finished and scene b is parked
      const controller = new AbortController();
      const first = proj.run({ out, scale: 1, parallel: 2, signal: controller.signal });
      assert.ok(await waitForGate(gate, first), 'the gated scene never started rendering');
      controller.abort(new Error('user cancel'));
      await assert.rejects(first);
      gate.release();
      const cachedKeys = listCache(proj.partsRoot).filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
      assert.ok(cachedKeys.length >= 1, 'the finished scene was not cached before the cancel');
      // 2) render again: scene a must come from the cache, the rest are rendered and the video is whole
      const logs = [];
      await proj.run({ out, scale: 1, parallel: 2, log: m => logs.push(m) });
      assert.ok(logs.some(l => l.includes('Scene 1/3: a.html (cached)')), logs.join('\n'));
      const v = await probeVideo(out);
      assert.equal(v.frames, 24 + 48 + 24 - 12);                 // a + b + c minus the 12-frame overlap
      assert.ok(Math.abs(v.duration - v.frames / 24) < 0.02);
      assert.ok(!existsSync(out + '.part'));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  await gate.close();
});

test('--only re-renders the chosen scene and the adjacent transition, and takes every other part from the cache', { timeout: 420000 }, async () => {
  await withFlakeRetries(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'motlab-only-'));
    const proj = makeProject(dir);
    try {
      ['a.html', 'b.html', 'c.html'].forEach((n, i) => flatScene(dir, n, ['#000', '#fff', '#f00'][i], 2));
      const fade = { type: 'fade', duration: 0.5, ease: 'linear' };
      writeFileSync(join(dir, 'project.json'), JSON.stringify({
        fps: 30, scenes: ['a.html', { file: 'b.html', transition: fade }, { file: 'c.html', transition: fade }],
      }));
      await proj.run({ out: join(dir, 'full.mp4'), scale: 1, parallel: 2 });
      const snapshot = listCache(proj.partsRoot);
      // change only scene b, then re-render scene 2
      flatScene(dir, 'b.html', '#00f', 2);
      const logs = [];
      await proj.run({ out: join(dir, 'only.mp4'), scale: 1, only: [2], parallel: 2, log: m => logs.push(m) });
      const seen = logs.join('\n');
      assert.ok(seen.includes('Scene 1/3: a.html (cached)'), seen);
      assert.ok(seen.includes('Scene 3/3: c.html (cached)'), seen);
      assert.ok(!seen.includes('Scene 2/3: b.html (cached)'), 'the selected scene must render again');
      assert.ok(!seen.includes('Transition 1 to 2: fade, 15 frames (cached)'), 'the transition into scene 2 must render again');
      assert.ok(!seen.includes('Transition 2 to 3: fade, 15 frames (cached)'), 'the transition out of scene 2 must render again');
      assert.ok(!existsSync(join(dir, 'only.mp4.part')));
      const v = await probeVideo(join(dir, 'only.mp4'));
      assert.equal(v.frames, 150);                              // three 60-frame scenes, two 15-frame overlaps
      // the untouched scene parts kept their cache files; the edited ones were replaced
      const now = listCache(proj.partsRoot);
      assert.equal(now.filter(f => f.endsWith('.mp4')).length, 5);
      assert.ok(snapshot.some(f => now.includes(f)), 'an untouched cached part was rebuilt');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

test('a cached part whose encoder or colour range no longer matches the first part is rendered again, not joined', { timeout: 420000 }, async () => {
  await withFlakeRetries(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'motlab-mismatch-'));
    const proj = makeProject(dir);
    try {
      ['a.html', 'b.html'].forEach((n, i) => flatScene(dir, n, ['#000', '#fff'][i]));
      writeFileSync(join(dir, 'project.json'), JSON.stringify({ fps: 30, scenes: ['a.html', 'b.html'] }));
      await proj.run({ out: join(dir, 'full.mp4'), scale: 1 });
      // Corrupt scene b's manifest so its encoder and colour range disagree with scene a: the cache must reject it.
      // Pick the manifests by re-deriving each scene's key the same way the engine does, not by directory order.
      const { createHash } = await import('node:crypto');
      const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
      const keyOf = file => createHash('sha256').update(JSON.stringify({
        kind: 'scene', file, hash: createHash('sha256').update(readFileSync(join(dir, file))).digest('hex'),
        fps: 30, scale: 1, qp: undefined, codec: undefined, version: VERSION, head: 0, tail: 0,
      })).digest('hex');
      const dir2 = partDirOf(proj.partsRoot);
      const sceneA = JSON.parse(readFileSync(join(dir2, keyOf('a.html') + '.json'), 'utf8'));
      const bManifest = keyOf('b.html') + '.json';
      const m = JSON.parse(readFileSync(join(dir2, bManifest), 'utf8'));
      m.hw = !sceneA.hw;                                        // flip the encoder kind
      m.fullRange = !sceneA.fullRange;                          // and the colour range
      writeFileSync(join(dir2, bManifest), JSON.stringify(m));
      const logs = [];
      await proj.run({ out: join(dir, 'again.mp4'), scale: 1, log: l => logs.push(l) });
      const seen = logs.join('\n');
      assert.ok(seen.includes('Scene 2/2: b.html (no cached part, rendering it)'), seen);
      assert.ok(seen.includes('Scene 1/2: a.html (cached)'), seen);
      assert.equal((await probeVideo(join(dir, 'again.mp4'))).frames, 60);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
