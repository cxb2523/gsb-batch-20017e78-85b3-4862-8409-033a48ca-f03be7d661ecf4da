import type { App } from 'vue'
import { VideoPlayer } from './components/VideoPlayer'

export { VideoPlayer }
export { default as VpSettingsButton } from './components/controls/VpSettingsButton.vue'
export type { PlayerEngineOptions } from './composables/playerEngine'
export { planSubtitleRefresh, resolveActiveTrack } from './composables/subtitles'
export { usePlayer } from './composables/usePlayer'
export type { PlayerControls } from './composables/usePlayer'
export { useThumbnailCues } from './composables/useThumbnailCues'
export { createThumbnailLoader } from './composables/useThumbnails'
export type { ThumbnailParser } from './composables/useThumbnails'

export default {
  install(app: App) {
    app.component('VideoPlayer', VideoPlayer)
  },
}
