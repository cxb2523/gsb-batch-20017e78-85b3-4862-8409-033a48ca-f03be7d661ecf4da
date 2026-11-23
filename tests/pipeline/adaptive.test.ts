import { describe, it, expect, afterEach } from 'vitest'
import { AdaptiveController } from '~/pipeline/adaptive'
import { InputRateMeter } from '~/pipeline/input_rate'
import { setupPostMessageInput } from '~/pipeline/transports/input_postmessage'
import type { RendererStats } from '~/pipeline/messages'
import type { PipelineError } from '~/pipeline/errors'
import type { ManualPreset, ModelName } from '~/pipeline/presets'
import { syntheticCamera, sleep } from '../helpers/pipeline'

const stats = (fps: number, modelMs = 20): RendererStats => ({
  fps, modelFps: fps / 2, modelMs, displayMs: 1, skipped: 0, preset: 'medium', skipFrames: 1,
  enabled: true, inputPath: 'mstp', outputPath: 'mstg', backend: 'webgpu',
})

// Drive the controller with a fake clock: one tick every 2 s for `seconds`.
async function run(inputFps: number | null, renderedFps: number, seconds = 30) {
  const swaps: string[] = []
  const t0 = 1_000_000
  const c = new AdaptiveController({
    backendKind:  'webgpu',
    initialModel: 'medium',
    getInputFps:  () => inputFps,
    fetchWeights: async () => new ArrayBuffer(8),
    getStats:     async () => stats(renderedFps),
    swapPreset:   async (p) => { swaps.push(typeof p === 'string' ? p : p.model) },
  }, t0)
  for (let t = 0; t <= seconds * 1000; t += 2000) await c.tick(t0 + t)
  return swaps
}

describe('AdaptiveController target = min(measured input fps, 30)', () => {
  it('a 15 fps camera rendering 15 fps is on target: no downgrade', async () => {
    expect(await run(15, 15)).toEqual([])
  })

  it('a 30 fps camera rendering 15 fps is overloaded: downgrades', async () => {
    expect(await run(30, 15)).toEqual(['small'])
  })

  it('unknown input rate falls back to the 30 fps assumption (0.0.18 behaviour)', async () => {
    expect(await run(null, 15)).toEqual(['small'])
  })

  it('a 15 fps camera rendering 8 fps (below 2/3 of target) still downgrades', async () => {
    expect(await run(15, 8)).toEqual(['small'])
  })

  it('targetFps is capped at 30 and clamped for near-zero rates', () => {
    const mk = (fps: number) => new AdaptiveController({
      backendKind: 'webgl', initialModel: 'small', getInputFps: () => fps,
      fetchWeights: async () => new ArrayBuffer(0), getStats: async () => stats(30), swapPreset: async () => {},
    })
    expect(mk(60).targetFps()).toBe(30)
    expect(mk(15).targetFps()).toBe(15)
    expect(mk(0.5).targetFps()).toBe(5)
  })
})

// ── Swap serialization ──────────────────────────────────────────────────────
// The controller must never run two weight fetches / preset rebuilds at once,
// must keep the old tier on failure, and must be inert after stop(). We drive
// it with an injected clock and a manually settled fetchWeights promise so a
// "slow weight download" can be held open across ticks.

const T0 = 1_000_000
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise<void>(r => setTimeout(r, 0)) }

function harness(initialModel: ModelName = 'medium', opts: { backendKind?: 'webgpu' | 'webgl'; getInputFps?: () => number | null } = {}) {
  const fetched: ModelName[] = []
  const swaps: ManualPreset[] = []
  const errors: PipelineError[] = []
  let statsNow = stats(15)
  // Pending fetch, settled by the test to model a slow/async weight pull.
  let settle: { resolve: (b: ArrayBuffer) => void; reject: (e: unknown) => void } | null = null
  let autoFetch = false

  const c = new AdaptiveController({
    backendKind:  opts.backendKind ?? 'webgpu',
    initialModel,
    getInputFps:  opts.getInputFps ?? (() => 30),
    fetchWeights: (model) => {
      fetched.push(model)
      if (autoFetch) return Promise.resolve(new ArrayBuffer(8))
      return new Promise<ArrayBuffer>((resolve, reject) => { settle = { resolve, reject } })
    },
    getStats:     async () => statsNow,
    swapPreset:   async (p) => { swaps.push(p as ManualPreset) },
    onError:      (e) => errors.push(e),
  }, T0)

  return {
    c, fetched, swaps, errors,
    setStats: (s: RendererStats) => { statsNow = s },
    settleOk: async () => { settle!.resolve(new ArrayBuffer(8)); settle = null; await flush() },
    settleErr: async (e: unknown = new Error('weights 404')) => { settle!.reject(e); settle = null; await flush() },
    autoFetch: () => { autoFetch = true },
    get pending() { return settle !== null },
  }
}

// Tick at T0 + each offset; a single tick that starts a swap leaves the fetch
// pending, so only one tick per call is needed to get a swap in flight.
async function ticks(h: ReturnType<typeof harness>, offsets: number[]) {
  for (const o of offsets) await h.c.tick(T0 + o)
}

describe('AdaptiveController swap serialization', () => {
  // Constructor starts the cooldown at T0, so the first eligible poll is
  // +10 s and a 5 s overshoot completes at +16 s.
  const FIRST_SWAP = [10000, 12000, 14000, 16000]

  it('records the same preset it handed to swapPreset on a normal downgrade', async () => {
    const h = harness('medium')
    h.setStats(stats(15))                 // 15 < 30 * 2/3 under a 30 fps input
    await ticks(h, FIRST_SWAP)
    expect(h.fetched).toEqual(['small'])
    expect(h.swaps).toEqual([])           // weights still in flight
    expect(h.c.currentModel).toBe('medium')

    await h.settleOk()
    expect(h.swaps).toHaveLength(1)
    expect(h.swaps[0].model).toBe('small')
    expect(h.c.currentModel).toBe('small')
    expect(h.c.currentModel).toBe(h.swaps[0].model)
    expect(h.errors).toEqual([])
  })

  it('does not start a second fetch while the first swap is in flight', async () => {
    const h = harness('medium')
    h.setStats(stats(15))
    await ticks(h, FIRST_SWAP)
    expect(h.fetched).toEqual(['small'])
    // Still overloaded and past the 10 s cooldown, but the swap hasn't settled.
    await ticks(h, [18000, 22000, 26000, 30000])
    expect(h.fetched).toEqual(['small'])

    await h.settleOk()
    expect(h.c.currentModel).toBe('small')
    // After it settles the controller can act again once both windows elapse
    // (cooldown from +16 s → +26 s, then a fresh 5 s overshoot → +32 s).
    await ticks(h, [28000, 32000])
    expect(h.fetched).toEqual(['small'])
    await ticks(h, [34000])
    expect(h.fetched).toEqual(['small', 'xs'])
    await h.settleOk()
    expect(h.c.currentModel).toBe('xs')
  })

  it('keeps the old tier and its cooldown on failure, reporting a recoverable error', async () => {
    const h = harness('medium')
    h.setStats(stats(15))
    await ticks(h, FIRST_SWAP)
    expect(h.fetched).toEqual(['small'])

    await h.settleErr()
    expect(h.c.currentModel).toBe('medium')
    expect(h.swaps).toEqual([])
    expect(h.errors).toHaveLength(1)
    expect(h.errors[0]).toMatchObject({ type: 'adaptive', fatal: false, recoverable: true, source: 'adaptive' })
    expect(h.errors[0].message).toContain('weights 404')

    // Cooldown was consumed by the failed attempt: nothing until +26 s.
    await ticks(h, [18000, 22000])
    expect(h.fetched).toEqual(['small'])
    // …then a fresh 5 s overshoot (+26 s → +32 s) re-arms the downgrade.
    await ticks(h, [26000, 30000])
    expect(h.fetched).toEqual(['small'])
    await ticks(h, [32000])
    expect(h.fetched).toEqual(['small', 'small'])
  })

  it('does not record an in-flight swap result after stop()', async () => {
    const h = harness('medium')
    h.setStats(stats(15))
    await ticks(h, FIRST_SWAP)
    expect(h.fetched).toEqual(['small'])

    h.c.stop()
    await h.settleOk()
    // The late result must neither be applied nor reach swapPreset.
    expect(h.c.currentModel).toBe('medium')
    expect(h.swaps).toEqual([])
    expect(h.errors).toEqual([])
  })

  it('starts no new swap after stop()', async () => {
    const h = harness('medium')
    h.c.stop()
    h.setStats(stats(15))
    await ticks(h, [...FIRST_SWAP, 24000, 40000])
    expect(h.fetched).toEqual([])
    expect(h.swaps).toEqual([])
  })

  it('does not report a swap failure that happened after stop()', async () => {
    const h = harness('medium')
    h.setStats(stats(15))
    await ticks(h, FIRST_SWAP)
    h.c.stop()
    await h.settleErr()
    expect(h.c.currentModel).toBe('medium')
    expect(h.errors).toEqual([])
  })

  it('resets the overshoot/headroom windows after a successful swap', async () => {
    // Overloaded FPS *and* comfortable modelMs: both windows accumulate, so a
    // downgrade that didn't reset headroom would immediately flip back up.
    const h = harness('large')
    h.setStats(stats(15, 1))
    await ticks(h, FIRST_SWAP)                  // both windows armed at +10 s
    await h.settleOk()
    expect(h.c.currentModel).toBe('medium')
    expect(h.swaps.map(s => s.model)).toEqual(['medium'])

    // Cooldown ends at +26 s. Without the reset, the headroom window opening
    // at +10 s would cross its 15 s threshold there and upgrade straight back
    // to large. With the reset it must not.
    await ticks(h, [26000, 30000])
    expect(h.fetched).toEqual(['medium'])
    expect(h.swaps.map(s => s.model)).toEqual(['medium'])

    // And the downgrade counter also restarted: a fresh 5 s overshoot from
    // +26 s is needed (a stale one would have fired at +26 s already).
    await ticks(h, [32000])
    expect(h.fetched).toEqual(['medium', 'small'])
  })

  it('still refuses to upgrade into xl and never upgrades on WebGL', async () => {
    const poll = Array.from({ length: 20 }, (_, i) => 10000 + i * 2000)   // +10 s … +48 s

    // large → xl is the only upgrade into xl; must not happen.
    const gpu = harness('large', { getInputFps: () => 30 })
    gpu.autoFetch()
    gpu.setStats(stats(30, 0.5))
    await ticks(gpu, poll)
    expect(gpu.fetched).toEqual([])

    const gl = harness('small', { backendKind: 'webgl' })
    gl.autoFetch()
    gl.setStats(stats(30, 0.5))
    await ticks(gl, poll)
    expect(gl.fetched).toEqual([])
  })
})

describe('InputRateMeter on a 15 fps synthetic source', () => {
  let stop: (() => void)[] = []
  afterEach(() => { stop.forEach(f => f()); stop = [] })

  it('measures ~15 fps from rVFC presented frames', async () => {
    const cam = syntheticCamera(15)
    const input = setupPostMessageInput(cam.stream)
    stop.push(cam.stop, input.cleanup)
    const meter = new InputRateMeter(() => cam.track, () => input.framesIn)
    for (let i = 0; i < 6; i++) { meter.sample(); await sleep(400) }
    meter.sample()
    const fps = meter.fps()!
    expect(fps).toBeGreaterThan(11)
    expect(fps).toBeLessThan(19)
  })

  it('falls back to the track settings frame rate when it cannot count', () => {
    const cam = syntheticCamera(15)
    stop.push(cam.stop)
    const meter = new InputRateMeter(() => cam.track, () => undefined)
    meter.sample()
    expect(meter.fps()).toBe(15)
  })
})
