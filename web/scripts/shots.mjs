// Screenshots of recorded sessions, for looking at the interface without an
// engine or a GPU (`make web-shots`). Runs inside the Playwright Docker image:
// starts a Vite dev server, opens each shot in headless Chromium, drives it
// (seek, tabs, a pinned token) and writes a PNG.
//
//   SHOTS      JSON array of shots; default: one tour of the sample sessions.
//   SHOTS_OUT  output folder, relative to web/ (default .shots).
//
// A shot: { name, session?, live?, frames?, drop?, hub?, at?, dock?, inspector?, pin?, hover?, tabs?, fill?,
//           click?, press?, move?, tips?, w?, h?, wait? }
//   session    file under sessions/samples/, or "gallery" for the gallery of
//              the static site (needs VITE_ILS_STATIC=1 in the environment)
//   live       instead of a session: the page goes live and a stand-in for
//              the engine's /ws sends these events (the name of a set in
//              shots-models.mjs, e.g. "NO_MODEL"); no frames, no engine
//   frames     with live: a file under sessions/samples/ whose frames the
//              stand-in sends first, as the engine does on connecting
//   drop       with live: ms after connecting when the stand-in closes the
//              socket and refuses every reconnection (connection lost)
//   hub        true: the Hugging Face API answers with the fixtures of
//              shots-models.mjs instead of the network
//   tabs       names of tabs to click, in order (before `fill` and `click`)
//   fill       [[label, text], …]: fields to type into (by their label)
//   at         0..1, where in the recording to stop (default 0.6)
//   dock       "Timeline" | "Layers" | "Relief 3D"
//   inspector  "Candidates" | "Compare"
//   pin        index of the generated token to click (pins the selection)
//   hover      index of the generated token to leave the pointer on
//   click      names of buttons to click, in order (e.g. ["Samplers"])
//   press      keys to press, in order (e.g. ["?"])
//   move       [x, y] where to leave the pointer (after everything else)
//   tips       true: leave the first-visit tips on (off by default)
//   w, h       viewport (default 1600 × 1000); wait: ms before the shot
//   perf       ms of animation frames to time before the shot (logged)

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import * as FIXTURES from './shots-models.mjs';

const require = createRequire(process.env.PLAYWRIGHT_FROM ?? '/tmp/pw/');
const { chromium } = require('playwright');

const PORT = 5199;
const BASE = `http://127.0.0.1:${PORT}/`;
const out = resolve(process.env.SHOTS_OUT ?? '.shots');

const DEFAULT = [
  { name: 'two-models', session: 'qwen3.5-4b-q2-vs-q8.ils', at: 0.7 },
  { name: 'compare', session: 'qwen3.5-4b-q2-vs-q8.ils', at: 0.7, inspector: 'Compare', pin: 40 },
  { name: 'gates', session: 'qwen3.5-4b-q2-vs-q8-gates.ils', at: 0.6, pin: 30 },
  { name: 'branches', session: 'qwen3.5-4b-q2-vs-q8-branches.ils', at: 1 },
  { name: 'layers', session: 'qwen3.5-2b-q2-vs-q8-lens.ils', at: 0.5, dock: 'Layers', pin: 60 },
  { name: 'relief', session: 'qwen3.5-2b-q2-vs-q8-lens.ils', at: 0.5, dock: 'Relief 3D' },
  { name: 'single', session: 'qwen3.5-2b-q2-chat.ils', at: 0.8 },
  { name: 'narrow', session: 'qwen3.5-4b-q2-vs-q8.ils', at: 0.7, w: 1000, h: 900 },
  // The Models panel, live against a stand-in engine with no model loaded.
  {
    name: 'models-local',
    live: 'NO_MODEL',
    click: ['Use Qwen3.5-2B-Q8_0.gguf as A', 'Use Qwen3.5-2B-UD-Q2_K_XL.gguf as B'],
  },
  {
    name: 'models-hub',
    live: 'NO_MODEL',
    hub: true,
    tabs: ['Hugging Face'],
    fill: [['Search Hugging Face', 'qwen3.5']],
    click: ['Search', 'unsloth/Qwen3.5-0.8B-GGUF', 'Pick Qwen3.5-0.8B-Q4_K_M.gguf', 'Pick Qwen3.5-0.8B-Q8_0.gguf'],
  },
  { name: 'models-closed', live: 'NO_MODEL', press: ['Escape'] },
  // Live with two models, then the engine goes away: the lost-connection strip.
  { name: 'lost', live: 'PAUSED', frames: 'qwen3.5-4b-q2-vs-q8.ils', drop: 400, wait: 1800 },
];
const shots = process.env.SHOTS ? JSON.parse(process.env.SHOTS) : DEFAULT;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer() {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(BASE)).ok) return;
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  throw new Error('the Vite dev server did not start');
}

const vite = spawn(
  'npx',
  ['vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
  { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, ILS_VITE_CACHE: '/tmp/vite-cache' } },
);

let failed = false;
try {
  await waitForServer();
  mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  for (const s of shots) {
    const page = await browser.newPage({ viewport: { width: s.w ?? 1600, height: s.h ?? 1000 } });
    page.on('pageerror', (e) => {
      failed = true;
      console.error(`[${s.name}] page error: ${e.message}`);
    });
    page.on('console', (m) => {
      if (m.type() === 'error') console.error(`[${s.name}] console: ${m.text()}`);
    });
    // The first-visit tips would sit over the Stream in every shot.
    if (!s.tips) await page.addInitScript(() => localStorage.setItem('inside-llm.hints', 'hover,branch,pin,relief'));
    if (s.live) {
      const events = FIXTURES[s.live];
      if (!events) throw new Error(`[${s.name}] no fixture set "${s.live}" in shots-models.mjs`);
      // A recorded session's frames, sent as one binary message (an .ils
      // file is the gzip of the frames the engine sends).
      const frames = s.frames ? gunzipSync(readFileSync(resolve('../sessions/samples', s.frames))) : null;
      let connections = 0;
      // The page's WebSocket opens against this stand-in, not the network.
      await page.routeWebSocket(/\/ws$/, async (ws) => {
        // After a drop, every reconnection is refused: closed before it opens.
        if (s.drop !== undefined && connections++ > 0) {
          await ws.close();
          return;
        }
        if (frames) ws.send(frames);
        for (const e of events) ws.send(JSON.stringify(e));
        ws.onMessage((m) => console.log(`[${s.name}] command: ${m}`));
        if (s.drop !== undefined) setTimeout(() => void ws.close().catch(() => {}), s.drop);
      });
    }
    if (s.hub) {
      await page.route('https://huggingface.co/api/**', (route) => {
        const tree = route.request().url().includes('/tree/');
        return route.fulfill({ json: tree ? FIXTURES.HUB_TREE : FIXTURES.HUB_SEARCH });
      });
    }
    const gallery = s.session === 'gallery';
    await page.goto(s.live ? BASE : gallery ? BASE : `${BASE}?session=sessions/samples/${s.session}`);
    if (s.live) {
      await page.mouse.move(2, 2);
    } else if (!gallery) {
      const scrub = page.locator('input[type=range]').first();
      await scrub.waitFor();
      await page.waitForFunction(() => Number(document.querySelector('input[type=range]')?.max) > 0);
      // Pause, then jump: the page shows the state at that time and stays there.
      await page.keyboard.press('Space');
      // The jump sometimes lands before the player is ready: check and retry.
      const at = s.at ?? 0.6;
      for (let tries = 0; tries < 6; tries++) {
        const ok = await scrub.evaluate((el, at) => {
          const want = Math.round(Number(el.max) * at);
          if (Math.abs(Number(el.value) - want) <= Math.max(300, Number(el.max) * 0.02)) return true;
          el.value = String(want);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          return false;
        }, at);
        if (ok) break;
        await sleep(350);
      }
      await sleep(400);
      for (const tab of [s.inspector, s.dock]) {
        if (tab) await page.getByRole('tab', { name: tab }).click();
      }
      const tokens = page.locator('.stream [data-g]:visible'); // a newline token has no box
      // A token that wraps has a box with holes: aim at its first fragment.
      const point = async (i) => {
        if ((await tokens.count()) <= i) return null;
        const t = tokens.nth(i);
        await t.scrollIntoViewIfNeeded();
        return t.evaluate((el) => {
          const r = el.getClientRects()[0];
          return { x: r.left + Math.min(4, r.width / 2), y: r.top + r.height / 2 };
        });
      };
      const pin = s.pin !== undefined ? await point(s.pin) : null;
      if (pin) await page.mouse.click(pin.x, pin.y);
      const hover = s.hover !== undefined ? await point(s.hover) : null;
      if (hover) await page.mouse.move(hover.x, hover.y);
      else await page.mouse.move(2, 2);
    }
    for (const name of s.tabs ?? []) await page.getByRole('tab', { name }).click();
    for (const [label, text] of s.fill ?? []) await page.getByLabel(label).fill(text);
    for (const name of s.click ?? []) {
      await page.getByRole('button', { name }).first().click();
      await sleep(150); // a fixture request answers on the next tick
    }
    for (const key of s.press ?? []) await page.keyboard.press(key);
    if (s.move) await page.mouse.move(s.move[0], s.move[1]);
    await sleep(s.wait ?? (s.dock === 'Relief 3D' ? 2500 : 900));
    // perf: ms of animation frames to time (mean and p95 interval). In the
    // software renderer of this image, only a comparison between two builds
    // means something, not the figures themselves.
    if (s.perf) {
      const r = await page.evaluate(
        (ms) =>
          new Promise((done) => {
            const t = [];
            let last = performance.now();
            const end = last + ms;
            const step = (now) => {
              t.push(now - last);
              last = now;
              if (now < end) return requestAnimationFrame(step);
              t.sort((a, b) => a - b);
              const mean = t.reduce((a, b) => a + b, 0) / t.length;
              done({ frames: t.length, mean: +mean.toFixed(2), p95: +t[Math.floor(t.length * 0.95)].toFixed(2) });
            };
            requestAnimationFrame(step);
          }),
        s.perf,
      );
      console.log(`[${s.name}] frame ms ${JSON.stringify(r)}`);
    }
    await page.screenshot({ path: resolve(out, `${s.name}.png`) });
    console.log(`${s.name}.png`);
    await page.close();
  }
  await browser.close();
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  vite.kill();
}
process.exit(failed ? 1 : 0);
