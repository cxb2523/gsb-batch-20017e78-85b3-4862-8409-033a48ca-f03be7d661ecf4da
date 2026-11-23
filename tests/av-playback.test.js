import test from 'node:test';
import assert from 'node:assert/strict';
import { AVPlayback, RETAIN_SECONDS, SAFETY_BUFFER, GAP_TOLERANCE } from '../av-playback.js';

function fixture() {
  let head = 40, start = 0, removed;
  const video = { currentTime: 9.25, readyState: 4, paused: false,
    addEventListener() {}, removeEventListener() {}, pause() { this.paused = true; },
    async play() { this.paused = false; }, removeAttribute() {}, load() {} };
  let status, error;
  const player = new AVPlayback(video, { onStatus: s => { status = s; }, onError: e => { error = e; } });
  player.mediaSource = { readyState: 'open' };
  player.buffer = { updating: false, buffered: { length: 1, start: () => start, end: () => head },
    remove: (a, b) => { removed = [a, b]; }, appendBuffer() {} };
  player.started = true;
  return { player, video, head: h => { head = h; }, start: s => { start = s; },
    status: () => status, error: () => error, removed: () => removed };
}

test('MSE startup registers sourceopen before explicitly loading the extension video', async () => {
  const original = { MediaSource: globalThis.MediaSource, create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  let loads = 0;
  globalThis.MediaSource = class extends EventTarget {
    static isTypeSupported() { return true; }
    addSourceBuffer() { return new EventTarget(); }
  };
  URL.createObjectURL = () => 'blob:extension-test';
  URL.revokeObjectURL = () => {};
  const video = { addEventListener() {}, removeEventListener() {}, pause() {}, removeAttribute() {},
    load() { loads++; player.mediaSource.dispatchEvent(new Event('sourceopen')); } };
  const player = new AVPlayback(video);
  try {
    await player.configure('video/mp4', 30);
    assert.equal(loads, 1);
    assert.equal(video.src, 'blob:extension-test');
    assert.ok(player.buffer);
  } finally {
    player.close();
    globalThis.MediaSource = original.MediaSource;
    URL.createObjectURL = original.create;
    URL.revokeObjectURL = original.revoke;
  }
});

test('A/V increase holds both tracks; further changes recalculate remaining wait', async () => {
  const f = fixture();
  f.player.setDelay(35);
  assert.equal(f.video.paused, true);
  assert.equal(f.video.currentTime, 9.25);
  assert.equal(f.status().pauseRemaining, 5);
  f.head(42); f.player.tick();
  assert.equal(f.status().pauseRemaining, 3);
  f.player.setDelay(36);
  assert.equal(f.status().pauseRemaining, 4);
  f.head(46); f.player.tick();
  await Promise.resolve();
  assert.equal(f.video.paused, false);
  assert.equal(f.status().pauseRemaining, 0);
  assert.equal(f.video.currentTime, 9.25);
  f.player.close();
});

test('A/V decrease cancels wait and seeks only the extension output, including zero delay', () => {
  const f = fixture();
  f.player.setDelay(35); f.head(42);
  f.player.setDelay(30);
  assert.equal(f.video.currentTime, 42 - 30 - SAFETY_BUFFER);
  assert.equal(f.player.adjusting, false);
  f.player.setDelay(0);
  assert.equal(f.video.currentTime, 42 - SAFETY_BUFFER);
  f.player.close();
});

test('a tenth-second increase resumes from the deadline between playback ticks', t => {
  const f = fixture();
  let now = 40, resume, wait;
  f.player.origin = 0;
  f.player.liveTime = () => now;
  t.mock.method(globalThis, 'setTimeout', (callback, ms) => {
    resume = callback; wait = ms;
    return 1;
  });
  f.player.setDelay(30.1);
  assert.equal(f.video.paused, true);
  assert.ok(wait >= 99 && wait <= 101);
  now += 0.1;
  resume();
  assert.equal(f.video.paused, false);
  assert.equal(f.video.currentTime, 9.25);
  f.player.close();
});

test('old buffered data is trimmed as playback advances', () => {
  const f = fixture();
  f.head(160); f.video.currentTime = 129.25;
  f.player.pump();
  assert.deepEqual(f.removed(), [0, 160 - (30 + SAFETY_BUFFER + 6)]);
  f.player.close();
});

test('a sequence gap within tolerance waits, recovers on resync, and never re-appends stale data', () => {
  const f = fixture();
  f.head(35); // Keep the trim branch out of the append path.
  const appended = [];
  f.player.buffer.appendBuffer = bytes => appended.push(bytes[0]);
  f.player.append(Uint8Array.of(1), 0);
  assert.deepEqual(appended, [1]);
  // Fragments 1-2 went missing: hold fragment 3 and wait instead of failing.
  f.player.append(Uint8Array.of(4), 3);
  assert.equal(f.player.closed, false);
  assert.equal(f.error(), undefined);
  assert.ok(f.player.gap);
  assert.deepEqual(appended, [1]); // The jumped-ahead fragment is held, not appended.
  assert.equal(f.status().phase, 'interrupted');
  assert.ok(f.status().gapRemaining > GAP_TOLERANCE - 1 && f.status().gapRemaining <= GAP_TOLERANCE);
  assert.match(f.status().notice, /不会操作原网页播放器/);
  // The capture side resumes past the gap: held fresh fragments append exactly once.
  f.player.append(Uint8Array.of(5), 4);
  assert.equal(f.player.gap, null);
  assert.deepEqual(appended, [1, 4, 5]);
  assert.equal(f.player.sequence, 5);
  // Stale replays of old fragments are ignored, never appended a second time.
  f.player.append(Uint8Array.of(3), 2);
  f.player.append(Uint8Array.of(5), 4);
  assert.deepEqual(appended, [1, 4, 5]);
  assert.equal(f.player.sequence, 5);
  // Continuous flow resumes normally.
  f.player.append(Uint8Array.of(6), 5);
  assert.deepEqual(appended, [1, 4, 5, 6]);
  f.player.close();
});

test('the missing fragment itself heals a gap without resync or duplicate appends', () => {
  const f = fixture();
  f.head(35);
  const appended = [];
  f.player.buffer.appendBuffer = bytes => appended.push(bytes[0]);
  f.player.append(Uint8Array.of(1), 0);
  f.player.append(Uint8Array.of(4), 3);
  assert.ok(f.player.gap);
  f.player.append(Uint8Array.of(2), 1); // Late but still useful: fills the hole.
  assert.ok(f.player.gap); // Fragment 2 is still missing.
  f.player.append(Uint8Array.of(3), 2);
  assert.equal(f.player.gap, null);
  assert.deepEqual(appended, [1, 2, 3, 4]);
  assert.equal(f.player.sequence, 4);
  f.player.close();
});

test('a sequence gap outlasting the tolerance stops safely and releases', () => {
  const f = fixture();
  f.head(35);
  const appended = [];
  f.player.buffer.appendBuffer = bytes => appended.push(bytes[0]);
  f.player.append(Uint8Array.of(1), 0);
  f.player.append(Uint8Array.of(6), 5);
  assert.equal(f.player.closed, false);
  assert.ok(f.player.gap);
  // Inside the tolerance the player keeps waiting with its buffer intact.
  f.player.gap.since = performance.now() - (GAP_TOLERANCE - 1) * 1000;
  f.player.tick();
  assert.equal(f.player.closed, false);
  assert.equal(f.status().phase, 'interrupted');
  assert.ok(f.status().gapRemaining > 0);
  assert.equal(f.status().bufferedSeconds, 35);
  // Past the tolerance: safe stop, queues and timers released.
  f.player.gap.since = performance.now() - (GAP_TOLERANCE + 1) * 1000;
  f.player.tick();
  assert.equal(f.player.closed, true);
  assert.match(f.error(), /安全停止/);
  assert.equal(f.video.paused, true);
  assert.equal(f.player.queue.length, 0);
  assert.equal(f.player.queuedBytes, 0);
  assert.equal(f.player.gap, null);
  // Late fragments after the stop are dropped, not appended.
  f.player.append(Uint8Array.of(7), 6);
  assert.deepEqual(appended, [1]);
});

test('increasing delay during a stream outage counts down on the live clock and never rolls back after resume', () => {
  const f = fixture();
  let time = 100;
  f.player.origin = 0;
  f.player.liveTime = () => time;
  f.video.currentTime = 69.25; // Exactly delay 30 + SAFETY_BUFFER behind live.
  f.head(75); f.start(40); // Buffer froze mid-outage behind the live clock.
  f.player.buffer.updating = true; // Fragments queue while the outage lasts.
  f.player.append(new ArrayBuffer(1), 0);
  f.player.append(new ArrayBuffer(1), 3); // Outage: fragments 1-2 missing.
  assert.ok(f.player.gap);
  // Increasing the delay mid-outage pauses and counts down on the live clock.
  f.player.setDelay(40);
  assert.equal(f.video.paused, true);
  assert.equal(f.player.adjusting, true);
  assert.equal(f.status().phase, 'interrupted');
  assert.equal(f.status().pauseRemaining, 10);
  assert.equal(f.status().actualDelay, 30.75);
  assert.equal(f.status().bufferedSeconds, 35); // Buffered content is kept.
  time += 4; f.player.tick();
  assert.equal(f.status().pauseRemaining, 6);
  assert.equal(f.video.currentTime, 69.25); // Still holding the paused position.
  // The capture side resumes past the gap; new data extends the buffer.
  f.player.append(new ArrayBuffer(1), 4);
  assert.equal(f.player.gap, null);
  f.player.buffer.updating = false;
  f.head(110);
  time += 5; f.player.tick();
  assert.equal(f.status().pauseRemaining, 1);
  assert.equal(f.video.currentTime, 69.25); // No rollback into played content.
  time += 1; f.player.tick();
  assert.equal(f.player.adjusting, false);
  assert.equal(f.video.paused, false);
  assert.equal(f.video.currentTime, 69.25);
  assert.equal(f.status().actualDelay, 40.75); // Live clock and delay agree again.
  f.player.close();
});

test('decreasing delay during a stream outage jumps to the new target; resume continues forward', () => {
  const f = fixture();
  let time = 100;
  f.player.origin = 0;
  f.player.liveTime = () => time;
  f.video.currentTime = 69.25;
  f.head(75); f.start(40);
  f.player.buffer.updating = true;
  f.player.append(new ArrayBuffer(1), 0);
  f.player.append(new ArrayBuffer(1), 3);
  assert.ok(f.player.gap);
  f.player.setDelay(10);
  // Jumps to the new target on the live clock, clamped to the frozen buffer.
  assert.equal(f.video.currentTime, 75 - 0.15);
  assert.equal(f.player.adjusting, false);
  // The capture side resumes; the buffer extends and the position moves
  // forward to the delay target, never backward.
  f.player.append(new ArrayBuffer(1), 4);
  assert.equal(f.player.gap, null);
  f.player.buffer.updating = false;
  f.head(110);
  f.player.tick();
  assert.equal(f.video.currentTime, 100 - 10 - SAFETY_BUFFER);
  assert.equal(f.video.paused, false);
  assert.equal(f.status().actualDelay, 10 + SAFETY_BUFFER);
  f.player.close();
});

test('a new MIME is applied in append order while buffered video keeps playing', () => {
  const { player, video, head } = fixture();
  head(35);
  const calls = [];
  const buffer = player.buffer;
  buffer.appendBuffer = bytes => { calls.push(bytes[0]); buffer.updating = true; };
  buffer.changeType = mime => calls.push(mime);
  player.mime = 'old';
  buffer.updating = true;
  player.append(Uint8Array.of(1), 0);
  player.append(Uint8Array.of(2), 1, 'new');
  player.append(Uint8Array.of(3), 2);
  assert.deepEqual(calls, []);
  for (let i = 0; i < 3; i++) { buffer.updating = false; player.pump(); }
  assert.deepEqual(calls, [1, 'new', 2, 3]);
  assert.equal(video.paused, false);
  assert.equal(video.currentTime, 9.25);
  player.close();
});

test('adjustments use the live clock even when encoded chunks arrive late', () => {
  const f = fixture();
  let time = 41;
  f.player.liveTime = () => time;
  f.video.currentTime = 10.25;
  f.player.setDelay(35);
  assert.equal(f.status().pauseRemaining, 5);
  time += 2; f.player.tick(); // No new encoded chunk arrived.
  assert.equal(f.status().pauseRemaining, 3);
  f.player.setDelay(30);
  assert.equal(f.video.currentTime, 12.25);
  f.player.close();
});

test('high bitrate fragments retain bounded queues; quota recovery retries the same chunk after reclaiming played history', () => {
  const f = fixture();
  const bytes = new ArrayBuffer(20 * 1024 * 1024);
  f.player.maxQueuedBytes = 32 * 1024 * 1024;
  f.player.buffer.updating = true;
  f.player.append(bytes, 0);
  assert.equal(f.player.closed, false);
  f.player.buffer.updating = false;
  f.head(35); f.video.currentTime = 20;
  let attempts = 0;
  f.player.buffer.appendBuffer = data => {
    assert.equal(data, bytes);
    if (!attempts++) throw new DOMException('full', 'QuotaExceededError');
  };
  f.player.pump();
  assert.deepEqual(f.removed(), [0, 18.5]);
  assert.equal(f.player.queue[0].bytes, bytes);
  f.player.pump();
  assert.equal(f.player.queue.length, 0);
  assert.equal(f.player.queuedBytes, 0);
  f.player.close();
  const limited = fixture();
  limited.player.buffer.updating = true;
  limited.player.append(bytes, 0); // Default lower-bitrate budget remains bounded.
  assert.equal(limited.player.closed, true);
  const full = fixture();
  full.head(35); full.video.currentTime = 0;
  full.player.buffer.appendBuffer = () => { throw new DOMException('full', 'QuotaExceededError'); };
  full.player.append(new ArrayBuffer(1), 0);
  assert.equal(full.player.closed, true);
  assert.match(full.error(), /缓存已达到内存上限/);
});
