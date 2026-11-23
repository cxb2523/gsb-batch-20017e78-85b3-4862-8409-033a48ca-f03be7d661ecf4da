import type { ThumbnailCue } from '@vue-player/core'
import type { ThumbnailParser } from '../src/composables/useThumbnails'
import { describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import { useThumbnailCues } from '../src/composables/useThumbnailCues'
import { deferred } from './helpers/fakeMedia'

function cue(url: string): ThumbnailCue {
  return { start: 0, end: 5, url }
}

async function flush() {
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

describe('useThumbnailCues', () => {
  it('loads cues for the initial thumbnails URL', async () => {
    const parser = vi.fn<ThumbnailParser>(async () => [cue('a.jpg')])
    const sources = ref({ src: 'a.mp4', thumbnails: 'a.vtt' })
    const scope = effectScope()
    const { cues } = scope.run(() => useThumbnailCues(sources, parser))!

    await flush()

    expect(parser).toHaveBeenCalledWith('a.vtt')
    expect(cues.value.map((c) => c.url)).toEqual(['a.jpg'])
    scope.stop()
  })

  it('drops a stale parse when the source changes and reloads the new URL', async () => {
    const slow = deferred<ThumbnailCue[]>()
    const parser = vi
      .fn<ThumbnailParser>()
      .mockImplementationOnce(() => slow.promise)
      .mockImplementationOnce(async () => [cue('b.jpg')])

    const sources = ref({ src: 'a.mp4', thumbnails: 'a.vtt' })
    const scope = effectScope()
    const { cues } = scope.run(() => useThumbnailCues(sources, parser))!

    // Source switches while the first parse is still pending.
    sources.value = { src: 'b.mp4', thumbnails: 'a.vtt' }
    await flush()
    expect(cues.value.map((c) => c.url)).toEqual(['b.jpg'])

    // Old response lands late — must be ignored.
    slow.resolve([cue('a-stale.jpg')])
    await flush()
    expect(cues.value.map((c) => c.url)).toEqual(['b.jpg'])

    scope.stop()
  })

  it('reloads when only the thumbnails URL changes', async () => {
    const parser = vi
      .fn<ThumbnailParser>()
      .mockResolvedValueOnce([cue('a.jpg')])
      .mockResolvedValueOnce([cue('b.jpg')])

    const sources = ref({ src: 'video.mp4', thumbnails: 'a.vtt' })
    const scope = effectScope()
    const { cues } = scope.run(() => useThumbnailCues(sources, parser))!
    await flush()

    sources.value = { src: 'video.mp4', thumbnails: 'b.vtt' }
    await flush()

    expect(parser).toHaveBeenLastCalledWith('b.vtt')
    expect(cues.value.map((c) => c.url)).toEqual(['b.jpg'])
    scope.stop()
  })

  it('clears cues when the thumbnails prop is removed', async () => {
    const parser = vi.fn<ThumbnailParser>(async () => [cue('a.jpg')])
    const sources = ref<{ src?: string; thumbnails?: string }>({
      src: 'a.mp4',
      thumbnails: 'a.vtt',
    })
    const scope = effectScope()
    const { cues } = scope.run(() => useThumbnailCues(sources, parser))!
    await flush()
    expect(cues.value).toHaveLength(1)

    sources.value = { src: 'a.mp4' }
    await flush()
    expect(cues.value).toEqual([])
    scope.stop()
  })

  it('discards an in-flight parse after disposal', async () => {
    const slow = deferred<ThumbnailCue[]>()
    const parser = vi.fn<ThumbnailParser>(() => slow.promise)
    const sources = ref({ src: 'a.mp4', thumbnails: 'a.vtt' })
    const scope = effectScope()
    const { cues } = scope.run(() => useThumbnailCues(sources, parser))!

    scope.stop()
    slow.resolve([cue('late.jpg')])
    await flush()

    expect(cues.value).toEqual([])
  })
})
