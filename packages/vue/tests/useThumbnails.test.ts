import type { ThumbnailCue } from '@vue-player/core'
import { parseVttText } from '@vue-player/core'
import { describe, expect, it, vi } from 'vitest'
import { createThumbnailLoader } from '../src/composables/useThumbnails'
import { deferred } from './helpers/fakeMedia'

function cue(url: string, start = 0, end = 5): ThumbnailCue {
  return { start, end, url }
}

describe('createThumbnailLoader', () => {
  it('applies cues for a normal single load', async () => {
    const cues = [cue('https://cdn/a-0.jpg', 0, 5), cue('https://cdn/a-5.jpg', 5, 10)]
    const parser = vi.fn(async () => cues)
    const loader = createThumbnailLoader(parser)
    const applied: ThumbnailCue[][] = []

    await loader.load('https://cdn/a.vtt', (c) => applied.push(c))

    expect(parser).toHaveBeenCalledWith('https://cdn/a.vtt')
    expect(applied).toEqual([[], cues])
  })

  it('clears cues immediately and skips parsing when no URL is given', async () => {
    const parser = vi.fn(async () => [cue('x')])
    const loader = createThumbnailLoader(parser)
    const applied: ThumbnailCue[][] = []

    await loader.load(undefined, (c) => applied.push(c))

    expect(parser).not.toHaveBeenCalled()
    expect(applied).toEqual([[]])
  })

  it('discards a stale VTT response that resolves after a source switch', async () => {
    const slow = deferred<ThumbnailCue[]>()
    const parser = vi
      .fn<(url: string) => Promise<ThumbnailCue[]>>()
      .mockImplementationOnce(() => slow.promise)
      .mockImplementationOnce(async () => [cue('https://cdn/new-0.jpg')])

    const loader = createThumbnailLoader(parser)
    let latest: ThumbnailCue[] = [{ ...cue('https://cdn/old-initial.jpg') }]

    // Load the old source's VTT — it hangs.
    const oldRequest = loader.load('https://cdn/old.vtt', (c) => {
      latest = c
    })

    // A new source arrives before the old response returns.
    await loader.load('https://cdn/new.vtt', (c) => {
      latest = c
    })
    expect(latest.map((c) => c.url)).toEqual(['https://cdn/new-0.jpg'])

    // The old response finally lands — it must be dropped.
    slow.resolve([cue('https://cdn/old-0.jpg')])
    await oldRequest

    expect(latest.map((c) => c.url)).toEqual(['https://cdn/new-0.jpg'])
  })

  it('invalidate() drops an in-flight result without starting a new request', async () => {
    const slow = deferred<ThumbnailCue[]>()
    const parser = vi.fn(() => slow.promise)
    const loader = createThumbnailLoader(parser)
    let latest: ThumbnailCue[] | null = null

    const request = loader.load('https://cdn/stale.vtt', (c) => {
      latest = c
    })
    // Simulate a source switch that also invalidates thumbnails.
    loader.invalidate()

    slow.resolve([cue('https://cdn/stale-0.jpg')])
    await request

    // No cues were applied after the initial clearing.
    expect(latest).toEqual([])
    expect(parser).toHaveBeenCalledTimes(1)
  })

  it('swallows parser failures and clears cues', async () => {
    const parser = vi.fn(async () => {
      throw new Error('network')
    })
    const loader = createThumbnailLoader(parser)
    const applied: ThumbnailCue[][] = []

    await loader.load('https://cdn/broken.vtt', (c) => applied.push(c))

    expect(applied).toEqual([[], []])
  })

  it('resolves relative sprite URLs against the VTT location', () => {
    const vtt = [
      'WEBVTT',
      '',
      '00:00:00.000 --> 00:00:05.000',
      'frame_000.jpg#xywh=0,0,160,90',
      '',
      '00:00:05.000 --> 00:00:10.000',
      'frame_001.jpg#xywh=160,0,160,90',
      '',
    ].join('\n')

    const cues = parseVttText(vtt, 'https://cdn.example.com/thumbs/list.vtt')

    expect(cues).toHaveLength(2)
    expect(cues[0]).toMatchObject({
      start: 0,
      end: 5,
      url: 'https://cdn.example.com/thumbs/frame_000.jpg',
      x: 0,
      y: 0,
      w: 160,
      h: 90,
    })
    expect(cues[1].url).toBe('https://cdn.example.com/thumbs/frame_001.jpg')
    expect(cues[1].x).toBe(160)
  })
})
