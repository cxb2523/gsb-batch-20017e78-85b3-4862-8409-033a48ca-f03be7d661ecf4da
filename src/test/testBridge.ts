/**
 * Dev/test bridge: exposes the zustand stores on `window` so Playwright
 * acceptance tests can drive the application through its real state API
 * (the same actions the UI dispatches) instead of reaching into components.
 *
 * Guarded by import.meta.env.DEV so nothing is attached in production builds.
 */
import { useProjectStore } from '../stores/projectStore'
import { useTimelineStore } from '../stores/timelineStore'
import { useMediaStore } from '../stores/mediaStore'
import { usePlaybackStore } from '../stores/playbackStore'

if (import.meta.env.DEV) {
  window.__dualviewProject = useProjectStore
  window.__dualviewTimeline = useTimelineStore
  window.__dualviewMedia = useMediaStore
  window.__dualviewPlayback = usePlaybackStore
}
