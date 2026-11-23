import type {
  HlsConstructorLike,
  HlsEventDataLike,
  HlsInstanceLike,
} from '../../src/composables/playerEngine'

export interface FakeVideo {
  paused: boolean
  ended: boolean
  currentTime: number
  duration: number
  volume: number
  muted: boolean
  playbackRate: number
  buffered: { length: number; end: (i: number) => number }
  error: unknown
  src: string
  pauseCalls: number
  loadCalls: number
  removedSrcCount: number
  addEventListener: (type: string, handler: EventListener) => void
  removeEventListener: (type: string, handler: EventListener) => void
  dispatch: (type: string) => void
  querySelectorAll: (selector: string) => unknown[]
  removeAttribute: (name: string) => void
  load: () => void
}

export function makeVideo(): FakeVideo {
  const listeners = new Map<string, Set<EventListener>>()
  const video: FakeVideo = {
    paused: true,
    ended: false,
    currentTime: 0,
    duration: 0,
    volume: 1,
    muted: false,
    playbackRate: 1,
    buffered: { length: 0, end: () => 0 },
    error: null,
    src: '',
    pauseCalls: 0,
    loadCalls: 0,
    removedSrcCount: 0,
    addEventListener(type, handler) {
      if (!listeners.has(type)) {
        listeners.set(type, new Set())
      }
      listeners.get(type)!.add(handler)
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler)
    },
    dispatch(type) {
      for (const handler of listeners.get(type) ?? []) handler(new Event(type))
    },
    querySelectorAll() {
      return []
    },
    removeAttribute(name) {
      if (name === 'src') {
        video.src = ''
        video.removedSrcCount++
      }
    },
    load() {
      video.loadCalls++
    },
  }
  return video
}

export function asVideoElement(video: FakeVideo): HTMLVideoElement {
  return video as unknown as HTMLVideoElement
}

export interface FakeHlsHandle {
  Hls: HlsConstructorLike
  instances: FakeHlsInstance[]
}

export interface FakeHlsInstance extends HlsInstanceLike {
  loadedSrc: string | null
  media: HTMLVideoElement | null
  destroyed: boolean
  emit: (event: string, data?: HlsEventDataLike) => void
  listenerCount: number
}

export function makeFakeHls(
  levels: Array<{ height?: number; bitrate?: number }> = [
    { height: 1080, bitrate: 5_000_000 },
    { height: 720, bitrate: 2_500_000 },
    { height: 720, bitrate: 2_000_000 },
  ],
): FakeHlsHandle {
  const instances: FakeHlsInstance[] = []

  class FakeHls implements FakeHlsInstance {
    static isSupported = () => true
    static Events = {
      MANIFEST_PARSED: 'hlsManifestParsed',
      LEVEL_SWITCHED: 'hlsLevelSwitched',
      ERROR: 'hlsError',
    }

    levels = levels.map((l) => ({ ...l }))
    currentLevel = -1
    nextLevel = -1
    loadedSrc: string | null = null
    media: HTMLVideoElement | null = null
    destroyed = false
    private handlers = new Map<string, Set<(event: string, data: HlsEventDataLike) => void>>()

    constructor() {
      instances.push(this)
    }

    loadSource(src: string) {
      this.loadedSrc = src
    }

    attachMedia(video: HTMLVideoElement) {
      this.media = video
    }

    destroy() {
      this.destroyed = true
    }

    on(event: string, listener: (event: string, data: HlsEventDataLike) => void) {
      if (!this.handlers.has(event)) {
        this.handlers.set(event, new Set())
      }
      this.handlers.get(event)!.add(listener)
    }

    get listenerCount() {
      let count = 0
      for (const set of this.handlers.values()) count += set.size
      return count
    }

    // Deliberately keeps firing after destroy() — mimics a late callback that
    // escaped hls.js teardown. The engine must ignore it.
    emit(event: string, data: HlsEventDataLike = {}) {
      for (const listener of this.handlers.get(event) ?? []) listener(event, data)
    }
  }

  return { Hls: FakeHls as unknown as HlsConstructorLike, instances }
}

export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
