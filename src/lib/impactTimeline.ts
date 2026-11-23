/**
 * Single source of truth for the Impact composition's animation timeline.
 *
 * The render loop, the preset buttons and the leva controls all read and write
 * this state instead of keeping their own copies of time/seed/duration. The
 * transitions are pure functions so the convergence rules can be tested
 * without a browser, and `createImpactPlayback` bundles them into the small
 * mutable controller the page keeps for the lifetime of the component.
 */

export type ImpactTimeline = {
  /** Normalized playback position, 0..1. */
  time: number
  /** Seed handed to the shader so each loop reads differently. */
  seed: number
  /** Seconds a full 0..1 cycle takes. */
  duration: number
  autoplay: boolean
  /** True while the user is interacting with the time control. */
  scrubbing: boolean
}

export type ImpactTimelineInit = Partial<Pick<ImpactTimeline, 'time' | 'seed' | 'duration' | 'autoplay'>>

export type ImpactTimelinePreset = {
  duration: number
}

export type ImpactAdvance = {
  time: number
  seed: number
  /** Whether the time control should be refreshed from the timeline. */
  reflect: boolean
  /** Whether this step wrapped past 1. */
  looped: boolean
}

export type ImpactTimelineContext = {
  initial?: boolean
  fromPanel?: boolean
}

export const MAX_IMPACT_SEED = 1000

/** How often the time slider is refreshed while playing, in seconds of wall time. */
export const IMPACT_TIME_REFLECT_INTERVAL = 0.1

const EPSILON = 1e-6

/**
 * Programmatic slider refreshes echo back through leva's onChange. Only edits
 * that originated from the panel may move the playhead, so echoes — including
 * late or stale ones — can never overwrite the timeline.
 */
export const isPanelEdit = (context: ImpactTimelineContext) => !context.initial && !!context.fromPanel

/**
 * Decides whether a time-control event should be applied as a seek. Combines
 * the origin check (panel vs. echo) with a value check so a refresh that happens
 * to carry the current playhead is a no-op instead of a feedback loop.
 */
export const shouldAcceptImpactTimeEdit = (timeline: ImpactTimeline, value: number, context: ImpactTimelineContext) =>
  isPanelEdit(context) && isManualImpactTimeChange(timeline, value)

const clampTime = (time: number) => {
  if (!Number.isFinite(time)) return 0
  return Math.min(Math.max(time, 0), 1)
}

export const createImpactSeed = (random: () => number = Math.random) => Math.round(random() * MAX_IMPACT_SEED)

/** Draws a seed that is guaranteed to differ from the current one. */
export const reseedImpactTimeline = (seed: number, random: () => number = Math.random) => {
  const next = createImpactSeed(random)
  return next === seed ? (next + 1) % (MAX_IMPACT_SEED + 1) : next
}

/** The control echoes this value back; a value this close to the playhead is not a user edit. */
export const isManualImpactTimeChange = (timeline: ImpactTimeline, controlTime: number) => {
  if (!Number.isFinite(controlTime)) return true
  return Math.abs(controlTime - timeline.time) > EPSILON
}

/** Default cycle length, matching `defaultImpactUniforms.duration`. */
export const DEFAULT_IMPACT_DURATION = 1

const normalizeDuration = (duration: number | undefined, fallback: number) =>
  typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? duration : fallback

export const createImpactTimeline = (init: ImpactTimelineInit = {}): ImpactTimeline => ({
  time: clampTime(init.time ?? 0),
  seed: init.seed ?? 0,
  duration: normalizeDuration(init.duration, DEFAULT_IMPACT_DURATION),
  autoplay: init.autoplay ?? true,
  scrubbing: false,
})

export const seekImpactTimeline = (timeline: ImpactTimeline, time: number): ImpactTimeline => {
  const next = clampTime(time)
  return next === timeline.time ? timeline : { ...timeline, time: next }
}

/** A non-positive or invalid duration means "do not advance", never a divide-by-zero. */
export const setImpactDuration = (timeline: ImpactTimeline, duration: number): ImpactTimeline => {
  const next = normalizeDuration(duration, 0)
  return next === timeline.duration ? timeline : { ...timeline, duration: next }
}

export const setImpactAutoplay = (timeline: ImpactTimeline, autoplay: boolean): ImpactTimeline =>
  autoplay === timeline.autoplay ? timeline : { ...timeline, autoplay }

export const setImpactScrubbing = (timeline: ImpactTimeline, scrubbing: boolean): ImpactTimeline =>
  scrubbing === timeline.scrubbing ? timeline : { ...timeline, scrubbing }

/**
 * Switching preset restarts playback from scratch: time goes back to 0, the seed
 * is redrawn and the new duration takes effect on the very next frame.
 */
export const applyImpactPreset = (
  timeline: ImpactTimeline,
  preset: ImpactTimelinePreset,
  random: () => number = Math.random,
): ImpactTimeline => ({
  ...setImpactDuration(timeline, preset.duration),
  time: 0,
  seed: reseedImpactTimeline(timeline.seed, random),
  autoplay: true,
  scrubbing: false,
})

/**
 * Advances playback. Returns the same timeline when paused, scrubbing or when
 * duration is not usable. Crossing 1 wraps to 0 and reseeds in the same
 * transition, so a new seed is never paired with the old time.
 */
export const advanceImpactTimeline = (
  timeline: ImpactTimeline,
  delta: number,
  random: () => number = Math.random,
): { timeline: ImpactTimeline; looped: boolean } => {
  if (!timeline.autoplay || timeline.scrubbing || timeline.duration <= 0 || !(delta > 0)) {
    return { timeline, looped: false }
  }

  const nextTime = timeline.time + delta / timeline.duration

  if (nextTime > 1) {
    return {
      timeline: { ...timeline, time: 0, seed: reseedImpactTimeline(timeline.seed, random) },
      looped: true,
    }
  }

  return { timeline: { ...timeline, time: nextTime }, looped: false }
}

/**
 * Mutable timeline controller used by the page. It owns the state; callers push
 * user edits in and pull renderable values + control-refresh decisions out.
 */
export const createImpactPlayback = (init: ImpactTimelineInit & { random?: () => number } = {}) => {
  const { random = Math.random, ...timelineInit } = init
  let timeline = createImpactTimeline(timelineInit)
  let reflectElapsed = 0

  return {
    get state() {
      return timeline
    },

    advance(delta: number): ImpactAdvance {
      const { timeline: next, looped } = advanceImpactTimeline(timeline, delta, random)
      timeline = next

      if (!timeline.autoplay || timeline.scrubbing) {
        reflectElapsed = 0
        return { time: timeline.time, seed: timeline.seed, reflect: false, looped: false }
      }

      if (looped) {
        reflectElapsed = 0
        return { time: timeline.time, seed: timeline.seed, reflect: true, looped: true }
      }

      reflectElapsed += delta
      const reflect = reflectElapsed + EPSILON >= IMPACT_TIME_REFLECT_INTERVAL
      if (reflect) reflectElapsed = 0

      return { time: timeline.time, seed: timeline.seed, reflect, looped: false }
    },

    applyPreset(preset: ImpactTimelinePreset) {
      timeline = applyImpactPreset(timeline, preset, random)
      reflectElapsed = 0
      return timeline
    },

    /** Returns true when the edit actually moved the playhead. */
    seekFromPanel(value: number) {
      if (!isManualImpactTimeChange(timeline, value)) return false
      timeline = seekImpactTimeline(timeline, value)
      reflectElapsed = 0
      return true
    },

    setDurationFromPanel(value: number) {
      timeline = setImpactDuration(timeline, value)
      return timeline.duration
    },

    setAutoplayFromPanel(value: boolean) {
      timeline = setImpactAutoplay(timeline, value)
      reflectElapsed = 0
      return timeline.autoplay
    },

    beginScrub() {
      timeline = setImpactScrubbing(timeline, true)
    },

    endScrub() {
      timeline = setImpactScrubbing(timeline, false)
      reflectElapsed = 0
    },
  }
}

export type ImpactPlayback = ReturnType<typeof createImpactPlayback>
