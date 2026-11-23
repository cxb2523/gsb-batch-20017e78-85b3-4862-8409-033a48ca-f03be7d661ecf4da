---
title: usePlayer
description: usePlayer composable API — state, controls and loadSource reference.
---

# usePlayer

Low-level composable that powers `VideoPlayer` internally. Use it when you need direct access to player state and controls — for example, to build a fully custom UI.

## Import

```ts
import { usePlayer } from '@vue-player/vue'
```

## Signature

```ts
function usePlayer(
  videoRef: Ref<HTMLVideoElement | null>
): {
  state: Readonly<PlayerState>
  controls: PlayerControls
  loadSource: (src: string) => Promise<void>
}
```

## Parameters

| Parameter | Type | Description |
|---|---|---|
| `videoRef` | `Ref<HTMLVideoElement \| null>` | A template ref bound to a `<video>` element |

## Returns

### `state`

Readonly reactive `PlayerState` object. See [PlayerState](/api/types#playerstate).

### `controls`

Object with methods to control playback. See [PlayerControls](/api/types#playercontrols).

### `loadSource`

Loads a new video source into the player. Automatically detects the source type (`mp4`, `hls`) and sets up the appropriate adapter:

```ts
loadSource('https://example.com/video.mp4')
loadSource('https://example.com/stream.m3u8')  // triggers hls.js
```

Calling `loadSource` on an already-playing video starts a complete, repeatable load cycle:

1. The previous native/HLS adapter is destroyed and the `<video>` element is cleared.
2. Playback state is reset (time, duration, buffered, quality, error, live flag).
3. The new source is loaded through a fresh adapter.

Any asynchronous result from the previous cycle — the dynamic `hls.js` import, a
`MANIFEST_PARSED` / `LEVEL_SWITCHED` / `ERROR` callback from a destroyed instance
— is ignored, so it can never write into the new source's state. On a fatal HLS
error both the state and the instance are reset so `controls.retry()` can start a
clean cycle.

## Basic Usage

```vue
<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { usePlayer } from '@vue-player/vue'

const videoRef = ref<HTMLVideoElement | null>(null)
const { state, controls, loadSource } = usePlayer(videoRef)

onMounted(() => {
  loadSource('https://example.com/video.mp4')
})
</script>

<template>
  <video ref="videoRef" />

  <div>
    <button @click="controls.play()">Play</button>
    <button @click="controls.pause()">Pause</button>
    <button @click="controls.seek(0)">Restart</button>
  </div>

  <p>{{ state.currentTime.toFixed(1) }} / {{ state.duration.toFixed(1) }}</p>
</template>
```

## Notes

- `usePlayer` attaches native `<video>` event listeners inside `onMounted` and cleans them up in `onUnmounted` — it must be called inside a component `setup`.
- `VideoPlayer` uses `usePlayer` internally. You only need this composable when building a custom player shell.
- The `state` object is `readonly` — never mutate it directly. Use `controls` methods instead.
- Subtitles are re-applied after every source change: the previously selected track is restored if the new source provides it, otherwise the source's `default` track is used, otherwise subtitles are turned off. Cues from the previous track are cleared while the new source loads.
