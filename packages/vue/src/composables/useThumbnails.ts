import type { ThumbnailCue } from '@vue-player/core'
import { parseThumbnailVtt } from '@vue-player/core'

export type ThumbnailParser = (url: string) => Promise<ThumbnailCue[]>

/**
 * Guards thumbnail VTT loading against source-switch races.
 *
 * Each `load()` call takes a fresh token. When the parser resolves, the cues
 * are only handed back if no newer request has started in the meantime, so a
 * slow response for the previous source can never overwrite the new source's
 * thumbnails. Cues are also cleared synchronously on every request so the
 * timeline never previews frames from the previous source while loading.
 */
export function createThumbnailLoader(parse: ThumbnailParser = parseThumbnailVtt) {
  let token = 0

  return {
    /** Drop any in-flight result without starting a new request. */
    invalidate() {
      token++
    },

    async load(url: string | undefined, apply: (cues: ThumbnailCue[]) => void) {
      const current = ++token

      // Immediately forget the previous source's previews.
      apply([])
      if (!url) {
        return
      }

      let cues: ThumbnailCue[]
      try {
        cues = await parse(url)
      } catch {
        if (current !== token) {
          return
        }
        apply([])
        return
      }

      // A source switch (or a new thumbnails URL) happened while we were
      // parsing — this result belongs to a source that is no longer active.
      if (current !== token) {
        return
      }
      apply(cues)
    },
  }
}
