import type { Track } from '@vue-player/core'

/**
 * Pick the subtitle track that should be active for a freshly loaded source:
 * the currently selected track if it still exists, otherwise the source's
 * default track, otherwise none.
 */
export function resolveActiveTrack(
  tracks: ReadonlyArray<Track> | undefined,
  current: Track | null,
): Track | null {
  const list = tracks ?? []
  if (current) {
    const match = list.find((t) => t.language === current.language && t.label === current.label)
    if (match) {
      return match
    }
  }
  return list.find((t) => t.default) ?? null
}

export interface SubtitleRefreshPlan {
  /** Whether the track selection should be re-applied to the media element. */
  shouldApplyTrack: boolean
  /** Track to apply (may be `null` to turn subtitles off). */
  track: Track | null
  /** Whether rendered cues must be dropped right now. */
  clearCues: boolean
}

/**
 * Decide what to do with subtitles when the loading flag changes.
 *
 * - While loading, stale cues from the previous source/track are cleared and
 *   no track is applied yet (track modes are reset asynchronously by
 *   `video.load()`, so applying a mode now would race the browser).
 * - Once loading completes, the current track (or the new source's default) is
 *   re-applied — `null` when the new source has no matching track, which turns
 *   the old track off instead of leaving it selected.
 */
export function planSubtitleRefresh(
  isLoading: boolean,
  tracks: ReadonlyArray<Track> | undefined,
  current: Track | null,
): SubtitleRefreshPlan {
  if (isLoading) {
    return { shouldApplyTrack: false, track: current, clearCues: true }
  }
  return {
    shouldApplyTrack: true,
    track: resolveActiveTrack(tracks, current),
    clearCues: false,
  }
}
