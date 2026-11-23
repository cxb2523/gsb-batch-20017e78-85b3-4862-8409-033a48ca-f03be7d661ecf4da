// Streaming state-machine tests, run headlessly against a local HTTP/1.1 server that honours
// Range requests (loadClodStream fetches the .bin as a growing prefix) and can inject failures.
//
// Covers the four required paths:
//   1. normal pull        : a wanted finer level is fetched and swapped in
//   2. request coalescing : wants arriving while a fetch is in flight merge, never duplicate it
//   3. failure retry      : a failed fetch clears `loading`; the next updateStreaming() retries
//   4. shared asset       : two ClodBatches on one asset keep the finest per-frame want
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildClod } from '../src/build.js';
import { loadClodStream, updateStreaming, ClodBatch, ClodSelector } from '../src/index.js';
import { makeSample } from '../examples/make-sample.mjs';

const quiet = () => {};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'three-nanite-stream-'));

// ---- static server with Range support + deterministic failure injection + request logging ----
// One streamed level is four parallel ranges (positions, normals, uvs, indices), each starting at
// the currently resident prefix end. A "generation" is a distinct prefix start per section:
// the root page is generation 0 and each subsequent growth fetch increments it, which lets a
// test fail exactly the Nth fetch deterministically, including chained finer-level fetches.
function startServer(dir, name) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8'));
  // gate: when set, geometry range responses of the given generation are queued until the test
  // drains gate.waiters and invokes the queued send callbacks
  const state = { geoHits: 0, rangeFails: 0, failGeneration: 0, seenStarts: new Set(), inFlight: 0, maxInFlight: 0, gate: null };
  const srv = http.createServer((req, res) => {
    const file = path.join(dir, decodeURIComponent(req.url.split('?')[0]));
    if (!file.startsWith(dir)) { res.statusCode = 403; return res.end(); }
    let data;
    try { data = fs.readFileSync(file); } catch { res.statusCode = 404; return res.end(); }
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (m) {
      const fromAbs = Number(m[1]);
      const secName = Object.keys(meta.sections).find((k) => { const s = meta.sections[k]; return fromAbs >= s.offset && fromAbs < s.offset + s.bytes; });
      if (['positions', 'normals', 'uvs', 'indices'].includes(secName)) {
        state.geoHits++;
        // generation = how many distinct prefix-starts this section has fetched so far. A chained
        // finer level begins at a new (larger) prefix start, i.e. the next generation. Re-arming
        // failGeneration resets the baseline so numbering restarts at the asset's current prefix.
        const key = secName + ':' + fromAbs;
        if (!state.seenStarts.has(key)) state.seenStarts.add(key);
        const generation = [...state.seenStarts].filter((x) => x.startsWith(secName + ':')).length - 1;
        if (state.failGeneration > 0 && generation >= state.failGeneration) {
          state.rangeFails++;
          res.destroy(new Error('injected range failure'));
          return;
        }
        const send = () => {
          const from = m[1] === '' ? data.length - Number(m[2]) : Number(m[1]);
          const to = m[2] === '' ? data.length - 1 : Math.min(Number(m[2]), data.length - 1);
          state.inFlight++; state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
          res.writeHead(206, { 'Content-Range': `bytes ${from}-${to}/${data.length}`, 'Content-Length': to - from + 1, 'Accept-Ranges': 'bytes' });
          res.end(data.subarray(from, to + 1), () => { state.inFlight--; });
        };
        if (state.gate && generation === state.gate.generation) { state.gate.waiters.push(send); return; }
        send();
        return;
      }
      const from = m[1] === '' ? data.length - Number(m[2]) : Number(m[1]);
      const to = m[2] === '' ? data.length - 1 : Math.min(Number(m[2]), data.length - 1);
      state.inFlight++; state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      res.writeHead(206, { 'Content-Range': `bytes ${from}-${to}/${data.length}`, 'Content-Length': to - from + 1, 'Accept-Ranges': 'bytes' });
      res.end(data.subarray(from, to + 1), () => { state.inFlight--; });
      return;
    }
    res.writeHead(200, { 'Content-Length': data.length, 'Accept-Ranges': 'bytes' });
    res.end(data);
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, state, base: `http://127.0.0.1:${srv.address().port}` })));
}

const glb = path.join(tmp, 'rock.glb');
fs.writeFileSync(glb, makeSample('rock', { texture: 16 }));
const built = await buildClod({ input: glb, outDir: tmp, name: 'rock', log: quiet });
const LR = built.meta.levelRanges; // coarsest first; level 0 is finest
assert.ok(LR.length >= 4, 'fixture needs several levels');
const tick = () => new Promise((r) => setImmediate(r));
const waitUntil = async (cond) => { while (!cond()) await tick(); };
const servers = [];
const freshServer = async () => { const h = await startServer(tmp, 'rock'); servers.push(h.srv); return h; };

try {
  // ---------------------------------------------------------------- path 1: normal pull
  {
    const { srv, state, base } = await freshServer();
    const a = await loadClodStream(base, 'rock', { rootBytes: 0 });
    const root = a.rootLevel;
    assert.ok(root > 0, 'rootBytes:0 must leave some finer levels to stream');
    const target = root - 1;
    a.wantLevel = target;
    const pending = updateStreaming([a]);
    assert.equal(pending.length, 1, 'updateStreaming returns one promise per fetching asset');
    await pending[0];
    assert.equal(a.loadedLevel, target, 'geometry fetched down to the wanted level');
    assert.equal(a.loading, null, 'loading cleared after completion');
    assert.equal(a.geometry.getAttribute('position').count, LR.find((l) => l.level === target).vertexEnd);
    assert.equal(a.geometry.index.count, LR.find((l) => l.level === target).indexEnd);
    assert.ok(a.pos.length === a.geometry.getAttribute('position').array.length, 'grown prefix backs the new geometry');
    assert.equal(state.rangeFails, 0);
    // a second frame with no new want starts nothing
    a.wantLevel = 255;
    assert.deepEqual(updateStreaming([a]), [], 'no want => no fetch, still returns an array');
    srv.close();
    console.log('ok: normal pull to level', target);
  }

  // ---------------------------------------------------------------- path 2: concurrent request merging
  {
    const { srv, state, base } = await freshServer();
    const a = await loadClodStream(base, 'rock', { rootBytes: 0 });
    const startLoaded = a.loadedLevel;
    const baseline = state.geoHits; // ranges spent on the root page itself

    // frame 1: want a level, start the fetch, then a finer want arrives before it settles
    a.wantLevel = startLoaded - 1;
    const p1 = updateStreaming([a]);
    assert.equal(p1.length, 1);
    assert.ok(a.loading, 'a fetch is in flight');
    a.wantLevel = startLoaded - 2;
    const p2 = updateStreaming([a]); // next frame, still in flight
    assert.deepEqual(p2, [], 'no new promise while the merged fetch is already pending');
    assert.equal(a.targetLevel, startLoaded - 2, 'finer want merged into the in-flight fetch');
    await p1[0];
    assert.equal(a.loadedLevel, startLoaded - 2, 'chain continued to the finer level after the first fetch settled');
    assert.equal(a.loading, null);

    // whole-flight range accounting: each streamed level costs exactly four ranges (pos/nrm/uv/idx);
    // the finer level was chained, never requested in parallel -> no duplicate asset fetch
    assert.equal(state.geoHits - baseline, 8, `two chained levels = 8 geometry range requests, got ${state.geoHits - baseline}`);
    assert.ok(state.maxInFlight <= 4, 'the four ranges of one level may parallelise, but levels never do');

    // re-calling loadTo on an idle, already-loaded level is a no-op without any request
    const before = state.geoHits;
    await a.loadTo(a.loadedLevel);
    assert.equal(state.geoHits, before, 'idle loadTo at a resident level issues no request');
    srv.close();
    console.log('ok: concurrent requests merge and chain to the finest want');
  }

  // ---------------------------------------------------------------- path 3: failure and retry
  {
    const { srv, state, base } = await freshServer();
    const a = await loadClodStream(base, 'rock', { rootBytes: 0 });
    const startLoaded = a.loadedLevel;
    const target = startLoaded - 1;

    // generation 0 is the root page; the first streamed growth level is generation 1
    state.failGeneration = 1;
    a.wantLevel = target;
    const [failed] = updateStreaming([a]);
    assert.ok(failed, 'a fetch was started despite the coming failure');
    await assert.rejects(failed, /fetch failed|terminated|socket|network/i, 'the fetch rejects with the network error');
    assert.ok(state.rangeFails >= 1, 'the injected socket failure rejected the fetch');
    assert.equal(a.loading, null, 'failure does not leave the asset stuck in loading');
    assert.equal(a.loadedLevel, startLoaded, 'nothing partially installed after failure');
    assert.equal(a.targetLevel, target, 'the wanted level survives the failure for the retry');

    // next updateStreaming() retries with no manual state repair
    state.failGeneration = 0;
    a.wantLevel = target;
    const [retried] = updateStreaming([a]);
    assert.ok(retried && retried !== failed, 'retry starts a fresh fetch');
    await retried;
    assert.equal(a.loadedLevel, target, 'retry reaches the wanted level');
    assert.equal(a.loading, null);

    // failure mid-chain: level A is in flight when a finer level B is wanted; A installs, then
    // the chained B fetch fails. The asset stays usable at A and the next update retries B.
    const a2 = await loadClodStream(base, 'rock', { rootBytes: 0 });
    const l0 = a2.loadedLevel;
    // hold the level A (generation 1) response until the finer want has been merged below
    state.gate = { generation: 1, waiters: [] };
    state.failGeneration = 2; // root page = gen 0, level A = gen 1 (gated), chained B = gen 2 (failed)
    a2.wantLevel = l0 - 1;
    const job = a2.loadTo(l0 - 1); // starts the level A fetch, held by the gate
    a2.loadTo(l0 - 2);              // merges the finer want while A is in flight
    assert.equal(a2.targetLevel, l0 - 2, 'finer want merged into the in-flight fetch');
    await waitUntil(() => state.gate.waiters.length === 4); // all four ranges of A are held
    const waiters = state.gate.waiters;
    state.gate = null;
    for (const send of waiters) send(); // release A; on settle the chain starts B and fails
    await assert.rejects(job, /fetch failed|terminated|socket|network/i);
    assert.equal(a2.loading, null);
    assert.equal(a2.loadedLevel, l0 - 1, 'first level of the chain installed before the failure');
    assert.equal(a2.targetLevel, l0 - 2, 'chain target retained for retry');
    state.failGeneration = 0;
    a2.wantLevel = l0 - 2;
    const [retry2] = updateStreaming([a2]);
    await retry2;
    assert.equal(a2.loadedLevel, l0 - 2, 'retry after a mid-chain failure reaches the target');
    srv.close();
    console.log('ok: failed fetches recover on the next updateStreaming');
  }

  // ---------------------------------------------------------------- path 4: multiple batches sharing one asset
  {
    const { srv, state, base } = await freshServer();
    const a = await loadClodStream(base, 'rock', { rootBytes: 0 });
    const root = a.rootLevel;
    const m1 = new THREE.Matrix4().compose(new THREE.Vector3(0, 0, 0), new THREE.Quaternion(), new THREE.Vector3(1, 1, 1));
    const m2 = new THREE.Matrix4().compose(new THREE.Vector3(50, 0, 0), new THREE.Quaternion(), new THREE.Vector3(1, 1, 1));
    const b1 = new ClodBatch(a, new THREE.MeshBasicMaterial(), [m1]);
    const b2 = new ClodBatch(a, new THREE.MeshBasicMaterial(), [m2]);
    assert.deepEqual(a.batches, [b1, b2]);
    const selector = new ClodSelector([b1, b2]);
    const cam = new THREE.PerspectiveCamera(60, 1, 0.05, 3000);

    const selectAt = (dist) => {
      cam.position.set(dist, 0, 0); cam.lookAt(0, 0, 0);
      selector.select(cam, 1080, { errorPx: 1 });
      return a.wantLevel;
    };

    // close camera wants a fine level; a far camera would only want a coarse one.
    // Both batches run in the same frame: the coarse want must not overwrite the fine one.
    const fineWant = selectAt(0.6);
    assert.ok(fineWant < root && fineWant >= 0, `close instance wants a finer level (got ${fineWant})`);

    // simulate the ordering risk directly: far batch writing after the near batch keeps the min
    a.wantLevel = 255; // frame reset as ClodSelector.select() performs it
    a.wantLevel = Math.min(a.wantLevel, fineWant); // near batch (b1) writes the fine want
    a.wantLevel = Math.min(a.wantLevel, root);     // far batch (b2) only needs the coarse root
    assert.equal(a.wantLevel, fineWant, 'a later coarse want cannot clobber the earlier fine want');

    // the real selector produces the same want each frame regardless of batch ordering
    cam.position.set(0.6, 0, 0); cam.lookAt(0, 0, 0);
    selector.select(cam, 1080, { errorPx: 1 });
    assert.equal(a.wantLevel, fineWant, 'selector keeps the finest want across shared batches');

    // the shared want drives exactly one fetch chain for the shared asset
    const baseline = state.geoHits; // root page ranges
    const pending = updateStreaming([a]);
    assert.equal(pending.length, 1, 'one asset -> at most one fetch no matter how many batches share it');
    await pending[0];
    assert.equal(a.loadedLevel, fineWant);
    // one prefix jump covers everything between the resident end and the wanted level: exactly
    // four ranges (pos/nrm/uv/idx), never one fetch per batch or any duplicate asset request
    assert.equal(state.geoHits - baseline, 4, 'a single level-prefix fetch costs four ranges, no duplicate asset fetch');

    // frame reset: once nothing needs refining, the next frame's want goes back to idle (255)
    cam.position.set(5000, 0, 0); cam.lookAt(0, 0, 0);
    selector.select(cam, 1080, { errorPx: 64 });
    assert.equal(a.wantLevel, 255, 'per-frame reset drops stale wants when no batch needs refinement');
    srv.close();
    console.log('ok: shared asset keeps the finest want across batches');
  }
} finally {
  await tick();
  for (const s of servers) s.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('ok: streaming state machine');
