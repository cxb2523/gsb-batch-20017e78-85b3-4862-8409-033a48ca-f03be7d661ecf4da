import type { useProjectStore } from '../stores/projectStore'
import type { useTimelineStore } from '../stores/timelineStore'
import type { useMediaStore } from '../stores/mediaStore'
import type { usePlaybackStore } from '../stores/playbackStore'

declare global {
  type DualViewWindowStore<T extends (...args: never[]) => unknown> = ReturnType<T>

  interface Window {
    __dualviewProject?: ReturnType<typeof useProjectStore>
    __dualviewTimeline?: ReturnType<typeof useTimelineStore>
    __dualviewMedia?: ReturnType<typeof useMediaStore>
    __dualviewPlayback?: ReturnType<typeof usePlaybackStore>
  }
}
