// Source-switch races and destroy(): a late event from a previous source must not rewrite the element's state,
// and a destroyed element is terminal — idempotent, silent, and safe to keep poking.

import assert from "node:assert/strict";

const contexts = [];
globalThis.migo = {
  getWindowInfo: () => ({ windowWidth: 390, windowHeight: 844, screenWidth: 390, screenHeight: 844, pixelRatio: 3 }),
  getSystemInfoSync: () => ({ platform: "android", system: "Android 14", language: "en", version: "1.0.0", screenWidth: 390, screenHeight: 844, pixelRatio: 3 }),
  onWindowResize: () => {},
  createImage: () => ({}),
  createCanvas: () => ({ width: 0, height: 0, getContext: () => ({}), toDataURL: () => "data:," }),
  onTouchStart: () => {}, onTouchMove: () => {}, onTouchEnd: () => {}, onTouchCancel: () => {},
  createInnerAudioContext: () => {
    const ctx = {
      src: "", loop: false, volume: 1, autoplay: false, currentTime: 0, duration: 0.25, paused: true, playbackRate: 1, handlers: {}, destroyCount: 0,
      onCanplay(cb) { this.handlers.canplay = cb; }, onPlay(cb) { this.handlers.play = cb; }, onPause(cb) { this.handlers.pause = cb; },
      onEnded(cb) { this.handlers.ended = cb; }, onError(cb) { this.handlers.error = cb; }, onTimeUpdate(cb) { this.handlers.timeupdate = cb; },
      onSeeked(cb) { this.handlers.seeked = cb; }, onWaiting(cb) { this.handlers.waiting = cb; },
      play() { this.paused = false; queueMicrotask(() => this.handlers.play()); }, pause() { this.paused = true; queueMicrotask(() => this.handlers.pause()); },
      seek() {}, destroy() { this.destroyCount += 1; },
    };
    contexts.push(ctx);
    return ctx;
  },
};
await import("../src/index.js");
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const watch = (audio) => {
  const seen = [];
  for (const type of ["loadstart", "durationchange", "loadedmetadata", "loadeddata", "canplay", "canplaythrough", "play", "playing", "pause", "ended", "error", "timeupdate", "seeked", "waiting"]) {
    audio.addEventListener(type, () => seen.push(type));
  }
  return seen;
};

// --- Switching sources while playing: the old source's late events must not touch the new source. ---
{
  const audio = new globalThis.Audio("assets/old.wav");
  const ctx = contexts.at(-1);
  const seen = watch(audio);
  await flush();
  assert.deepEqual(seen, ["loadstart"]);
  ctx.handlers.canplay();
  audio.play();
  await flush();
  assert.equal(audio.paused, false);
  assert.equal(audio.readyState, 4);

  // Capture the old source's callbacks, then switch. The runtime may still deliver them.
  const stale = { ...ctx.handlers };
  audio.src = "assets/new.wav";
  assert.equal(audio.readyState, 0, "a new source resets readyState");
  assert.equal(audio.paused, true, "a new source stops the element");
  assert.equal(audio.ended, false);
  assert.equal(audio.error, null);
  seen.length = 0;
  await flush();
  assert.deepEqual(seen, ["loadstart"], "the new source starts its own load sequence");

  stale.canplay();
  stale.play();
  stale.pause();
  stale.ended();
  stale.error({ errMsg: "stale failure" });
  stale.timeupdate();
  assert.equal(audio.readyState, 0, "a late canplay from the old source is dropped");
  assert.equal(audio.paused, true, "a late play from the old source is dropped");
  assert.equal(audio.ended, false, "a late ended from the old source is dropped");
  assert.equal(audio.error, null, "a late error from the old source is dropped");
  assert.deepEqual(seen, ["loadstart"], "stale events fire nothing on the element");

  // The new source still walks the normal sequence.
  ctx.handlers.canplay();
  assert.equal(audio.readyState, 4);
  assert.deepEqual(seen, ["loadstart", "durationchange", "loadedmetadata", "loadeddata", "canplay", "canplaythrough"]);
  audio.destroy();
}

// --- Switching sources before loadstart settles: only the newest source announces itself. ---
{
  const audio = new globalThis.Audio();
  const seen = watch(audio);
  audio.src = "assets/one.wav";
  audio.src = "assets/two.wav";
  await flush();
  assert.deepEqual(seen, ["loadstart"], "the superseded source's pending loadstart is dropped");
  assert.equal(audio.src, "assets/two.wav");
  audio.destroy();
}

// --- destroy(): idempotent, terminal, and quiet. ---
{
  const audio = new globalThis.Audio("assets/tone.wav");
  const ctx = contexts.at(-1);
  const seen = watch(audio);
  await flush();
  ctx.handlers.canplay();
  audio.play();
  await flush();
  assert.equal(audio.paused, false);
  seen.length = 0;

  audio.destroy();
  assert.equal(ctx.destroyCount, 1, "the underlying context is released once");
  audio.destroy();
  audio.destroy();
  assert.equal(ctx.destroyCount, 1, "repeated destroy() does not release again");

  // Events the runtime still delivers after destroy are dropped.
  ctx.handlers.play();
  ctx.handlers.pause();
  ctx.handlers.ended();
  ctx.handlers.canplay();
  ctx.handlers.error({ errMsg: "late failure" });
  await flush();
  assert.deepEqual(seen, [], "a destroyed element dispatches nothing");
  assert.equal(audio.ended, false, "state is frozen too");
  assert.equal(audio.error, null);

  // Operations after destroy are defined no-ops, not exceptions.
  await audio.play(); // still a promise, resolves without touching the context
  assert.equal(audio.paused, false, "play() after destroy changes nothing (state was left as it was)");
  audio.pause();
  audio.src = "assets/after-destroy.wav";
  await flush();
  assert.equal(audio.src, "assets/tone.wav", "src assignment after destroy is ignored");
  assert.deepEqual(seen, [], "and fires no loadstart");
}

// --- destroy() before the load sequence settles: the pending loadstart never fires. ---
{
  const audio = new globalThis.Audio("assets/pending.wav");
  const seen = watch(audio);
  audio.destroy();
  await flush();
  assert.deepEqual(seen, [], "no loadstart once destroyed");
}

console.log("audio-lifecycle tests: all passed");
