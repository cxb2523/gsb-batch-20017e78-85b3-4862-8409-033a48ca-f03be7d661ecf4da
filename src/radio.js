// Room radio: the SYSTEM controls the track and position; pausing is local only.
// Everyone hears the same part: the position is computed from the clock, starting
// at a fixed date, looping through the playlist. With multiplayer, the room's
// Durable Object is the source of that "start" AND of the clock itself: every
// command carries the server's current time, so a phone whose clock is minutes
// off still lands on the room's second.

export const PLAYLIST = [
  "x6ujm9B-vAc",
  // add more YouTube IDs here
];

const START = Date.UTC(2026, 0, 1); // radio's time zero
const DRIFT = 3; // seconds of drift the periodic check tolerates (ads, slow network)
const RESUME_DRIFT = 0.5; // on resume/unmute we land on the current second, not merely within 3 s
const durations = {}; // id -> seconds (learned as each video loads)

let player = null;
let playerReady = false;
let playingIdx = -1;
let paused = false;
// mute is per person and remembered; the radio keeps playing (and in sync) underneath
let muted = false;
try { muted = localStorage.getItem("muted") === "1"; } catch {}

// Server clock correction: offset = server clock - this device's clock.
// The server stamps each radio message right before sending, so a message that
// took a few ms to arrive gives an offset that is a few ms low — far below the
// one-second precision the radio needs. Never trust Date.now() alone while a
// room is connected.
let clockOffsetMs = 0;
const serverNow = () => Date.now() + clockOffsetMs;
function noteServerClock(serverTime, receivedAt = Date.now()) {
  if (Number.isFinite(serverTime)) clockOffsetMs = serverTime - receivedAt;
}

function loadApi() {
  return new Promise((ok) => {
    if (window.YT?.Player) return ok();
    window.onYouTubeIframeAPIReady = ok;
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(s);
  });
}

// Admin command: "video idx started at time t". While it exists it drives
// the clock; after that video ends, the playlist continues from it.
// Only idx/at are persisted: `now` is delivery metadata, not part of the command.
let command = null;
try { command = JSON.parse(localStorage.getItem("radio-command") || "null"); } catch {}

function saveCommand() {
  try {
    if (command) localStorage.setItem("radio-command", JSON.stringify(command));
    else localStorage.removeItem("radio-command");
  } catch {}
}

const wrapIdx = (idx) => ((idx % PLAYLIST.length) + PLAYLIST.length) % PLAYLIST.length;

function nowByCommand() {
  let idx = wrapIdx(command.idx);
  let t = (serverNow() - command.at) / 1000;
  // walk the playlist while time is past the video's duration
  for (let n = 0; n < 500; n++) {
    const d = durations[PLAYLIST[idx]] || 3600;
    if (t < d) return { idx, sec: Math.max(0, t) };
    t -= d;
    idx = (idx + 1) % PLAYLIST.length;
  }
  return { idx: 0, sec: 0 };
}

// With a server: the command goes to the room's Durable Object, which checks the
// admin password and sends it to everyone (including back here).
let sendToServer = null;
export function connectRadioToServer(fn) {
  sendToServer = fn;
}
// Called when the server sends the room's current command (and its clock).
// The command may be null, which clears a stale local command; `clockNow` is
// still used to correct this device's clock. Called on join/reconnect.
export function receiveCommand(c, clockNow) {
  noteServerClock(Number.isFinite(clockNow) ? clockNow : c?.now);
  const at = Number(c?.at);
  command = c && Number.isFinite(c.idx) && Number.isFinite(at) ? { idx: wrapIdx(c.idx | 0), at } : null;
  saveCommand();
  playingIdx = -1; // force reloading/re-seeking at the server's point
  sync();
}

function applyCommand(idx) {
  idx = wrapIdx(idx);
  if (sendToServer) return sendToServer(idx); // wait for the server to confirm
  command = { idx, at: serverNow() };
  saveCommand();
  playingIdx = -1; // force reloading the video at the new point
  sync();
}

// Admin controls (local when offline; go to the room server in multiplayer)
export const admin = {
  restart: () => applyCommand(Math.max(0, playingIdx)),
  next: () => applyCommand(playingIdx + 1),
  previous: () => applyCommand(playingIdx - 1),
};

// Which video and which second, right now, measured on the server's clock once
// it has told us the offset. A video with unknown duration counts as 1h until it
// loads (then it's recomputed).
function nowOnRadio() {
  if (command) return nowByCommand();
  const total = PLAYLIST.reduce((s, id) => s + (durations[id] || 3600), 0);
  let t = ((serverNow() - START) / 1000) % total;
  for (let i = 0; i < PLAYLIST.length; i++) {
    const d = durations[PLAYLIST[i]] || 3600;
    if (t < d) return { idx: i, sec: t };
    t -= d;
  }
  return { idx: 0, sec: 0 };
}

// Move the player to the room's current second. `force` is used whenever the
// user comes back (resume, unmute, phone unlock): then even a sub-second gap is
// corrected, so desktop and phone land on the same second, not just within 3 s.
function sync(force = false) {
  if (paused || !playerReady || !player?.getPlayerState) return;
  const { idx, sec } = nowOnRadio();
  const target = Math.max(0, sec);
  if (idx !== playingIdx) {
    const sameVideo = PLAYLIST[idx] === player.getVideoData?.()?.video_id;
    playingIdx = idx;
    // restart with a 1-video playlist: same id, just seek back
    if (sameVideo) player.seekTo(target, true);
    else {
      player.loadVideoById({ videoId: PLAYLIST[idx], startSeconds: target });
      return;
    }
  }
  const current = player.getCurrentTime?.() || 0;
  if (Math.abs(current - target) > (force ? RESUME_DRIFT : DRIFT)) player.seekTo(target, true);
  const state = player.getPlayerState();
  if (!paused && state !== YT.PlayerState.PLAYING && state !== YT.PlayerState.BUFFERING) player.playVideo();
}

const TOUCH = matchMedia("(pointer: coarse)").matches;

export async function startRadio({ elPlayer, elTitle }) {
  await loadApi();
  const { idx, sec } = nowOnRadio();
  playingIdx = idx;
  // cover with the video's thumbnail whenever it isn't playing, so YouTube's big
  // pause/play overlay and logo never show in the little TV
  const cover = Object.assign(document.createElement("img"), { className: "tv-cover", alt: "" });
  document.getElementById(elPlayer).parentElement.append(cover);
  // YouTube shows its pause button and channel badge for a few seconds after playback
  // starts, so the cover only lifts once that has faded
  let coverTimer = 0;
  const setCover = (playing) => {
    clearTimeout(coverTimer);
    if (playing) coverTimer = setTimeout(() => (cover.hidden = true), 4500);
    else {
      cover.src = `https://i.ytimg.com/vi/${PLAYLIST[Math.max(0, playingIdx)]}/hqdefault.jpg`;
      cover.hidden = false;
    }
  };
  setCover(false);
  player = new YT.Player(elPlayer, {
    width: 176,
    height: 99,
    videoId: PLAYLIST[idx],
    playerVars: { autoplay: 1, controls: 0, disablekb: 1, modestbranding: 1, rel: 0, playsinline: 1, start: Math.floor(sec) },
    events: {
      onReady: (e) => {
        playerReady = true;
        e.target.setVolume(70);
        // phones only autoplay muted (the tap on "enter" is used up while the API loads):
        // start muted and turn the sound on at the next touch
        if (TOUCH) {
          e.target.mute();
          const unlock = () => {
            if (!muted) {
              e.target.unMute();
              e.target.setVolume(70);
            }
            // the command may have started while the API/player was loading: join
            // the room's current second instead of starting from wherever we are
            if (!paused) {
              sync(true);
              e.target.playVideo();
            }
          };
          addEventListener("pointerdown", unlock, { once: true, capture: true });
        }
        if (muted) e.target.mute();
        if (paused) e.target.pauseVideo();
        else {
          // playerVars.start is stale by the time the player is ready; re-anchor
          sync(true);
          e.target.playVideo();
        }
      },
      onStateChange: (e) => {
        const p = e.target;
        // A command may switch videos while the old one is still emitting events.
        // If the player is still showing the previous video, this callback belongs
        // to it and must not touch the new command's position or durations.
        const shown = p.getVideoData?.()?.video_id;
        const expected = PLAYLIST[playingIdx];
        if (shown && expected && shown !== expected) return;
        setCover(e.data === YT.PlayerState.PLAYING);
        if (paused && e.data === YT.PlayerState.PLAYING) {
          p.pauseVideo();
          return;
        }
        if (e.data === YT.PlayerState.PLAYING) {
          const id = PLAYLIST[playingIdx];
          const d = p.getDuration();
          if (d && durations[id] !== d) {
            durations[id] = d;
            sync(); // now with the real duration, recompute the point
          }
          elTitle.textContent = p.getVideoData()?.title || "—";
        }
        if (e.data === YT.PlayerState.ENDED) sync();
      },
      onError: (e) => {
        // video unavailable / not embeddable: skip to the next. Ignore errors from
        // the video we just replaced — marking the NEW id as 1 s long would make
        // the timeline jump forward and drag the new command back to an old spot.
        if (playingIdx < 0) return;
        const shown = e.target?.getVideoData?.()?.video_id;
        const expected = PLAYLIST[playingIdx];
        if (shown && expected && shown !== expected) return;
        durations[expected] = 1;
        sync();
      },
    },
  });
  setInterval(sync, 5000);
}

export const isMuted = () => muted;
export function setMuted(m) {
  muted = m;
  try { localStorage.setItem("muted", m ? "1" : "0"); } catch {}
  if (!player?.mute) return;
  if (m) player.mute();
  else {
    player.unMute();
    player.setVolume(70);
    // unmuting (desktop or phone) is a return to the room: land on its second
    sync(true);
  }
}

export function pauseRadio() {
  paused = true;
  player?.pauseVideo?.();
}

export function resumeRadio() {
  paused = false;
  // the room kept playing while we were paused, so seek before starting again
  sync(true);
}
