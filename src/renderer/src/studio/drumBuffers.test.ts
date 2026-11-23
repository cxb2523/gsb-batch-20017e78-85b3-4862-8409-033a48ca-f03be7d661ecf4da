/**
 * Run with `npm test`. Exercises the drum-sound lifecycle with a fake buffer
 * and a manually driven scheduler, so cache hits, parameter invalidation,
 * switch cancellation and sample-failure fallback can be observed without an
 * AudioContext.
 */
import {
  DrumSoundBank,
  drumSampleKey,
  drumVoiceKey,
  normalizeDrumModel,
  type DrumRenderSettings
} from './drumBuffers'
import type { DrumVoiceId } from './types'

const sampleRate = 48000
let checks = 0

function assert(condition: boolean, message: string): void {
  checks += 1
  if (!condition) throw new Error(`check ${checks} failed: ${message}`)
}

function equal<T>(actual: T, expected: T, message: string): void {
  assert(
    actual === expected,
    `${message}\n  actual   ${String(actual)}\n  expected ${String(expected)}`
  )
}

interface FakeBuffer {
  /** Identifies the render, so tests can prove which sound was played. */
  tag: string
  peak: number
}

/** Records every render so tests can inspect reuse rather than only timing. */
function makeBank() {
  const renders: Array<{ id: DrumVoiceId; settings: DrumRenderSettings; tag: string }> = []
  const tasks: Array<{ run: () => void; cancelled: boolean }> = []
  let counter = 0

  const bank = new DrumSoundBank<FakeBuffer>({
    sampleRate,
    schedule: (task) => {
      const record = { run: task, cancelled: false }
      tasks.push(record)
      return () => {
        record.cancelled = true
      }
    },
    render: (id, settings) => {
      const tag = `${id}/${settings.model}/${settings.tune}/${settings.decay}/${settings.tone}/${settings.drive}#${++counter}`
      renders.push({ id, settings: { ...settings }, tag })
      const data = new Float32Array(8)
      data[0] = 0.9
      return data
    },
    createBuffer: (data) => ({ tag: 'rendered', peak: data[0] })
  })

  /** Run every scheduled task that has not been cancelled. */
  const flush = (): number => {
    let ran = 0
    while (tasks.length) {
      const record = tasks.shift()!
      if (record.cancelled) continue
      record.run()
      ran += 1
    }
    return ran
  }

  return { bank, renders, tasks, flush }
}

const settings = (
  model: DrumRenderSettings['model'],
  tune = 0,
  decay = 1,
  tone = 0.5,
  drive = 0
): DrumRenderSettings => ({ model, tune, decay, tone, drive })

// ---------- Key construction ----------

equal(
  drumVoiceKey('kick', settings('808'), sampleRate),
  drumVoiceKey('kick', settings('808'), sampleRate),
  'identical settings share a key'
)
assert(
  drumVoiceKey('kick', settings('808'), sampleRate) !== drumVoiceKey('snare', settings('808'), sampleRate),
  'voice id is part of the key'
)
assert(
  drumVoiceKey('kick', settings('808'), sampleRate) !== drumVoiceKey('kick', settings('909'), sampleRate),
  'model is part of the key'
)
for (const mutate of [
  (s: DrumRenderSettings) => ({ ...s, tune: s.tune + 1 }),
  (s: DrumRenderSettings) => ({ ...s, decay: s.decay + 1 }),
  (s: DrumRenderSettings) => ({ ...s, tone: s.tone + 0.1 }),
  (s: DrumRenderSettings) => ({ ...s, drive: s.drive + 0.1 })
]) {
  assert(
    drumVoiceKey('kick', settings('808'), sampleRate) !== drumVoiceKey('kick', mutate(settings('808')), sampleRate),
    'every render-affecting parameter is part of the key'
  )
}
// Values renderDrum clamps together must share one cache entry.
equal(
  drumVoiceKey('kick', settings('808', 99, 0.001, 4, -1), sampleRate),
  drumVoiceKey('kick', settings('808', 24, 0.1, 1, 0), sampleRate),
  'clamped-in-equivalent values share one key'
)
// An unknown model falls back to the default, so it shares that entry.
equal(normalizeDrumModel('kick', 'nonsense'), '808', 'unknown model falls back to the first model')
equal(
  drumVoiceKey('kick', settings('nonsense' as never), sampleRate),
  drumVoiceKey('kick', settings('808'), sampleRate),
  'unknown model shares the default model key'
)
assert(drumSampleKey('x') !== drumSampleKey('y'), 'different sample paths have different keys')

// ---------- Cache hit: repeated resolves share one render ----------

{
  const { bank, renders, flush } = makeBank()
  const before = bank.renderCount
  bank.resolve('kick', settings('808'), null)
  bank.resolve('kick', settings('808'), null) // same pad, same sound again
  bank.resolve('snare', settings('808'), null)
  // A repeated trigger/resolve of a sound already wanted must not re-render.
  bank.resolve('snare', settings('808'), null)
  equal(bank.cacheSize, 2, 'one entry per distinct sound, not per resolve')
  const ran = flush()
  equal(ran, 2, 'only the two distinct sounds were rendered')
  equal(renders.length, before + 2, 'renderer ran once per distinct key')
  equal(bank.renderCount, before + 2, 'renderCount counts cache misses')
  const played = bank.get('kick')
  equal(played?.kind, 'synth', 'kick resolves to a synth buffer')
  assert(played !== null && played.buffer.peak > 0.8, 'the rendered buffer is returned')
}

// ---------- Shared entry is released only when the last pad leaves ----------
// Two different pads can share one sound when they play the same sample file.

{
  const { bank, flush } = makeBank()
  const shared = drumSampleKey('disk/shared.wav')
  bank.setSample('disk/shared.wav', { tag: 'shared', peak: 1 })
  bank.resolve('kick', settings('808'), 'disk/shared.wav')
  bank.resolve('snare', settings('fat'), 'disk/shared.wav')
  flush()
  equal(bank.refCount(shared), 2, 'two pads reference the shared sample entry')
  // Move one pad to the synth: the shared entry must survive for the other.
  bank.resolve('kick', settings('808'), null)
  equal(bank.refCount(shared), 1, 'shared entry survives while a pad still uses it')
  assert(bank.hasKey(shared), 'shared entry stays cached')
  // Move the other pad away too: now it is released.
  bank.resolve('snare', settings('fat'), null)
  equal(bank.refCount(shared), 0, 'entry released once the last pad leaves')
  assert(!bank.hasKey(shared), 'released entry is dropped')
}

// ---------- Shared synth entry: one pending render, one render ----------

{
  const { bank, renders, flush } = makeBank()
  // A pad re-resolved to the same synth settings (e.g. a kit edit that did not
  // change this voice) must reuse the one entry and its single scheduled render
  // rather than queueing another.
  bank.resolve('kick', settings('909'), null)
  bank.resolve('kick', settings('909'), null)
  bank.resolve('kick', settings('909'), null)
  equal(bank.cacheSize, 1, 'a shared sound has one entry')
  equal(bank.pendingCount, 1, 'a shared sound has one pending render')
  flush()
  equal(renders.length, 1, 'a shared sound renders once')
  equal(bank.get('kick')?.kind, 'synth', 'the shared sound is ready')
}

// ---------- Parameter invalidation ----------
{
  const { bank, renders, flush } = makeBank()
  bank.resolve('kick', settings('808'), null)
  flush()
  const firstKey = drumVoiceKey('kick', settings('808'), sampleRate)
  const firstBuffer = bank.get('kick')?.buffer
  assert(firstBuffer !== undefined, 'kick rendered')

  // Change a render parameter: a new entry, the old one dropped.
  bank.resolve('kick', settings('808', 0, 1, 0.75), null)
  flush()
  const secondKey = drumVoiceKey('kick', settings('808', 0, 1, 0.75), sampleRate)
  assert(secondKey !== firstKey, 'tone change yields a new key')
  assert(!bank.hasKey(firstKey), 'old parameter entry invalidated')
  assert(bank.hasKey(secondKey), 'new parameter entry cached')
  equal(bank.get('kick')?.buffer.tag, 'rendered', 'new sound is active')
  assert(bank.get('kick')?.buffer !== firstBuffer, 'pad plays the newly rendered buffer')

  // Changing only the model also invalidates.
  bank.resolve('kick', settings('909', 0, 1, 0.75), null)
  flush()
  assert(!bank.hasKey(secondKey), 'model change invalidates the previous entry')
  equal(renders.length, 3, 'each effective change caused exactly one render')
}

// ---------- Switching cancels the in-flight render ----------

{
  const { bank, tasks, flush } = makeBank()
  bank.resolve('kick', settings('boom'), null)
  equal(bank.pendingCount, 1, 'the first sound is scheduled')
  equal(tasks.length, 1, 'one render task queued')

  // Switch before the first render runs.
  bank.resolve('kick', settings('808'), null)
  equal(bank.pendingCount, 1, 'only the newest sound is pending')
  equal(bank.cancelledRenders, 1, 'the superseded render was cancelled')
  assert(tasks[0].cancelled, 'the old task is marked cancelled')
  equal(bank.renderCount, 0, 'nothing rendered yet')

  // A trigger must render only the current sound, never the stale one.
  const sound = bank.ensure('kick')
  equal(bank.renderCount, 1, 'ensure rendered exactly the current sound')
  equal(sound?.kind, 'synth', 'current sound is ready')
  const staleKey = drumVoiceKey('kick', settings('boom'), sampleRate)
  const currentKey = drumVoiceKey('kick', settings('808'), sampleRate)
  assert(!bank.hasKey(staleKey), 'the superseded entry is gone')
  assert(bank.hasKey(currentKey), 'the final choice is cached')

  // Running the now-cancelled task must be a no-op.
  const ran = flush()
  equal(ran, 0, 'the stale task does not run')
  equal(bank.renderCount, 1, 'no stale render happened')
}

// ---------- Rapid switching: the last selection always wins ----------

{
  const { bank, renders, flush } = makeBank()
  const choices = ['808', '909', 'boom', 'rumble'] as const
  for (const model of choices) bank.resolve('kick', settings(model), null)
  flush()
  // Each switch validated the old and scheduled the next; only the last survives.
  equal(bank.renderCount, 1, 'rapid switching coalesced into one render')
  equal(bank.cacheSize, 1, 'only the final sound is cached')
  equal(renders.length, 1, 'only the final model was rendered')
  equal(renders[0].settings.model, 'rumble', 'the render used the last selection')
  equal(bank.get('kick')?.kind, 'synth', 'the last selection is playable')
  equal(bank.pendingCount, 0, 'nothing left pending')
}

// A switch that lands *during* rendering must discard the late result.
{
  let release: (() => void) | null = null
  const order: string[] = []
  const bank = new DrumSoundBank<string, string>({
    sampleRate,
    schedule: (task) => {
      release = task
      return () => {
        order.push('cancel')
      }
    },
    render: (id, settings) => id + ':' + settings.model,
    createBuffer: (data) => data
  })
  bank.resolve('kick', settings('808'), null)
  const firstTask = release as (() => void) | null
  // Switch before the first render completes, then run both tasks.
  bank.resolve('kick', settings('909'), null)
  const secondTask = release as (() => void) | null
  firstTask?.()
  secondTask?.()
  equal(bank.get('kick')?.buffer, 'kick:909', 'the later selection wins')
  equal(bank.cacheSize, 1, 'the stale result never entered the cache')
}

// ---------- Sample lookup shares the same path as synth ----------

{
  const { bank, flush } = makeBank()
  const sample: FakeBuffer = { tag: 'sample', peak: 1 }
  bank.setSample('disk/kick.wav', sample)
  // Pad asks for the sample: found through the same resolve() call.
  const resolved = bank.resolve('kick', settings('808'), 'disk/kick.wav')
  equal(resolved?.kind, 'sample', 'a registered sample is resolved')
  equal(resolved?.key, drumSampleKey('disk/kick.wav'), 'sample key is used')
  equal(bank.renderCount, 0, 'a sample is never synthesized')

  // Clearing the sample makes the pad fall back to its synth voice.
  bank.setSample('disk/kick.wav', null)
  flush()
  equal(bank.get('kick')?.kind, 'synth', 'missing sample falls back to synth')
  assert(bank.refCount(drumSampleKey('disk/kick.wav')) === 0, 'sample entry released')
  assert(bank.refCount(drumVoiceKey('kick', settings('808'), sampleRate)) === 1, 'synth entry now referenced')
}

// ---------- Sample failure fallback (never silent) ----------

{
  const { bank } = makeBank()
  // No sample was ever registered for this path — as when a load failed.
  const sound = bank.resolve('snare', settings('fat'), 'missing/never-loaded.wav')
  // The pending synth result is null until rendered; a trigger forces it.
  assert(sound === null || sound.kind === 'synth', 'unavailable sample never resolves to a sample')
  const played = bank.ensure('snare')
  equal(played?.kind, 'synth', 'a failed sample falls back to the synthesized voice')
  assert(played?.buffer !== undefined, 'the fallback is audible, not silent')
  assert(bank.renderCount === 1, 'the fallback was rendered once')
  equal(bank.hasSample('missing/never-loaded.wav'), false, 'the failed sample is not cached')
}

// A render that throws must not leave the pad permanently silent.
{
  let fail = true
  const bank = new DrumSoundBank<string, string>({
    sampleRate,
    schedule: (task) => {
      task()
      return () => {}
    },
    render: (id) => {
      if (fail) throw new Error('boom')
      return id
    },
    createBuffer: (data) => data
  })
  bank.resolve('kick', settings('808'), null)
  equal(bank.get('kick'), null, 'a failed render yields no buffer')
  fail = false
  equal(bank.ensure('kick')?.kind, 'synth', 'a later attempt can still render')
  equal(bank.renderCount, 1, 'only the successful render is counted')
}

// ---------- release / dispose ----------

{
  const { bank, tasks } = makeBank()
  bank.resolve('kick', settings('808'), null)
  bank.release('kick')
  equal(bank.cacheSize, 0, 'releasing a pad drops its entry')
  assert(tasks[0].cancelled, 'releasing a pad cancels its pending render')
  equal(bank.get('kick'), null, 'a released pad has no sound')

  bank.resolve('snare', settings('808'), null)
  bank.dispose()
  equal(bank.cacheSize, 0, 'dispose clears every entry')
  equal(bank.get('snare'), null, 'dispose clears pad bindings')
}

console.log(`drumBuffers: ${checks} checks passed`)
