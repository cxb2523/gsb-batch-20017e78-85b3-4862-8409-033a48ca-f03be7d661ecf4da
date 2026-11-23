# ADR 002: Radio synced by the clock

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-09 |
| **Deciders** | Yudi Ganeko |

## Context

Everyone in a room should hear the same second of the same song, and nobody controls it but the system (and an admin). The music comes from YouTube, which can't be streamed through our server.

## Decision

Each browser plays the video in an **embedded YouTube player with no controls** and computes **where it should be** from the clock.

- **Position = now − start.** Without a command, the start is a fixed date (2026-01-01) and the list loops. With a command, the start is the instant the admin pressed restart or skip, kept in the room object's storage.
- **The room is the only clock.** Every `radio` message the object sends — on join, on reconnect and after an admin command — carries `now`, the server's current time in ms. The client keeps `offset = now − receivedAt` and computes the position from `Date.now() + offset`, so a device whose clock is minutes off still lands on the room's second. A join always sends a `radio` message, with `command: null` when the room has none, so a stale command saved on the device cannot resurrect an old position.
- **Every 5 seconds the player corrects itself** if it drifted more than 3 s (ads, slow network). Coming back to the room (resume, unmute, phone unlock) forces the correction even below that, so desktop and phone land on the same second.
- **Durations are learned** from the player as each video loads; until then a video counts as one hour.
- **The admin sends `{ idx }` with the password**; the object sets `{ idx, at: now }`, stores it and broadcasts `{ command, now }` to everyone, the sender included.
- **A click is required** ("enter the room"): browsers only play sound after a user gesture. Phones autoplay muted and, at the first touch, seek to the room's current second instead of starting at 0.
- **Pause is local**: it only mutes you.
- **Commands arriving before the player is ready are kept** and applied in `onReady`; a stale `ENDED`/`onError` from the video being replaced is ignored (the callback is matched to the video the player should be showing).

## Verification

`node scripts/check-radio-sync.mjs` drives the real `src/radio.js` and `worker/index.js` with a fake clock, YouTube player and Durable Object. It covers track change with stale events, reconnect with a device clock 90 s off, phone unlock, a command arriving before `onReady`, and the worker's join/reconnect messages.


## Alternatives considered

| Alternative | Why not |
|---|---|
| **Host the audio and stream it** | Rights to the music, bandwidth, a media server. |
| **The server sends "play at X" events** | Late joiners and drift still need the clock; events alone add nothing. |
| **Let anyone pick from the list** | The point is a shared radio, not a jukebox fight. |

## Consequences

- Sync is within a few seconds, good enough for background music.
- The player must stay visible (YouTube terms), so it's a small TV in the HUD.
- Videos with embedding disabled are skipped.
