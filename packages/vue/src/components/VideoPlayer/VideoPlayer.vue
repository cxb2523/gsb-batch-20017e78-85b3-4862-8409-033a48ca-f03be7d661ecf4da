<script setup lang="ts">
import type { Chapter, Track, VideoSource } from '@vue-player/core'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { isPiPSupported } from '@vue-player/core'
import { planSubtitleRefresh } from '../../composables/subtitles'
import { usePlayer } from '../../composables/usePlayer'
import { useThumbnailCues } from '../../composables/useThumbnailCues'
import IcoPlay from '../icons/IcoPlay.vue'
import IcoPause from '../icons/IcoPause.vue'
import VpPlayButton from '../controls/VpPlayButton.vue'
import VpTimeline from '../controls/VpTimeline.vue'
import VpTimeDisplay from '../controls/VpTimeDisplay.vue'
import VpVolumeControl from '../controls/VpVolumeControl.vue'
import VpSubtitlesButton from '../controls/VpSubtitlesButton.vue'
import VpPiPButton from '../controls/VpPiPButton.vue'
import VpFullscreenButton from '../controls/VpFullscreenButton.vue'
import VpSettingsButton from '../controls/VpSettingsButton.vue'
import VpLoadingOverlay from '../overlays/VpLoadingOverlay.vue'
import VpErrorOverlay from '../overlays/VpErrorOverlay.vue'

interface Props {
  src?: string
  sources?: VideoSource[]
  poster?: string
  autoplay?: boolean
  loop?: boolean
  muted?: boolean
  volume?: number
  playbackRate?: number
  playbackRates?: number[]
  live?: boolean
  keyboard?: boolean
  pip?: boolean
  tracks?: Track[]
  chapters?: Chapter[]
  thumbnails?: string
}

const props = withDefaults(defineProps<Props>(), {
  autoplay: false,
  loop: false,
  muted: false,
  volume: 1,
  playbackRate: 1,
  playbackRates: () => [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2],
  live: false,
  keyboard: true,
  pip: true,
})

const emit = defineEmits<{
  play: []
  pause: []
  ended: []
  timeUpdate: [time: number]
  buffering: [value: boolean]
  speedChange: [rate: number]
  trackChange: [track: import('@vue-player/core').Track | null]
  fullscreenChange: [value: boolean]
  error: [error: import('@vue-player/core').PlayerError]
}>()

const playerEl = ref<HTMLElement | null>(null)
const videoRef = ref<HTMLVideoElement | null>(null)
const { state, controls, loadSource } = usePlayer(videoRef)

const pipSupported = ref(false)

// Poster is visible until playback starts for the first time
const showPoster = computed(() => !!props.poster && !state.isPlaying && state.currentTime === 0)

// ─── Custom subtitle rendering ───
const currentCues = ref<string[]>([])

function syncSubtitles() {
  const video = videoRef.value
  const track = state.currentTrack
  // Never surface cues while a new source is loading — the browser may still
  // report activeCues from the previous track until the track mode is reset.
  if (!video || !track || state.isLoading) {
    currentCues.value = []
    return
  }

  for (const el of Array.from(video.querySelectorAll<HTMLTrackElement>('track'))) {
    const tt = el.track
    if (tt.language === track.language && tt.label === track.label) {
      currentCues.value = tt.activeCues
        ? Array.from(tt.activeCues)
            .map((c) => (c as VTTCue).text)
            .filter(Boolean)
        : []
      return
    }
  }
  currentCues.value = []
}

onMounted(() => {
  pipSupported.value = isPiPSupported()
  if (props.src) loadSource(props.src)
  videoRef.value?.addEventListener('timeupdate', syncSubtitles)
  if (props.autoplay && props.muted) scheduleHide()
})

// While a source is loading, drop any cues from the previous track so stale
// activeCues cannot linger on screen. Once loading completes, re-apply the
// current track (or the new source's default) — at that point all browser
// async track-mode resets from video.load() are guaranteed to have completed.
watch(
  () => state.isLoading,
  (loading) => {
    const plan = planSubtitleRefresh(loading, props.tracks, state.currentTrack)
    if (plan.clearCues) {
      currentCues.value = []
    }
    if (plan.shouldApplyTrack) {
      controls.setTrack(plan.track)
    }
  },
)

onBeforeUnmount(() => videoRef.value?.removeEventListener('timeupdate', syncSubtitles))

watch(
  () => props.src,
  (src) => {
    // Drop rendered subtitles immediately — the loading-flag watcher alone is
    // not enough when one loading source is swapped for another (true→true).
    currentCues.value = []
    if (src) loadSource(src)
  },
)

watch(
  () => state.isPlaying,
  (v) => (v ? emit('play') : emit('pause')),
)
watch(
  () => state.isEnded,
  (v) => {
    if (v) emit('ended')
  },
)
watch(
  () => state.currentTime,
  (v) => emit('timeUpdate', v),
)
watch(
  () => state.isBuffering,
  (v) => emit('buffering', v),
)
watch(
  () => state.playbackRate,
  (v) => emit('speedChange', v),
)
watch(
  () => state.currentTrack,
  (v) => emit('trackChange', v),
)
watch(
  () => state.isFullscreen,
  (v) => emit('fullscreenChange', v),
)
watch(
  () => state.error,
  (v) => {
    if (v) emit('error', v)
  },
)

// ─── Thumbnails ───
// useThumbnailCues holds the race-safe token: a VTT response that arrives
// after a source switch is discarded instead of overwriting the new cues.
const { cues: thumbnailCues } = useThumbnailCues(
  computed(() => ({ src: props.src, thumbnails: props.thumbnails })),
)

// ─── Controls visibility ───
const controlsVisible = ref(true)
const isSeeking = ref(false)
let hideTimer: ReturnType<typeof setTimeout> | null = null

function scheduleHide() {
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = setTimeout(() => {
    if (state.isPlaying && !showPoster.value) controlsVisible.value = false
  }, 3000)
}

function showControls() {
  controlsVisible.value = true
  if (!isSeeking.value) scheduleHide()
}

function onSeekStart() {
  isSeeking.value = true
  controlsVisible.value = true
  if (hideTimer) clearTimeout(hideTimer)
}

function onSeekEnd() {
  isSeeking.value = false
  scheduleHide()
}

function onPointerLeave(event: PointerEvent) {
  if (event.pointerType === 'touch') return
  if (state.isPlaying && !showPoster.value) controlsVisible.value = false
}

// ─── Play/pause flash indicator ───
const flashIcon = ref<'play' | 'pause' | null>(null)
const flashKey = ref(0)
let flashTimer: ReturnType<typeof setTimeout> | null = null

function triggerFlash(icon: 'play' | 'pause') {
  if (flashTimer) clearTimeout(flashTimer)
  flashIcon.value = icon
  flashKey.value++ // remount → restart CSS animation
  flashTimer = setTimeout(() => {
    flashIcon.value = null
  }, 700)
}

function togglePlay() {
  if (state.isPlaying) {
    controls.pause()
    triggerFlash('pause')
  } else {
    controls.play()
    triggerFlash('play')
  }
}

// ─── Keyboard shortcuts ───
function onKeydown(e: KeyboardEvent) {
  if (!props.keyboard) return
  showControls()
  const map: Record<string, () => void> = {
    Space: () => {
      e.preventDefault()
      togglePlay()
    },
    KeyK: () => {
      e.preventDefault()
      togglePlay()
    },
    ArrowLeft: () => {
      e.preventDefault()
      controls.seek(state.currentTime - 5)
    },
    ArrowRight: () => {
      e.preventDefault()
      controls.seek(state.currentTime + 5)
    },
    ArrowUp: () => {
      e.preventDefault()
      controls.setVolume(state.volume + 0.1)
    },
    ArrowDown: () => {
      e.preventDefault()
      controls.setVolume(state.volume - 0.1)
    },
    KeyM: () => controls.toggleMute(),
    KeyF: () => controls.toggleFullscreen(),
    KeyP: () => {
      if (props.pip && pipSupported.value) controls.togglePiP()
    },
  }
  map[e.code]?.()
}

function onTouchStart(e: TouchEvent) {
  if (!controlsVisible.value) {
    e.preventDefault()
  }
  showControls()
}
</script>

<template>
  <div
    ref="playerEl"
    class="vp-player"
    :class="{ 'vp-controls-hidden': !controlsVisible }"
    tabindex="0"
    @mousedown.capture="playerEl?.focus()"
    @mousemove="showControls"
    @pointerleave="onPointerLeave"
    @touchstart="onTouchStart"
    @touchmove.passive="showControls"
    @keydown="onKeydown"
  >
    <!-- Video area: clipped to border-radius, isolated from menu/tooltip overflow -->
    <div class="vp-video-area">
      <video
        ref="videoRef"
        :loop="loop"
        :muted="muted"
        :autoplay="autoplay"
        preload="metadata"
        crossorigin="anonymous"
        playsinline
        webkit-playsinline
      >
        <track
          v-for="track in tracks"
          :key="track.src"
          :src="track.src"
          :label="track.label"
          :srclang="track.language"
          :kind="track.kind ?? 'subtitles'"
        />
      </video>

      <!-- Poster overlay: cover-fit, fades out once playback starts -->
      <Transition name="vp-poster">
        <div
          v-if="showPoster"
          class="vp-poster"
          :style="{ backgroundImage: `url(${props.poster})` }"
        />
      </Transition>
    </div>

    <!-- Custom subtitle overlay — positioned above controls bar -->
    <div v-if="currentCues.length > 0" class="vp-subtitles" aria-live="polite">
      <span v-for="(cue, i) in currentCues" :key="i" class="vp-subtitle-cue">{{ cue }}</span>
    </div>

    <!-- Transparent click area for play/pause — sits above video, below overlays/controls -->
    <div class="vp-video-click-area" @click="togglePlay" />

    <!-- Play/pause flash animation — key remount restarts CSS animation without Vue Transition flicker -->
    <div v-if="flashIcon" :key="flashKey" class="vp-play-flash">
      <div class="vp-play-flash-circle">
        <IcoPause v-if="flashIcon === 'pause'" />
        <IcoPlay v-else />
      </div>
    </div>

    <!-- Loading overlay -->
    <VpLoadingOverlay v-if="state.isLoading || state.isBuffering">
      <slot name="loading" />
    </VpLoadingOverlay>

    <!-- Error overlay -->
    <VpErrorOverlay v-else-if="state.error" :error="state.error" @retry="controls.retry">
      <template #default="slotProps">
        <slot name="error" v-bind="slotProps" />
      </template>
    </VpErrorOverlay>

    <!-- Controls -->
    <div class="vp-controls">
      <VpTimeline
        :current-time="state.currentTime"
        :duration="state.duration"
        :buffered="state.buffered"
        :chapters="chapters"
        :thumbnail-cues="thumbnailCues.length ? thumbnailCues : undefined"
        @seek="controls.seek"
        @seekstart="onSeekStart"
        @seekend="onSeekEnd"
      />

      <slot name="controls" :state="state" :player="controls">
        <div class="vp-controls-row">
          <VpPlayButton :is-playing="state.isPlaying" @click="togglePlay" />

          <VpVolumeControl
            :volume="state.volume"
            :is-muted="state.isMuted"
            @toggle-mute="controls.toggleMute"
            @set-volume="controls.setVolume"
          />

          <VpTimeDisplay :current-time="state.currentTime" :duration="state.duration" />

          <div class="vp-spacer" />

          <span v-if="state.isLive || live" class="vp-live-badge">
            <span class="vp-live-dot" />
            Live
          </span>

          <VpSubtitlesButton
            v-if="tracks && tracks.length > 0"
            :tracks="tracks"
            :current-track="state.currentTrack"
            @set-track="controls.setTrack"
          />

          <VpPiPButton
            v-if="pip && pipSupported"
            :is-pi-p="state.isPiP"
            @click="controls.togglePiP"
          />

          <VpSettingsButton
            :playback-rate="state.playbackRate"
            :playback-rates="playbackRates"
            :available-qualities="state.availableQualities"
            :current-quality="state.currentQuality"
            :is-fullscreen="state.isFullscreen"
            @set-speed="controls.setSpeed"
            @set-quality="controls.setQuality"
          />

          <VpFullscreenButton
            :is-fullscreen="state.isFullscreen"
            @click="controls.toggleFullscreen"
          />
        </div>
      </slot>
    </div>
  </div>
</template>
