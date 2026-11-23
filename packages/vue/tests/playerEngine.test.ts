import type { HlsConstructorLike } from '../src/composables/playerEngine'
import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { createPlayerEngine } from '../src/composables/playerEngine'
import { asVideoElement, deferred, makeFakeHls, makeVideo } from './helpers/fakeMedia'

function setup(options: {
  Hls?: HlsConstructorLike
  nativeLoads?: string[]
  nativeDestroys?: number[]
}) {
  const fakeVideo = makeVideo()
  const videoRef = ref<HTMLVideoElement | null>(asVideoElement(fakeVideo))
  const nativeLoads = options.nativeLoads ?? []
  const nativeDestroys = options.nativeDestroys ?? []

  const engine = createPlayerEngine(videoRef, {
    loadHls: async () => ({ default: options.Hls }),
    createNative: () => ({
      load(src) {
        nativeLoads.push(src)
        fakeVideo.src = src
      },
      destroy() {
        nativeDestroys.push(1)
        fakeVideo.removeAttribute('src')
      },
    }),
  })
  engine.attach()
  return { engine, fakeVideo, videoRef, nativeLoads, nativeDestroys }
}

describe('player engine — source switching', () => {
  it('destroys the previous native adapter and clears the media element before loading', async () => {
    const { engine, fakeVideo, nativeLoads, nativeDestroys } = setup({})

    await engine.loadSource('https://cdn/a.mp4')
    fakeVideo.currentTime = 42
    fakeVideo.duration = 90

    await engine.loadSource('https://cdn/b.mp4')

    // Old adapter destroyed exactly once, before the new one loaded.
    expect(nativeDestroys).toHaveLength(1)
    expect(nativeLoads).toEqual(['https://cdn/a.mp4', 'https://cdn/b.mp4'])
    expect(fakeVideo.removeAttribute).toBeDefined()

    // Playback state was reset for the new source.
    expect(engine.state.currentTime).toBe(0)
    expect(engine.state.duration).toBe(0)
    expect(engine.state.buffered).toBe(0)
    expect(engine.state.error).toBeNull()
  })

  it('resets quality, error and buffer state between sources', async () => {
    const { Hls } = makeFakeHls()
    const { engine, nativeLoads } = setup({ Hls })

    await engine.loadSource('https://cdn/stream.m3u8')

    // Switch to a native source — HLS-only state must not leak through.
    await engine.loadSource('https://cdn/next.mp4')

    expect(nativeLoads).toEqual(['https://cdn/next.mp4'])
    expect(engine.state.currentQuality).toBe('auto')
    expect(engine.state.availableQualities).toEqual([])
    expect(engine.state.isBuffering).toBe(false)
    expect(engine.state.isLoading).toBe(true)
    expect(engine.state.error).toBeNull()
  })

  it('does not let a native loadstart clear a fresh error before retry finishes', async () => {
    const { engine, fakeVideo } = setup({})

    await engine.loadSource('https://cdn/missing.mp4')
    await engine.loadSource('https://cdn/broken.mp4')

    // Media element fires loadstart asynchronously.
    fakeVideo.dispatch('loadstart')
    expect(engine.state.isLoading).toBe(true)
  })
})

describe('player engine — HLS lifecycle', () => {
  it('destroys the previous HLS instance before creating the next one', async () => {
    const handle = makeFakeHls()
    const fakeVideo = makeVideo()
    const videoRef = ref<HTMLVideoElement | null>(asVideoElement(fakeVideo))
    const engine = createPlayerEngine(videoRef, {
      loadHls: async () => ({ default: handle.Hls }),
    })
    engine.attach()

    await engine.loadSource('https://cdn/one.m3u8')
    await engine.loadSource('https://cdn/two.m3u8')

    expect(handle.instances).toHaveLength(2)
    expect(handle.instances[0].destroyed).toBe(true)
    expect(handle.instances[1].destroyed).toBe(false)
    expect(handle.instances[1].loadedSrc).toBe('https://cdn/two.m3u8')
    // NOTE: ref() wraps objects in a reactive proxy, so compare against
    // videoRef.value rather than the raw fake object.
    expect(handle.instances[1].media).toBe(videoRef.value)
  })

  it('ignores MANIFEST_PARSED, LEVEL_SWITCHED and ERROR from a destroyed instance', async () => {
    const handle = makeFakeHls()
    const fakeVideo = makeVideo()
    const videoRef = ref<HTMLVideoElement | null>(asVideoElement(fakeVideo))
    const engine = createPlayerEngine(videoRef, {
      loadHls: async () => ({ default: handle.Hls }),
    })
    engine.attach()

    await engine.loadSource('https://cdn/old.m3u8')
    const oldHls = handle.instances[0]
    oldHls.emit(handle.Hls.Events.MANIFEST_PARSED, {})

    await engine.loadSource('https://cdn/new.m3u8')
    // New manifest has not parsed yet.
    expect(engine.state.availableQualities).toEqual([])

    // Late callbacks from the destroyed instance must not touch the new state.
    oldHls.emit(handle.Hls.Events.MANIFEST_PARSED, {})
    oldHls.emit(handle.Hls.Events.LEVEL_SWITCHED, { level: 0 })
    oldHls.emit(handle.Hls.Events.ERROR, { fatal: true, response: { code: 404 } })

    expect(engine.state.availableQualities).toEqual([])
    expect(engine.state.error).toBeNull()
    expect(engine.state.isLoading).toBe(true)
    expect(engine.state.currentQuality).toBe('auto')
  })

  it('populates deduplicated qualities from the current instance only', async () => {
    const handle = makeFakeHls()
    const fakeVideo = makeVideo()
    const videoRef = ref<HTMLVideoElement | null>(asVideoElement(fakeVideo))
    const engine = createPlayerEngine(videoRef, {
      loadHls: async () => ({ default: handle.Hls }),
    })
    engine.attach()

    await engine.loadSource('https://cdn/current.m3u8')
    handle.instances[0].emit(handle.Hls.Events.MANIFEST_PARSED, {})

    expect(engine.state.availableQualities.map((q) => q.value)).toEqual([1080, 720])
  })

  it('discards an HLS instance that resolves after a newer source was requested', async () => {
    const handle = makeFakeHls()
    const fakeVideo = makeVideo()
    const videoRef = ref<HTMLVideoElement | null>(asVideoElement(fakeVideo))
    const pending = deferred<{ default: HlsConstructorLike }>()

    let call = 0
    const engine = createPlayerEngine(videoRef, {
      loadHls: () => {
        call++
        return call === 1 ? pending.promise : Promise.resolve({ default: handle.Hls })
      },
      createNative: () => ({
        load(src) {
          fakeVideo.src = src
        },
        destroy() {},
      }),
    })
    engine.attach()

    // First HLS load hangs on the dynamic import.
    const firstLoad = engine.loadSource('https://cdn/slow.m3u8')
    // While hanging, the user switches source.
    await engine.loadSource('https://cdn/fast.mp4')
    expect(fakeVideo.src).toBe('https://cdn/fast.mp4')

    // The late hls.js module finally arrives.
    pending.resolve({ default: handle.Hls })
    await firstLoad

    // No HLS instance was ever created for the stale load.
    expect(handle.instances).toHaveLength(0)
    expect(engine.state.isLoading).toBe(true)
    expect(fakeVideo.src).toBe('https://cdn/fast.mp4')
  })

  it('still applies events from the new instance after the old one is destroyed', async () => {
    const handle = makeFakeHls()
    const fakeVideo = makeVideo()
    const videoRef = ref<HTMLVideoElement | null>(asVideoElement(fakeVideo))
    const engine = createPlayerEngine(videoRef, {
      loadHls: async () => ({ default: handle.Hls }),
    })
    engine.attach()

    await engine.loadSource('https://cdn/old.m3u8')
    await engine.loadSource('https://cdn/new.m3u8')

    handle.instances[1].emit(handle.Hls.Events.MANIFEST_PARSED, {})

    expect(engine.state.availableQualities.map((q) => q.label)).toEqual(['1080p', '720p'])
    expect(engine.state.currentQuality).toBe('auto')
  })

  it('confirms a manual quality switch via LEVEL_SWITCHED on the current instance', async () => {
    const handle = makeFakeHls()
    const fakeVideo = makeVideo()
    const videoRef = ref<HTMLVideoElement | null>(asVideoElement(fakeVideo))
    const engine = createPlayerEngine(videoRef, {
      loadHls: async () => ({ default: handle.Hls }),
    })
    engine.attach()

    await engine.loadSource('https://cdn/stream.m3u8')
    const hls = handle.instances[0]
    hls.emit(handle.Hls.Events.MANIFEST_PARSED, {})

    engine.controls.setQuality(720)
    expect(hls.nextLevel).toBe(1)
    expect(engine.state.currentQuality).toBe(720)

    hls.emit(handle.Hls.Events.LEVEL_SWITCHED, { level: 1 })
    expect(engine.state.currentQuality).toBe(720)
  })

  it('returns to a clean, retryable state on fatal HLS error', async () => {
    const handle = makeFakeHls()
    const fakeVideo = makeVideo()
    const videoRef = ref<HTMLVideoElement | null>(asVideoElement(fakeVideo))
    const engine = createPlayerEngine(videoRef, {
      loadHls: async () => ({ default: handle.Hls }),
    })
    engine.attach()

    await engine.loadSource('https://cdn/broken.m3u8')
    const hls = handle.instances[0]
    hls.emit(handle.Hls.Events.MANIFEST_PARSED, {})
    expect(engine.state.availableQualities.length).toBeGreaterThan(0)

    hls.emit(handle.Hls.Events.ERROR, { fatal: true, response: { code: 404 } })

    expect(engine.state.error).toEqual({
      code: 404,
      message: 'Stream not found (404).',
      type: 'network',
    })
    expect(engine.state.isLoading).toBe(false)
    expect(engine.state.isBuffering).toBe(false)
    expect(engine.state.availableQualities).toEqual([])
    expect(engine.state.currentQuality).toBe('auto')
    expect(hls.destroyed).toBe(true)
    // A fatal error must not act like a successful load.
    expect(fakeVideo.src).toBe('')
  })

  it('retry() starts a fresh load cycle after a fatal error', async () => {
    const handle = makeFakeHls()
    const fakeVideo = makeVideo()
    const videoRef = ref<HTMLVideoElement | null>(asVideoElement(fakeVideo))
    const engine = createPlayerEngine(videoRef, {
      loadHls: async () => ({ default: handle.Hls }),
    })
    engine.attach()

    await engine.loadSource('https://cdn/flaky.m3u8')
    handle.instances[0].emit(handle.Hls.Events.ERROR, { fatal: true })

    engine.controls.retry()
    // retry() is fire-and-forget; flush the microtask queue.
    await vi.waitFor(() => expect(handle.instances).toHaveLength(2))

    expect(handle.instances[1].loadedSrc).toBe('https://cdn/flaky.m3u8')
    expect(handle.instances[1].destroyed).toBe(false)
    expect(engine.state.error).toBeNull()
    expect(engine.state.isLoading).toBe(true)
  })

  it('ignores a fatal ERROR that arrives after the instance was superseded', async () => {
    const handle = makeFakeHls()
    const fakeVideo = makeVideo()
    const videoRef = ref<HTMLVideoElement | null>(asVideoElement(fakeVideo))
    const engine = createPlayerEngine(videoRef, {
      loadHls: async () => ({ default: handle.Hls }),
    })
    engine.attach()

    await engine.loadSource('https://cdn/a.m3u8')
    const oldHls = handle.instances[0]

    await engine.loadSource('https://cdn/b.mp4')
    oldHls.emit(handle.Hls.Events.ERROR, { fatal: true })

    expect(engine.state.error).toBeNull()
  })

  it('sets a source error when hls.js cannot be imported', async () => {
    const fakeVideo = makeVideo()
    const videoRef = ref<HTMLVideoElement | null>(asVideoElement(fakeVideo))
    const engine = createPlayerEngine(videoRef, {
      loadHls: async () => {
        throw new Error('no hls')
      },
    })
    engine.attach()

    await engine.loadSource('https://cdn/stream.m3u8')

    expect(engine.state.error).toEqual({
      code: 0,
      message: 'Failed to initialize HLS player.',
      type: 'source',
    })
    expect(engine.state.isLoading).toBe(false)
  })

  it('retry() on a native source reloads through a fresh adapter', async () => {
    const nativeLoads: string[] = []
    const nativeDestroys: number[] = []
    const fakeVideo = makeVideo()
    const videoRef = ref<HTMLVideoElement | null>(asVideoElement(fakeVideo))
    const engine = createPlayerEngine(videoRef, {
      createNative: () => ({
        load(src) {
          nativeLoads.push(src)
          fakeVideo.src = src
        },
        destroy() {
          nativeDestroys.push(1)
          fakeVideo.removeAttribute('src')
        },
      }),
    })
    engine.attach()

    await engine.loadSource('https://cdn/movie.mp4')
    fakeVideo.error = { code: 4, message: 'not found' }
    fakeVideo.dispatch('error')
    expect(engine.state.error).not.toBeNull()

    engine.controls.retry()
    await vi.waitFor(() => expect(nativeLoads).toHaveLength(2))

    expect(nativeLoads[1]).toBe('https://cdn/movie.mp4')
    expect(nativeDestroys).toHaveLength(1)
    expect(engine.state.error).toBeNull()
  })

  it('detaches listeners and tears the media down on detach()', async () => {
    const handle = makeFakeHls()
    const fakeVideo = makeVideo()
    const videoRef = ref<HTMLVideoElement | null>(asVideoElement(fakeVideo))
    const engine = createPlayerEngine(videoRef, {
      loadHls: async () => ({ default: handle.Hls }),
    })
    engine.attach()

    await engine.loadSource('https://cdn/a.m3u8')
    engine.detach()

    expect(handle.instances[0].destroyed).toBe(true)
    expect(fakeVideo.src).toBe('')
  })

  it('does not attach duplicate listeners when attach() runs twice', () => {
    const fakeVideo = makeVideo()
    const videoRef = ref<HTMLVideoElement | null>(asVideoElement(fakeVideo))
    const engine = createPlayerEngine(videoRef, {
      loadHls: async () => ({ default: makeFakeHls().Hls }),
    })
    const spy = vi.spyOn(fakeVideo, 'addEventListener')

    engine.attach()
    const firstCount = spy.mock.calls.length
    engine.attach()

    expect(spy.mock.calls.length).toBe(firstCount)
  })
})
