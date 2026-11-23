import type { ThumbnailCue } from '@vue-player/core'
import type { Ref } from 'vue'
import type { ThumbnailParser } from './useThumbnails'
import { onScopeDispose, ref, watch } from 'vue'
import { createThumbnailLoader } from './useThumbnails'

export interface ThumbnailSources {
  src?: string
  thumbnails?: string
}

/**
 * Reactive bridge between the source/thumbnail props and the race-safe
 * loader. Cues belong to the current source only.
 *
 * A single watcher covers both inputs so every change costs exactly one parse
 * while every in-flight parse is invalidated: swapping sources (even while the
 * new source uses the same VTT URL) or pointing at a new VTT can never leave
 * cues from the previous source on the timeline.
 */
export function useThumbnailCues(sources: Ref<ThumbnailSources>, parse?: ThumbnailParser) {
  const cues = ref<ThumbnailCue[]>([])
  const loader = parse ? createThumbnailLoader(parse) : createThumbnailLoader()

  watch(
    () => [sources.value.src, sources.value.thumbnails] as const,
    () => {
      // Bumping the token synchronously drops any result still in flight;
      // load() then clears the visible cues and starts the new parse.
      loader.invalidate()
      void loader.load(sources.value.thumbnails, (next) => {
        cues.value = next
      })
    },
    { immediate: true },
  )

  // Disposal (component unmount or effect-scope stop) drops any in-flight parse.
  onScopeDispose(() => loader.invalidate())

  return { cues }
}
