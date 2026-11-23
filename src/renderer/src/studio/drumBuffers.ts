/**
 * Lifecycle management for the drum machine's sound buffers.
 *
 * A pad resolves to exactly one sound at a time: either a recorded sample that
 * an external owner registered, or a synthesized voice. Both kinds are found
 * through the same `resolve()` path, and synthesized renders are cached by a
 * *voice key* (voice id + model + the parameters that affect the render) so
 * every pad and every repeated trigger that wants the same sound shares one
 * buffer.
 *
 * Entries are reference counted by pads. Changing a pad's sound releases its
 * old entry; when the last pad lets go, the entry is dropped and any render
 * still in flight is cancelled, so stale buffers cannot linger in memory.
 * Renders are scheduled asynchronously, which lets a quick series of switches
 * coalesce: each entry carries a generation token, so a render that finishes
 * after its pad has moved on (a late arrival) is discarded instead of
 * overwriting the newer choice.
 *
 * The class has no DOM/AudioContext dependency: the engine injects the render
 * function and a factory that wraps the raw samples in its own buffer type
 * (AudioBuffer in the app, a plain object in tests).
 */
import { DRUM_MODELS, type DrumModel, type DrumVoice, type DrumVoiceId } from './types'

/** Settings that change what a synthesized drum renders to. */
export type DrumRenderSettings = Pick<DrumVoice, 'model' | 'tune' | 'decay' | 'tone' | 'drive'>

export type DrumSoundKind = 'sample' | 'synth'

/** What a pad currently wants to play. */
export interface DrumSoundRequest {
  id: DrumVoiceId
  settings: DrumRenderSettings
  /** Path of the recorded sample the pad would like to play, or null for synthesis. */
  samplePath: string | null
}

/** A ready-to-play buffer plus where it came from. */
export interface ResolvedDrumSound<B> {
  kind: DrumSoundKind
  /** Cache key: `sample:<path>` or `synth:<voice id>:<model>:<params>:<rate>`. */
  key: string
  buffer: B
}

export interface DrumSoundBankOptions<B, R = Float32Array> {
  /** AudioContext sample rate used for synthesis and cache keys. */
  sampleRate: number
  /** Pure renderer (renderDrum in the app). */
  render: (id: DrumVoiceId, settings: DrumRenderSettings, sampleRate: number) => R
  /** Wraps raw samples in the engine's buffer type. */
  createBuffer: (data: R, sampleRate: number) => B
  /**
   * Runs render work later so a quick second switch can cancel the first.
   * Returns a function that cancels the task. Defaults to a zero-delay timeout.
   */
  schedule?: (task: () => void) => () => void
}

interface BankEntry<B> {
  key: string
  /** How many pads currently resolve to this entry. */
  refs: number
  /** Bumped whenever a pending render is superseded or the entry is reused. */
  token: number
  /** True while a scheduled render has not run yet. */
  pending: boolean
  buffer: B | null
  cancel: (() => void) | null
  id: DrumVoiceId
  settings: DrumRenderSettings
}

interface PadBinding<B> {
  key: string
  kind: DrumSoundKind
  entry: BankEntry<B>
}

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : min
}

/** Mirrors renderDrum's model fallback so an invalid model and the default share one entry. */
export function normalizeDrumModel(id: DrumVoiceId, model: string): DrumModel {
  const models = DRUM_MODELS[id] as readonly string[]
  return (models.includes(model) ? model : models[0]) as DrumModel
}

/**
 * Identity of a synthesized sound. Values are clamped exactly as renderDrum
 * clamps them, so settings that produce an identical render map to one entry
 * and any effective change produces a new key (invalidating the old entry).
 */
export function drumVoiceKey(id: DrumVoiceId, settings: DrumRenderSettings, sampleRate: number): string {
  const rate = clamp(sampleRate, 8000, 192000)
  const model = normalizeDrumModel(id, settings.model)
  const tune = clamp(settings.tune, -24, 24)
  const decay = clamp(settings.decay, 0.1, 4)
  const tone = clamp(settings.tone, 0, 1)
  const drive = clamp(settings.drive, 0, 1)
  return `synth:${id}:${model}:${tune}:${decay}:${tone}:${drive}:${rate}`
}

export function drumSampleKey(path: string): string {
  return `sample:${path}`
}

export class DrumSoundBank<B, R = Float32Array> {
  private readonly entries = new Map<string, BankEntry<B>>()
  private readonly pads = new Map<DrumVoiceId, PadBinding<B>>()
  private readonly requests = new Map<DrumVoiceId, DrumSoundRequest>()
  private readonly samples = new Map<string, B>()
  private readonly sampleRate: number
  private readonly render: DrumSoundBankOptions<B, R>['render']
  private readonly createBuffer: DrumSoundBankOptions<B, R>['createBuffer']
  private readonly schedule: (task: () => void) => () => void

  private rendered = 0
  private cancelled = 0

  constructor(options: DrumSoundBankOptions<B, R>) {
    this.sampleRate = clamp(options.sampleRate, 8000, 192000)
    this.render = options.render
    this.createBuffer = options.createBuffer
    this.schedule =
      options.schedule ??
      ((task) => {
        const handle = setTimeout(task, 0)
        return () => clearTimeout(handle)
      })
  }

  /** Number of live cache entries (one per distinct resolved sound). */
  get cacheSize(): number {
    return this.entries.size
  }

  /** Number of entries whose render has been scheduled but has not run yet. */
  get pendingCount(): number {
    let pending = 0
    for (const entry of this.entries.values()) if (entry.pending) pending += 1
    return pending
  }

  /** Total buffers handed out by the renderer (cache misses). */
  get renderCount(): number {
    return this.rendered
  }

  /** Scheduled renders cancelled because their last pad moved on. */
  get cancelledRenders(): number {
    return this.cancelled
  }

  /** Reference count for a cache key; 0 when no pad uses it. */
  refCount(key: string): number {
    return this.entries.get(key)?.refs ?? 0
  }

  hasKey(key: string): boolean {
    return this.entries.has(key)
  }

  hasSample(path: string): boolean {
    return this.samples.has(path)
  }

  /**
   * Register (or with null, remove) the prepared audio for a sample path.
   * Removing it makes pads that wanted it fall back to their synthesized voice.
   */
  setSample(path: string, buffer: B | null): void {
    if (buffer === null) this.samples.delete(path)
    else this.samples.set(path, buffer)
    this.refresh()
  }

  /**
   * Point a pad at a sound. A pad whose sample is not available falls back to
   * its synthesized voice, so a failed load is heard rather than silent.
   * Returns the buffer when it is already rendered, or null while a synth
   * render is still pending (call `ensure` to force it immediately).
   */
  resolve(id: DrumVoiceId, settings: DrumRenderSettings, samplePath: string | null): ResolvedDrumSound<B> | null {
    const request: DrumSoundRequest = { id, settings: { ...settings }, samplePath }
    this.requests.set(id, request)
    return this.apply(request)
  }

  /** Re-resolve every pad, e.g. after the set of registered samples changed. */
  refresh(): void {
    for (const request of this.requests.values()) this.apply(request)
  }

  /** The pad's current sound, if its buffer is ready. */
  get(id: DrumVoiceId): ResolvedDrumSound<B> | null {
    const binding = this.pads.get(id)
    return binding ? this.resolved(binding) : null
  }

  /**
   * Force the pad's pending synth render to happen now. Used by a trigger so a
   * hit right after a sound change is never silent. Only the pad's *current*
   * sound is rendered, so an earlier, superseded render can never win.
   */
  ensure(id: DrumVoiceId): ResolvedDrumSound<B> | null {
    const binding = this.pads.get(id)
    if (!binding) return null
    const entry = binding.entry
    if (binding.kind === 'synth' && entry.buffer === null) {
      this.cancelPending(entry)
      entry.token += 1
      this.renderEntry(entry, entry.token)
    }
    return this.resolved(binding)
  }

  /** Drop a pad (and its reference) entirely. */
  release(id: DrumVoiceId): void {
    const binding = this.pads.get(id)
    if (!binding) return
    this.pads.delete(id)
    this.requests.delete(id)
    this.releaseEntry(binding.entry)
  }

  /** Cancel every pending render and drop all state. */
  dispose(): void {
    for (const entry of this.entries.values()) this.cancelPending(entry)
    this.entries.clear()
    this.pads.clear()
    this.requests.clear()
    this.samples.clear()
  }

  private apply(request: DrumSoundRequest): ResolvedDrumSound<B> | null {
    const desired = this.describe(request)
    const current = this.pads.get(request.id)
    if (current && current.key === desired.key) {
      // A sample re-registered under the same path replaces its buffer in place.
      if (desired.kind === 'sample' && current.entry.buffer !== desired.buffer) {
        current.entry.buffer = desired.buffer
      }
      return this.resolved(current)
    }

    const entry = this.acquire(desired)
    // Acquire before release: a shared entry must not hit zero in between.
    if (current) this.releaseEntry(current.entry)
    const binding: PadBinding<B> = { key: desired.key, kind: desired.kind, entry }
    this.pads.set(request.id, binding)
    return this.resolved(binding)
  }

  private describe(request: DrumSoundRequest): {
    key: string
    kind: DrumSoundKind
    buffer: B | null
    id: DrumVoiceId
    settings: DrumRenderSettings
  } {
    const path = request.samplePath
    if (path) {
      const buffer = this.samples.get(path)
      if (buffer !== undefined) {
        return { key: drumSampleKey(path), kind: 'sample', buffer, id: request.id, settings: request.settings }
      }
    }
    return {
      key: drumVoiceKey(request.id, request.settings, this.sampleRate),
      kind: 'synth',
      buffer: null,
      id: request.id,
      settings: request.settings
    }
  }

  private acquire(desired: {
    key: string
    kind: DrumSoundKind
    buffer: B | null
    id: DrumVoiceId
    settings: DrumRenderSettings
  }): BankEntry<B> {
    let entry = this.entries.get(desired.key)
    if (!entry) {
      entry = {
        key: desired.key,
        refs: 0,
        token: 0,
        pending: false,
        buffer: desired.buffer,
        cancel: null,
        id: desired.id,
        settings: { ...desired.settings }
      }
      this.entries.set(desired.key, entry)
    }
    entry.refs += 1
    if (desired.kind === 'synth' && entry.buffer === null && !entry.pending) this.scheduleRender(entry)
    return entry
  }

  private scheduleRender(entry: BankEntry<B>): void {
    entry.pending = true
    const token = ++entry.token
    entry.cancel = this.schedule(() => {
      entry.cancel = null
      if (!this.isCurrent(entry) || entry.token !== token) return
      this.renderEntry(entry, token)
    })
  }

  private renderEntry(entry: BankEntry<B>, token: number): void {
    // Check before rendering: a superseded render must not even spend the work.
    if (!this.isCurrent(entry) || entry.token !== token) return
    let buffer: B
    try {
      const data = this.render(entry.id, { ...entry.settings }, this.sampleRate)
      buffer = this.createBuffer(data, this.sampleRate)
    } catch {
      entry.pending = false
      return
    }
    // A switch that landed while we rendered invalidates this result.
    if (!this.isCurrent(entry) || entry.token !== token) return
    entry.buffer = buffer
    entry.pending = false
    this.rendered += 1
  }

  private releaseEntry(entry: BankEntry<B>): void {
    entry.refs -= 1
    if (entry.refs > 0) return
    if (this.cancelPending(entry)) this.cancelled += 1
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key)
  }

  private cancelPending(entry: BankEntry<B>): boolean {
    if (!entry.cancel) return false
    entry.cancel()
    entry.cancel = null
    entry.pending = false
    return true
  }

  private isCurrent(entry: BankEntry<B>): boolean {
    return this.entries.get(entry.key) === entry && entry.refs > 0
  }

  private resolved(binding: PadBinding<B>): ResolvedDrumSound<B> | null {
    const buffer = binding.entry.buffer
    return buffer === null ? null : { kind: binding.kind, key: binding.key, buffer }
  }
}
