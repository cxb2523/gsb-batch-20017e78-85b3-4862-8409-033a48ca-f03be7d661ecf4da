import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  advanceImpactTimeline,
  applyImpactPreset,
  createImpactPlayback,
  createImpactSeed,
  createImpactTimeline,
  DEFAULT_IMPACT_DURATION,
  IMPACT_TIME_REFLECT_INTERVAL,
  isManualImpactTimeChange,
  isPanelEdit,
  reseedImpactTimeline,
  setImpactAutoplay,
  setImpactDuration,
  seekImpactTimeline,
  shouldAcceptImpactTimeEdit,
} from './impactTimeline'

/** Deterministic random source: replays the given values, then repeats the last one. */
const sequence = (...values: number[]) => {
  let index = 0
  return () => values[Math.min(index++, values.length - 1)]
}

const timelineAt = (time: number, overrides: Partial<Parameters<typeof createImpactTimeline>[0]> = {}) =>
  createImpactTimeline({ time, duration: 1, autoplay: true, seed: 7, ...overrides })

const PANEL_EDIT = { initial: false, fromPanel: true }
const PROGRAMMATIC_ECHO = { initial: false, fromPanel: false }

describe('preset switching', () => {
  test('restarts time at 0 and redraws the seed', () => {
    const timeline = timelineAt(0.8)
    const next = applyImpactPreset(timeline, { duration: 0.7 }, sequence(0.42))

    assert.equal(next.time, 0)
    assert.equal(next.seed, createImpactSeed(sequence(0.42)))
    assert.notEqual(next.seed, timeline.seed)
  })

  test('applies the preset duration immediately, not on the frame after', () => {
    const next = applyImpactPreset(timelineAt(0.3, { duration: 2 }), { duration: 0.5 })

    assert.equal(next.duration, 0.5)
  })

  test('resumes autoplay and clears any in-flight scrub', () => {
    const paused = { ...timelineAt(0.4), autoplay: false, scrubbing: true }
    const next = applyImpactPreset(paused, { duration: 1 })

    assert.equal(next.autoplay, true)
    assert.equal(next.scrubbing, false)
  })

  test('draws a different seed even when the random source collides', () => {
    const next = applyImpactPreset(timelineAt(0.5, { seed: 250 }), { duration: 1 }, sequence(0.25))

    assert.equal(next.seed, 251)
    assert.notEqual(next.seed, 250)
  })

  test('wraps the reseed at the top of the seed range', () => {
    const next = reseedImpactTimeline(1000, sequence(1))
    assert.equal(next, 0)
  })

  test('a preset seeded at 0 still gets a usable, different seed', () => {
    const next = applyImpactPreset(timelineAt(0.9, { seed: 0 }), { duration: 1 }, sequence(0))
    assert.notEqual(next.seed, 0)
  })

  test('starts the next frame at time 0 with the new duration', () => {
    const playback = createImpactPlayback({ duration: 2, seed: 3, random: sequence(0.99) })
    playback.seekFromPanel(0.75)
    playback.applyPreset({ duration: 0.5 })

    const step = playback.advance(0.25)

    // 0.25s of a 0.5s loop is half the timeline, proving duration took effect at once.
    assert.equal(step.time, 0.5)
    assert.equal(playback.state.duration, 0.5)
  })
})

describe('autoplay loop', () => {
  test('wraps past 1, resets time and swaps the seed in the same step', () => {
    const { timeline, looped } = advanceImpactTimeline(timelineAt(0.9, { seed: 11 }), 0.2, sequence(0.5))

    assert.equal(looped, true)
    assert.equal(timeline.time, 0)
    assert.notEqual(timeline.seed, 11)
  })

  test('never pairs a new seed with the stale playhead', () => {
    const { timeline } = advanceImpactTimeline(timelineAt(0.99, { seed: 11 }), 5, sequence(0.2))

    assert.equal(timeline.time, 0)
    assert.equal(timeline.seed, createImpactSeed(sequence(0.2)))
  })

  test('advances normally below the boundary', () => {
    const { timeline, looped } = advanceImpactTimeline(timelineAt(0.2, { duration: 2 }), 0.5)

    assert.equal(looped, false)
    assert.equal(timeline.time, 0.45)
  })

  test('is a no-op while paused', () => {
    const timeline = timelineAt(0.4, { autoplay: false })
    const { timeline: next, looped } = advanceImpactTimeline(timeline, 1)

    assert.equal(next, timeline)
    assert.equal(looped, false)
  })

  test('is a no-op with a zero or negative duration', () => {
    for (const duration of [0, -1]) {
      const timeline = setImpactDuration(createImpactTimeline({ time: 0.4 }), duration)
      assert.equal(timeline.duration, 0)
      assert.equal(advanceImpactTimeline(timeline, 1).timeline, timeline)
    }
  })

  test('is a no-op with a non-positive delta', () => {
    const timeline = timelineAt(0.4)
    assert.equal(advanceImpactTimeline(timeline, 0).timeline, timeline)
    assert.equal(advanceImpactTimeline(timeline, -1).timeline, timeline)
  })
})

describe('control mirroring', () => {
  test('refreshes the time control at the throttled cadence, not every frame', () => {
    const playback = createImpactPlayback({ duration: 1, seed: 1 })
    const frames = Array.from({ length: 12 }, () => playback.advance(1 / 60).reflect)
    const refreshes = frames.filter(Boolean).length

    // ~0.2s of playback at 0.1s cadence: at most a couple of refreshes, never 12.
    assert.ok(refreshes <= 3, `expected throttled refreshes, got ${refreshes}`)
    assert.ok(refreshes >= 1, 'expected at least one refresh')
  })

  test('refreshes immediately on the loop boundary', () => {
    const playback = createImpactPlayback({ duration: 1, seed: 1, random: sequence(0.3) })
    for (let i = 0; i < 30; i++) playback.advance(1 / 60)
    const step = playback.advance(0.6)

    assert.equal(step.looped, true)
    assert.equal(step.reflect, true)
    assert.equal(step.time, 0)
  })

  test('only panel edits count as manual time changes', () => {
    assert.equal(isPanelEdit(PANEL_EDIT), true)
    assert.equal(isPanelEdit(PROGRAMMATIC_ECHO), false)
    assert.equal(isPanelEdit({ initial: true, fromPanel: true }), false)
    assert.equal(isPanelEdit({}), false)
  })

  test('echoes of the current value are not treated as seeks', () => {
    const timeline = timelineAt(0.35)
    assert.equal(isManualImpactTimeChange(timeline, 0.35), false)
    assert.equal(isManualImpactTimeChange(timeline, 0.5), true)
  })

  test('combines origin and value checks into one seek decision', () => {
    const timeline = timelineAt(0.4)

    assert.equal(shouldAcceptImpactTimeEdit(timeline, 0.7, PANEL_EDIT), true)
    assert.equal(shouldAcceptImpactTimeEdit(timeline, 0.4, PANEL_EDIT), false)
    assert.equal(shouldAcceptImpactTimeEdit(timeline, 0.7, PROGRAMMATIC_ECHO), false)
    assert.equal(shouldAcceptImpactTimeEdit(timeline, 0.7, { initial: true }), false)
  })

  test('a seek from a programmatic echo is rejected by the playback controller', () => {
    const playback = createImpactPlayback({ duration: 1, seed: 1 })
    assert.equal(playback.seekFromPanel(0.4), true)
    assert.equal(playback.seekFromPanel(0.4), false)
    assert.equal(playback.state.time, 0.4)

    // Switching preset resets time; a late echo of the old playhead must not resurrect it.
    playback.applyPreset({ duration: 1 })
    assert.equal(playback.state.time, 0)
    assert.equal(playback.seekFromPanel(0.4), true)
  })

  test('a throttled control refresh does not move the timeline backwards', () => {
    const playback = createImpactPlayback({ duration: 1, seed: 1 })
    playback.advance(0.12)
    const before = playback.state.time

    // Simulate leva echoing the refreshed value back through onChange.
    assert.equal(playback.seekFromPanel(before), false)
    assert.equal(playback.state.time, before)
  })
})

describe('manual scrubbing', () => {
  test('stops at the user value while autoplay is off', () => {
    const playback = createImpactPlayback({ duration: 1, seed: 1 })

    playback.setAutoplayFromPanel(false)
    playback.seekFromPanel(0.62)
    const step = playback.advance(1)

    assert.equal(step.time, 0.62)
    assert.equal(playback.state.time, 0.62)
    assert.equal(step.reflect, false)
  })

  test('resumes from the user value when autoplay is turned back on', () => {
    const playback = createImpactPlayback({ duration: 1, seed: 1 })

    playback.setAutoplayFromPanel(false)
    playback.seekFromPanel(0.62)
    playback.setAutoplayFromPanel(true)

    const step = playback.advance(0.2)

    assert.ok(Math.abs(step.time - 0.82) < 1e-9, `expected 0.82, got ${step.time}`)
  })

  test('holds the playhead while the user drags, even with autoplay on', () => {
    const playback = createImpactPlayback({ duration: 1, seed: 1 })

    playback.beginScrub()
    playback.seekFromPanel(0.3)
    const step = playback.advance(0.1)

    assert.equal(step.time, 0.3)

    playback.endScrub()
    assert.equal(playback.advance(0.1).time, 0.4)
  })

  test('the loop boundary can still be crossed after a resume', () => {
    const playback = createImpactPlayback({ duration: 1, seed: 5, random: sequence(0.4) })

    playback.seekFromPanel(0.95)
    const step = playback.advance(0.2)

    assert.equal(step.looped, true)
    assert.equal(step.time, 0)
    assert.notEqual(step.seed, 5)
  })
})

describe('timeline invariants', () => {
  test('clamps seeks to the 0..1 range', () => {
    assert.equal(seekImpactTimeline(timelineAt(0.2), 2).time, 1)
    assert.equal(seekImpactTimeline(timelineAt(0.2), -3).time, 0)
    assert.equal(seekImpactTimeline(timelineAt(0.2), Number.NaN).time, 0)
  })

  test('ignores unusable durations instead of breaking the loop math', () => {
    const timeline = timelineAt(0.2, { duration: 1 })
    assert.equal(setImpactDuration(timeline, Number.NaN).duration, 0)
    assert.equal(setImpactDuration(timeline, -2).duration, 0)
    assert.equal(setImpactDuration(timeline, 0).duration, 0)
  })

  test('defaults to the shader duration when none is given', () => {
    assert.equal(createImpactTimeline().duration, DEFAULT_IMPACT_DURATION)
    assert.equal(createImpactTimeline({ duration: Number.NaN }).duration, DEFAULT_IMPACT_DURATION)
  })

  test('toggling autoplay to the same value keeps identity', () => {
    const timeline = timelineAt(0.2)
    assert.equal(setImpactAutoplay(timeline, true), timeline)
  })

  test('time never exceeds 1 across a long run', () => {
    const playback = createImpactPlayback({ duration: 0.3, seed: 1 })
    for (let i = 0; i < 1000; i++) {
      const step = playback.advance(0.016)
      assert.ok(step.time >= 0 && step.time <= 1)
    }
  })

  test('the reflect interval is a sane positive number', () => {
    assert.ok(IMPACT_TIME_REFLECT_INTERVAL > 0 && IMPACT_TIME_REFLECT_INTERVAL <= 0.25)
  })
})
