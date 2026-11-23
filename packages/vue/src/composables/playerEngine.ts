import type { NativeAdapter, PlayerError, PlayerState, Track } from '@vue-player/core'
import type { Ref } from 'vue'
import {
  createNativeAdapter,
  detectSourceType,
  enterFullscreen,
  exitFullscreen,
  getFullscreenElement,
} from '@vue-player/core'
import { reactive, readonly } from 'vue'

export interface PlayerControls {
  play: () => Promise<void>
  pause: () => void
  seek: (seconds: number) => void
  setVolume: (value: number) => void
  toggleMute: () => void
  setSpeed: (rate: number) => void
  setQuality: (value: number | 'auto') => void
  setTrack: (track: Track | null) => void
  toggleFullscreen: () => Promise<void>
  togglePiP: () => Promise<void>
  retry: () => void
}

/**
 * Minimal structural view of an hls.js instance. Keeping the engine typed
 * against this interface (instead of `any`) lets tests inject a fake
 * implementation without pulling in the real player.
 */
export interface HlsLevelLike {
  height?: number
  bitrate?: number
}

export interface HlsEventDataLike {
  fatal?: boolean
  level?: number
  response?: { code?: number }
}

export interface HlsInstanceLike {
  levels?: HlsLevelLike[]
  currentLevel?: number
  nextLevel?: number
  loadSource: (src: string) => void
  attachMedia: (video: HTMLVideoElement) => void
  destroy: () => void
  on: (event: string, listener: (event: string, data: HlsEventDataLike) => void) => void
}

export interface HlsConstructorLike {
  new (config?: Record<string, unknown>): HlsInstanceLike
  isSupported?: () => boolean
  Events: {
    MANIFEST_PARSED: string
    LEVEL_SWITCHED: string
    ERROR: string
  }
}

export interface PlayerEngineOptions {
  /** Override the dynamic hls.js loader. Primarily a test seam. */
  loadHls?: () => Promise<{ default: unknown }>
  /** Override the native adapter factory. Primarily a test seam. */
  createNative?: (video: HTMLVideoElement) => NativeAdapter
}

const ERROR_MESSAGES: Record<number, string> = {
  1: 'Playback was aborted.',
  2: 'Network error — could not load the video.',
  3: 'The video format is not supported by your browser.',
  4: 'Video not found or format not supported.',
}

function makeDefaultState(): PlayerState {
  return {
    isPlaying: false,
    isPaused: true,
    isEnded: false,
    isLoading: false,
    isBuffering: false,
    currentTime: 0,
    duration: 0,
    buffered: 0,
    volume: 1,
    isMuted: false,
    isFullscreen: false,
    isPiP: false,
    isLive: false,
    currentQuality: 'auto',
    availableQualities: [],
    playbackRate: 1,
    currentTrack: null,
    availableTracks: [],
    error: null,
  }
}

interface ListenerRecord {
  target: EventTarget
  type: string
  handler: EventListener
}

export function createPlayerEngine(
  videoRef: Ref<HTMLVideoElement | null>,
  options: PlayerEngineOptions = {},
) {
  const state = reactive<PlayerState>(makeDefaultState())
  const loadHls =
    options.loadHls ?? (() => import('hls.js') as unknown as Promise<{ default: unknown }>)
  const createNative = options.createNative ?? createNativeAdapter

  let nativeAdapter: NativeAdapter | null = null
  let hlsInstance: HlsInstanceLike | null = null
  let lastSrc = ''
  /**
   * Monotonic token identifying the current load cycle. Every asynchronous
   * continuation (dynamic import, HLS callbacks, thumbnail parsing elsewhere)
   * compares against it before touching state, so results belonging to a
   * previous source can never overwrite the current one.
   */
  let loadGeneration = 0
  let attached = false
  const listenerRecords: ListenerRecord[] = []

  function on(target: EventTarget, type: string, handler: EventListener) {
    target.addEventListener(type, handler)
    listenerRecords.push({ target, type, handler })
  }

  function clearVideo() {
    const video = videoRef.value
    if (!video) {
      return
    }
    try {
      video.pause()
    } catch {
      // The element may already be detached.
    }
    video.removeAttribute('src')
    try {
      video.load()
    } catch {
      // load() can throw if the media element is in an inconsistent state
    }
  }

  function destroyHls(hls: HlsInstanceLike) {
    if (hlsInstance === hls) {
      hlsInstance = null
    }
    try {
      hls.destroy()
    } catch {
      // hls.js throws if destroy() runs twice — ignore, the goal is teardown.
    }
  }

  function destroyNative(adapter: NativeAdapter) {
    if (nativeAdapter === adapter) {
      nativeAdapter = null
    }
    try {
      adapter.destroy()
    } catch {
      // Best effort: a broken adapter must never block a source switch.
    }
  }

  /**
   * Fully tear down the previous load cycle: adapters first, then the media
   * element itself. This runs before every new load (source switch or retry).
   */
  function teardownMedia() {
    if (nativeAdapter) {
      destroyNative(nativeAdapter)
    }
    if (hlsInstance) {
      destroyHls(hlsInstance)
    }
    clearVideo()
  }

  function resetStateForLoad() {
    state.isPlaying = false
    state.isPaused = true
    state.isEnded = false
    state.isLoading = true
    state.isBuffering = false
    state.currentTime = 0
    state.duration = 0
    state.buffered = 0
    state.isLive = false
    state.currentQuality = 'auto'
    state.availableQualities = []
    state.error = null
  }

  function failToLoad(message: string, type: PlayerError['type'], code = 0) {
    state.error = { code, message, type }
    state.isLoading = false
    state.isBuffering = false
  }

  function syncFromVideo(video: HTMLVideoElement) {
    state.isPlaying = !video.paused && !video.ended
    state.isPaused = video.paused
    state.isEnded = video.ended
    state.currentTime = video.currentTime
    state.duration = Number.isFinite(video.duration) ? video.duration : 0
    state.volume = video.volume
    state.isMuted = video.muted
    state.playbackRate = video.playbackRate
    state.isLive = video.duration === Infinity
    state.buffered = video.buffered.length > 0 ? video.buffered.end(video.buffered.length - 1) : 0
  }

  function applyTrackModes(video: HTMLVideoElement) {
    const track = state.currentTrack
    Array.from(video.querySelectorAll<HTMLTrackElement>('track')).forEach((el) => {
      const t = el.track
      const isActive = track !== null && t.language === track.language && t.label === track.label
      t.mode = isActive ? 'hidden' : 'disabled'
    })
  }

  async function loadSource(src: string) {
    const video = videoRef.value
    if (!video) {
      return
    }

    // Claim this load cycle. Any in-flight work from a previous cycle will
    // notice the generation mismatch and bail out without touching state.
    const generation = ++loadGeneration
    lastSrc = src

    teardownMedia()
    resetStateForLoad()

    const type = detectSourceType(src)

    if (type !== 'hls') {
      const adapter = createNative(video)
      nativeAdapter = adapter
      adapter.load(src)
      return
    }

    let Hls: HlsConstructorLike
    try {
      const mod = await loadHls()
      if (generation !== loadGeneration) {
        return
      }
      Hls = (mod.default ?? mod) as unknown as HlsConstructorLike
    } catch {
      if (generation !== loadGeneration) {
        return
      }
      failToLoad('Failed to initialize HLS player.', 'source')
      return
    }

    if (generation !== loadGeneration) {
      return
    }

    if (typeof Hls.isSupported === 'function' && !Hls.isSupported()) {
      // Safari supports HLS natively — load through the media element.
      video.src = src
      return
    }

    let hls: HlsInstanceLike
    try {
      hls = new Hls({ enableWorker: true })
    } catch {
      if (generation !== loadGeneration) {
        return
      }
      failToLoad('Failed to initialize HLS player.', 'source')
      return
    }

    if (generation !== loadGeneration) {
      // Another source was requested while we were constructing the instance.
      try {
        hls.destroy()
      } catch {
        // ignore
      }
      return
    }

    hlsInstance = hls
    const isCurrent = () => generation === loadGeneration && hlsInstance === hls

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      // A destroyed/stale instance must never write into the new session.
      if (!isCurrent()) {
        return
      }
      const seen = new Set<number>()
      state.availableQualities = (hls.levels ?? [])
        .map((level, i) => ({
          value: level.height as number,
          label: level.height ? `${level.height}p` : `Level ${i}`,
          bitrate: level.bitrate,
        }))
        .filter((q) => {
          if (seen.has(q.value)) {
            return false
          }
          seen.add(q.value)
          return true
        })
        .sort((a, b) => b.value - a.value)
      state.currentQuality = 'auto'
    })

    hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
      if (!isCurrent()) {
        return
      }
      // Only update displayed quality when ABR switches automatically
      if (state.currentQuality === 'auto') {
        return
      }
      const level = (hls.levels ?? [])[data?.level ?? -1]
      if (level && level.height !== state.currentQuality) {
        // nextLevel has fully applied — confirm it
        state.currentQuality = level.height as number
      }
    })

    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (!isCurrent()) {
        return
      }
      if (!data?.fatal) {
        return
      }
      const code = data.response?.code ?? 0

      // Return to a clean, retryable state: instance gone, media detached,
      // quality/error state reset. retry() will start a fresh load cycle.
      destroyHls(hls)
      clearVideo()
      state.availableQualities = []
      state.currentQuality = 'auto'
      state.error = {
        code,
        message:
          code === 404
            ? 'Stream not found (404).'
            : 'Failed to load the stream. Check the URL or try again.',
        type: 'network',
      }
      state.isLoading = false
      state.isBuffering = false
    })

    try {
      hls.loadSource(src)
      hls.attachMedia(video)
    } catch {
      if (generation !== loadGeneration) {
        return
      }
      destroyHls(hls)
      failToLoad('Failed to initialize HLS player.', 'source')
    }
  }

  function onFullscreenChange() {
    state.isFullscreen = !!document.fullscreenElement
  }

  const controls: PlayerControls = {
    async play() {
      await videoRef.value?.play()
    },
    pause() {
      videoRef.value?.pause()
    },
    seek(seconds) {
      const video = videoRef.value
      if (!video || !state.duration) {
        return
      }
      video.currentTime = Math.max(0, Math.min(state.duration, seconds))
    },
    setVolume(value) {
      const video = videoRef.value
      if (!video) {
        return
      }
      video.volume = Math.max(0, Math.min(1, value))
      if (video.muted && value > 0) {
        video.muted = false
      }
    },
    toggleMute() {
      if (videoRef.value) {
        videoRef.value.muted = !videoRef.value.muted
      }
    },
    setSpeed(rate) {
      if (videoRef.value) {
        videoRef.value.playbackRate = rate
      }
    },
    setQuality(value) {
      if (!hlsInstance) {
        return
      }
      if (value === 'auto') {
        hlsInstance.currentLevel = -1 // -1 re-enables ABR
      } else {
        const idx = (hlsInstance.levels ?? []).findIndex((l) => l.height === value)
        // nextLevel switches at the next segment boundary — no buffer flush, no freeze
        if (idx !== -1) {
          hlsInstance.nextLevel = idx
        }
      }
      state.currentQuality = value
    },
    setTrack(track) {
      state.currentTrack = track
      const video = videoRef.value
      if (video) {
        applyTrackModes(video)
      }
    },
    async toggleFullscreen() {
      const video = videoRef.value
      const el = video?.closest<HTMLElement>('.vp-player')
      if (!el) {
        return
      }
      if (getFullscreenElement()) {
        await exitFullscreen()
      } else if ('requestFullscreen' in el || 'webkitRequestFullscreen' in el) {
        await enterFullscreen(el)
      } else {
        // iOS Safari: only supports fullscreen on the video element itself
        const iosVideo = video as HTMLVideoElement & { webkitEnterFullscreen?: () => void }
        iosVideo.webkitEnterFullscreen?.()
      }
    },
    async togglePiP() {
      const video = videoRef.value
      if (!video) {
        return
      }
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture()
      } else {
        await video.requestPictureInPicture()
      }
    },
    retry() {
      if (lastSrc) {
        void loadSource(lastSrc)
      }
    },
  }

  function attach() {
    const video = videoRef.value
    if (!video || attached) {
      return
    }
    attached = true

    on(video, 'loadstart', () => {
      // Ignore the loadstart produced by tearing the previous media down —
      // it must not clear an error that is currently on screen.
      if (state.error) {
        return
      }
      state.isLoading = true
    })
    on(video, 'loadedmetadata', () => syncFromVideo(video))
    on(video, 'canplay', () => {
      state.isLoading = false
    })
    on(video, 'waiting', () => {
      state.isBuffering = true
    })
    on(video, 'playing', () => {
      state.isBuffering = false
      syncFromVideo(video)
    })
    on(video, 'play', () => syncFromVideo(video))
    on(video, 'pause', () => {
      state.isBuffering = false
      syncFromVideo(video)
    })
    on(video, 'ended', () => syncFromVideo(video))
    on(video, 'timeupdate', () => syncFromVideo(video))
    on(video, 'volumechange', () => syncFromVideo(video))
    on(video, 'durationchange', () => syncFromVideo(video))
    on(video, 'progress', () => syncFromVideo(video))
    on(video, 'ratechange', () => {
      state.playbackRate = video.playbackRate
    })
    on(video, 'error', () => {
      const err = video.error
      if (!err) {
        return
      }
      // MediaError is not defined in SSR / test environments — degrade to
      // unknown instead of throwing while mapping the error type.
      const MediaErrorCtor =
        typeof MediaError === 'undefined'
          ? ({} as Record<string, number>)
          : (MediaError as unknown as Record<string, number>)
      const typeMap: Record<number, PlayerError['type']> = {
        [MediaErrorCtor.MEDIA_ERR_NETWORK]: 'network',
        [MediaErrorCtor.MEDIA_ERR_DECODE]: 'decode',
        [MediaErrorCtor.MEDIA_ERR_SRC_NOT_SUPPORTED]: 'source',
      }
      state.error = {
        code: err.code,
        message: ERROR_MESSAGES[err.code] ?? err.message ?? 'Unknown playback error.',
        type: typeMap[err.code] ?? 'unknown',
      }
      state.isLoading = false
      state.isBuffering = false
    })

    on(video, 'enterpictureinpicture', () => {
      state.isPiP = true
    })
    on(video, 'leavepictureinpicture', () => {
      state.isPiP = false
    })

    if (typeof document !== 'undefined') {
      // Fullscreen must be observed on document — the player element is not <video>
      on(document, 'fullscreenchange', onFullscreenChange)
    }

    syncFromVideo(video)
  }

  function detach() {
    if (!attached) {
      return
    }
    attached = false
    // Invalidate any in-flight asynchronous load so it cannot revive playback.
    loadGeneration++
    for (const { target, type, handler } of listenerRecords.splice(0)) {
      target.removeEventListener(type, handler)
    }
    teardownMedia()
  }

  return { state: readonly(state), controls, loadSource, attach, detach }
}
