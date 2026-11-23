import type { Track } from '@vue-player/core'
import { describe, expect, it } from 'vitest'
import { planSubtitleRefresh, resolveActiveTrack } from '../src/composables/subtitles'

const en: Track = { src: '/en.vtt', label: 'English', language: 'en' }
const ru: Track = { src: '/ru.vtt', label: 'Русский', language: 'ru' }
const frDefault: Track = { src: '/fr.vtt', label: 'Français', language: 'fr', default: true }

describe('resolveActiveTrack', () => {
  it('keeps the current track when the new source provides it again', () => {
    const replacement: Track = { src: '/ru-new.vtt', label: 'Русский', language: 'ru' }
    expect(resolveActiveTrack([en, replacement], ru)).toEqual(replacement)
  })

  it('falls back to the default track when the current one is gone', () => {
    expect(resolveActiveTrack([en, frDefault], ru)).toEqual(frDefault)
  })

  it('picks the default track when nothing is selected', () => {
    expect(resolveActiveTrack([en, frDefault], null)).toEqual(frDefault)
  })

  it('returns null when there are no tracks', () => {
    expect(resolveActiveTrack(undefined, en)).toBeNull()
    expect(resolveActiveTrack([], null)).toBeNull()
  })

  it('returns null when no track is selected and none is default', () => {
    expect(resolveActiveTrack([en, ru], null)).toBeNull()
  })

  it('matches on language and label, not on src URL', () => {
    const replacement = { src: '/en-v2.vtt', label: 'English', language: 'en' }
    expect(resolveActiveTrack([replacement], en)).toEqual(replacement)
  })
})

describe('planSubtitleRefresh', () => {
  it('clears cues and applies nothing while a source is loading', () => {
    expect(planSubtitleRefresh(true, [en, frDefault], ru)).toEqual({
      shouldApplyTrack: false,
      track: ru,
      clearCues: true,
    })
  })

  it('re-applies the current track once loading completes', () => {
    expect(planSubtitleRefresh(false, [en, ru], ru)).toEqual({
      shouldApplyTrack: true,
      track: ru,
      clearCues: false,
    })
  })

  it('falls back to the default track for a new source after load', () => {
    expect(planSubtitleRefresh(false, [en, frDefault], null)).toEqual({
      shouldApplyTrack: true,
      track: frDefault,
      clearCues: false,
    })
  })

  it('turns subtitles off when the new source has no matching track', () => {
    expect(planSubtitleRefresh(false, [en], ru)).toEqual({
      shouldApplyTrack: true,
      track: null,
      clearCues: false,
    })
  })

  it('applies no track when there are no subtitle tracks at all', () => {
    expect(planSubtitleRefresh(false, undefined, null)).toEqual({
      shouldApplyTrack: true,
      track: null,
      clearCues: false,
    })
  })
})
