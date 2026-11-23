// Local consistency check for the room radio. No browser, no network:
// a fake clock, localStorage, YouTube player and Durable Object are installed as
// globals, then the REAL src/radio.js and worker/index.js are exercised.
//
//   node scripts/check-radio-sync.mjs
//
// Paths covered:
//   1. track change - a stale ENDED / onError from the replaced video must not
//                     move the new command back to the old position
//   2. reconnect    - the server re-sends the current command with its clock;
//                     a device whose clock is 90 s off still lands on the room's second
//   3. phone unlock - the first touch after autoplay-muted joins the current second;
//                     desktop and phone pause/resume/unmute land on the same second
//   4. a command that arrives before the player is ready is applied afterwards
//   5. worker       - join always carries the server clock (even with no command),
//                     and a reconnect re-sends the stored command with a fresh `now`

import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RADIO_URL = pathToFileURL(path.join(ROOT, "src", "radio.js")).href;
const WORKER_URL = pathToFileURL(path.join(ROOT, "worker", "index.js")).href;

let passed = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
const near = (a, b, eps = 0.75) => Number.isFinite(a) && Math.abs(a - b) <= eps;

// ---------------------------------------------------------------------------
// fake platform
// ---------------------------------------------------------------------------
let fakeNow = 1_800_000_000_000; // the authoritative "server" clock
let moduleSeq = 0;

const YT_STATE = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };

class FakePlayer {
  constructor(el, cfg) {
    this.cfg = cfg;
    this.videoId = cfg.videoId;
    this.state = YT_STATE.PLAYING;
    this.sec = cfg.playerVars.start || 0;
    this.at = fakeNow;
    this.duration = 120;
    this.lastSeek = null;
    this.reportedVideoId = cfg.videoId; // may lag behind videoId right after a load
    this.muted = false;
    FakePlayer.instance = this;
  }
  emit(evt, data) {
    this.cfg.events[evt]?.({ target: this, data });
  }
  current() {
    return this.state === YT_STATE.PLAYING ? this.sec + (fakeNow - this.at) / 1000 : this.sec;
  }
  getPlayerState() { return this.state; }
  getCurrentTime() { return this.current(); }
  getDuration() { return this.duration; }
  getVideoData() { return { video_id: this.reportedVideoId, title: "track " + this.reportedVideoId }; }
  seekTo(s) { this.lastSeek = s; this.sec = s; this.at = fakeNow; }
  loadVideoById({ videoId, startSeconds }) {
    this.videoId = videoId;
    this.reportedVideoId = videoId;
    this.sec = startSeconds || 0;
    this.at = fakeNow;
    this.state = YT_STATE.BUFFERING;
    this.lastSeek = startSeconds;
  }
  playVideo() { if (this.state !== YT_STATE.PLAYING) { this.at = fakeNow; this.state = YT_STATE.PLAYING; } }
  pauseVideo() { this.sec = this.current(); this.at = fakeNow; this.state = YT_STATE.PAUSED; }
  mute() { this.muted = true; }
  unMute() { this.muted = false; }
  setVolume() {}
}

function installGlobals({ touch = false, skewMs = 0 } = {}) {
  const store = new Map();
  const listeners = [];
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
  globalThis.Date.now = () => fakeNow + skewMs;
  globalThis.matchMedia = () => ({ matches: touch });
  globalThis.addEventListener = (type, fn) => listeners.push({ type, fn });
  globalThis.document = {
    head: { appendChild() {} },
    getElementById: () => ({ parentElement: { append() {} } }),
    createElement: () => ({ className: "", alt: "", hidden: false, src: "" }),
  };
  globalThis.window = { YT: { Player: FakePlayer, PlayerState: YT_STATE }, dispatchEvent() {} };
  globalThis.YT = globalThis.window.YT; // in a browser this is a bare global
  FakePlayer.instance = null;
  // timers are inert: the 5 s drift check is exercised by explicit syncs instead
  globalThis.setInterval = () => 0;
  globalThis.setTimeout = () => 0;
  globalThis.clearTimeout = () => {};
  return {
    store,
    firePointerDown: () => listeners.filter((l) => l.type === "pointerdown").forEach((l) => l.fn({ target: {} })),
    pointerHandlerCount: () => listeners.filter((l) => l.type === "pointerdown").length,
  };
}

async function bootRadio({ touch = false, skewMs = 0 } = {}) {
  const platform = installGlobals({ touch, skewMs });
  const radio = await import(`${RADIO_URL}?case=${++moduleSeq}`);
  radio.PLAYLIST.splice(0, radio.PLAYLIST.length, "a", "b", "c");
  await radio.startRadio({ elPlayer: "yt", elTitle: { textContent: "" } });
  const player = FakePlayer.instance;
  player.duration = 120;
  const bootAt = fakeNow;
  // the room's command: track "a" started at boot, on the server clock
  radio.receiveCommand({ idx: 0, at: bootAt }, bootAt);
  return { radio, player, platform, bootAt };
}

function ready(player) {
  player.emit("onReady");
  player.reportedVideoId = player.videoId;
  player.state = YT_STATE.PLAYING;
  player.at = fakeNow;
  player.emit("onStateChange", YT_STATE.PLAYING);
}

// ---------------------------------------------------------------------------
console.log("\n[1] track change with stale ENDED / onError from the replaced video");
{
  const { radio, player } = await bootRadio();
  ready(player);
  player.duration = 200;
  player.emit("onStateChange", YT_STATE.PLAYING); // learns a 200 s duration for "a"
  fakeNow += 30_000;

  // admin "next": the server confirms idx 1 starting now
  radio.receiveCommand({ idx: 1, at: fakeNow }, fakeNow);
  const switchedAt = fakeNow;
  check("switch loads the new video at second 0", player.videoId === "b" && near(player.current(), 0));
  ready(player);
  fakeNow += 4_000; // let the new track get going

  // the old iframe is still alive and emits its own ENDED and onError
  player.reportedVideoId = "a";
  player.emit("onStateChange", YT_STATE.ENDED);
  player.emit("onError", 150);
  check("stale ENDED/onError leave the new video loaded", player.videoId === "b");
  check("stale events do not move the new command", near(player.current(), (fakeNow - switchedAt) / 1000, 1.2),
    `current=${player.current()}`);

  // real events from the new video still work: its duration is learned and used
  player.reportedVideoId = "b";
  player.duration = 60;
  player.emit("onStateChange", YT_STATE.PLAYING); // learns 60 s for "b"
  fakeNow += 70_000; // 74 s into "b" -> the timeline has rolled into "c"
  player.reportedVideoId = "b";
  player.emit("onStateChange", YT_STATE.ENDED);
  check("the new video's own ENDED advances using its learned duration",
    player.videoId === "c" && near(player.current(), 14, 1.2), `video=${player.videoId} current=${player.current()}`);
}

// ---------------------------------------------------------------------------
console.log("\n[2] reconnect: server clock authority and stale local command");
{
  const SKEW = 90_000; // this phone's clock is 90 s ahead of the server
  const { radio, player, platform, bootAt } = await bootRadio({ skewMs: SKEW });
  ready(player);

  fakeNow = bootAt + 40_000;
  // reconnect: the server re-sends the same command with a fresh `now`
  radio.receiveCommand({ idx: 0, at: bootAt }, fakeNow);
  ready(player);
  check("joins at the server's second despite the 90 s local skew",
    near(player.current(), 40, 1.2), `current=${player.current()}`);

  fakeNow = bootAt + 60_000;
  radio.receiveCommand({ idx: 0, at: bootAt }, fakeNow); // second reconnect
  ready(player);
  check("reconnect re-anchors to the server second (60 s in)",
    near(player.current(), 60, 1.2), `current=${player.current()}`);

  platform.store.set("radio-command", JSON.stringify({ idx: 2, at: 0 }));
  radio.receiveCommand(null, fakeNow);
  check("command:null drops a stale command from an earlier visit",
    platform.store.get("radio-command") == null);
}

// ---------------------------------------------------------------------------
console.log("\n[3] phone unlock + desktop/phone resume on the same second");
let phoneSec;
{
  const phone = await bootRadio({ touch: true });
  phone.player.emit("onReady");
  check("phone starts muted for autoplay", phone.player.muted === true);
  check("phone registers a one-shot unlock handler", phone.platform.pointerHandlerCount() === 1);
  // a phone that could not autoplay stays at second 0 (not playing) until the touch
  phone.player.sec = 0;
  phone.player.at = fakeNow;
  phone.player.state = YT_STATE.CUED;
  fakeNow = phone.bootAt + 25_000; // 25 s into the command by the time the user touches
  phone.platform.firePointerDown();
  phoneSec = phone.player.current();
  check("phone unlock seeks to the room's current second, not 0",
    near(phoneSec, 25, 1.2), `sec=${phoneSec}`);
  check("phone unlock unmutes and plays",
    phone.player.muted === false && phone.player.state === YT_STATE.PLAYING);
}
{
  const desktop = await bootRadio({ touch: false });
  ready(desktop.player);
  check("desktop onReady lands on the room's second", near(desktop.player.current(), 0, 1.2),
    `sec=${desktop.player.current()}`);

  fakeNow = desktop.bootAt + 25_000;
  desktop.radio.pauseRadio();
  fakeNow = desktop.bootAt + 42_000; // 17 s paused
  desktop.radio.resumeRadio();
  const desktopSec = desktop.player.current();
  check("desktop resume seeks to the elapsed room second (42 s)",
    near(desktopSec, 42, 1.2), `sec=${desktopSec}`);
  check("desktop and phone agree on the same second",
    near(phoneSec, 25, 1.2) && near(desktopSec, 42, 1.2), `phone=${phoneSec} desktop=${desktopSec}`);

  // unmute after listening muted: mute keeps playing, so the position must stay put
  desktop.radio.setMuted(true);
  fakeNow = desktop.bootAt + 72_000;
  desktop.radio.setMuted(false);
  check("desktop unmute lands on the room's current second (72 s)",
    near(desktop.player.current(), 72, 1.2), `sec=${desktop.player.current()}`);
  check("desktop is still playing after resume/unmute", desktop.player.state === YT_STATE.PLAYING);
}

// ---------------------------------------------------------------------------
console.log("\n[4] command arrives before the player is ready");
{
  installGlobals({});
  globalThis.window.YT = null; // the API script has not loaded yet
  globalThis.YT = undefined;
  const radio = await import(`${RADIO_URL}?case=${++moduleSeq}`);
  radio.PLAYLIST.splice(0, radio.PLAYLIST.length, "a", "b");
  const booting = radio.startRadio({ elPlayer: "yt", elTitle: { textContent: "" } });
  await null; // startRadio is waiting on the API
  check("no player exists yet", !FakePlayer.instance);

  const at = fakeNow;
  radio.receiveCommand({ idx: 1, at: at - 12_000 }, at); // command while still loading
  fakeNow += 3_000;
  globalThis.window.YT = { Player: FakePlayer, PlayerState: YT_STATE };
  globalThis.YT = globalThis.window.YT;
  globalThis.window.onYouTubeIframeAPIReady?.(); // the API "loads"
  await booting;

  const player = FakePlayer.instance;
  player.duration = 120;
  check("the player is built on the command's track", player.videoId === "b");
  check("nothing is played until onReady", player.lastSeek === null);
  player.emit("onReady");
  check("onReady applies the pending command at the server second (15 s)",
    near(player.current(), 15, 1.2), `sec=${player.current()}`);
}

// ---------------------------------------------------------------------------
console.log("\n[5] worker sends its clock on join and re-sends the command on reconnect");
{
  installGlobals({});
  globalThis.Response = class { constructor(body, init) { this.body = body; this.init = init; } };
  const sockets = [];
  class FakeSocket {
    constructor() { this.sent = []; }
    send(msg) { this.sent.push(JSON.parse(msg)); }
    serializeAttachment(a) { this.att = a; }
    deserializeAttachment() { return this.att; }
  }
  globalThis.WebSocketPair = class {
    constructor() {
      this.client = {};
      this.server = new FakeSocket();
      sockets.push(this.server);
      Object.assign(this, { 0: this.client, 1: this.server });
    }
  };
  const storage = new Map();
  const state = {
    getWebSockets: () => sockets,
    storage: {
      get: async (k) => storage.get(k),
      put: async (k, v) => storage.set(k, v),
      delete: async (k) => storage.delete(k),
    },
    acceptWebSocket() {},
  };
  const { Room } = await import(WORKER_URL);
  const room = new Room(state, { ADMIN_PASSWORD: "pw" });
  const req = () => ({
    headers: { get: (h) => (h === "Upgrade" ? "websocket" : h === "CF-Connecting-IP" ? "1.2.3.4" : null) },
  });

  await room.fetch(req());
  const join = sockets[0].sent.find((m) => m.t === "radio");
  check("join sends a radio message even with no command", !!join && join.command === null);
  check("join carries the server clock", Number.isFinite(join?.now));
  const joinNow = join.now;

  fakeNow += 10_000;
  await room.webSocketMessage(sockets[0], JSON.stringify({ t: "radio", idx: 2, password: "pw" }));
  const bcast = sockets[0].sent.filter((m) => m.t === "radio").pop();
  check("admin command is broadcast with the server clock",
    bcast?.command?.idx === 2 && Number.isFinite(bcast.now) && bcast.now > joinNow);
  check("`now` is delivery metadata, not stored in the command", bcast.command.now === undefined);

  fakeNow += 5_000;
  await room.fetch(req()); // reconnect as a second connection
  const rejoin = sockets[1].sent.find((m) => m.t === "radio");
  check("reconnect re-sends the stored command", rejoin?.command?.idx === 2);
  check("reconnect re-stamps the clock", rejoin.now > bcast.now, `rejoin=${rejoin?.now} bcast=${bcast.now}`);
  check("reconnect keeps the original start time `at`", rejoin.command.at === bcast.command.at);
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log("  - " + f);
  process.exitCode = 1;
}
