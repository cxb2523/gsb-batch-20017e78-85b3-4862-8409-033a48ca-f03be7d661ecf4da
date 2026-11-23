/**
 * Shared helpers for the offline stop-chain tests.
 */
import {
  FakeAudioContext,
  FakeClock,
  FakeMessagePort,
  FakeWorkerPair,
  createWorkerPair,
  installAudioWorkletNode,
  installGlobals,
  workerConstructorOf,
} from './fakes'
import { createFillerFrameBufferContext, type FillerFrameBufferContext } from '../src/filler-frame-buffer-context'
import { createFrameBufferContext, type FrameBufferContext } from '@ain1084/audio-frame-buffer'
import type { FrameBufferFiller } from '../src/frame-buffer-filler'
import type { FrameBufferWriter } from '@ain1084/audio-frame-buffer'
import { ManualBufferWriteStrategy } from '../src/write-strategy/manual-strategy'
import { TimedBufferWriteStrategy } from '../src/write-strategy/timed-strategy'
import { WorkerBufferWriteStrategy } from '../src/write-strategy/worker-strategy'
import { OutputStreamNode } from '../src/output-stream-node'
import { BufferFillWorker } from '../src/write-strategy/worker/worker'

export { OutputStreamNode }
export { getActiveClock } from './fakes'

/**
 * Test view of an OutputStreamNode backed by the fake AudioWorkletNode base:
 * exposes the fake port/disconnect bookkeeping the assertions need, plus no-arg
 * connect/stop wrappers (the DOM lib types require arguments on the real APIs).
 */
export type TestNode = OutputStreamNode & {
  port: FakeMessagePort
  readonly disconnected: boolean
  connect(): void
  stop(): Promise<void>
}

function asTestNode(node: OutputStreamNode): TestNode {
  return node as unknown as TestNode
}

export function fakePort(node: OutputStreamNode): FakeMessagePort {
  return asTestNode(node).port
}

export function isDisconnected(node: OutputStreamNode): boolean {
  return asTestNode(node).disconnected
}

export function connectNode(node: OutputStreamNode): void {
  asTestNode(node).connect()
}

/**
 * Filler whose `fill` result is scripted per call. Every invocation is counted so
 * tests can assert that filling stops once the stop chain has run.
 *
 * Results are consumed in order. Once a `false` is encountered the filler stays
 * exhausted for every later call. After a script ending in `true` is consumed,
 * further calls keep returning `true` (an open-ended stream).
 */
export class ScriptedFiller implements FrameBufferFiller {
  public fillCallCount: number = 0
  private _exhausted: boolean = false
  public constructor(private readonly _results: boolean[]) {}

  public fill(writer: FrameBufferWriter): boolean {
    this.fillCallCount++
    writer.write(segment => segment.frameCount)
    if (this._exhausted) {
      return false
    }
    const index = this.fillCallCount - 1
    if (index >= this._results.length) {
      // Script fully consumed without a false: the stream continues.
      return true
    }
    const result = this._results[index]
    if (!result) {
      this._exhausted = true
    }
    return result
  }
}

/** Filler that always reports more data available. */
export class EndlessFiller implements FrameBufferFiller {
  public fillCallCount: number = 0
  public fill(writer: FrameBufferWriter): boolean {
    this.fillCallCount++
    writer.write(segment => segment.frameCount)
    return true
  }
}

/** Filler that throws on every call. */
export class ThrowingFiller implements FrameBufferFiller {
  public fillCallCount: number = 0
  public fill(): boolean {
    this.fillCallCount++
    throw new Error('filler failure')
  }
}

export interface TestHarness {
  clock: FakeClock
  audioContext: FakeAudioContext
}

/**
 * Sets up a fresh fake environment. Importing library modules after this call
 * makes their `window`/`self`/`AudioWorkletNode` references resolve to the fakes.
 */
export function setupHarness(): TestHarness {
  const clock = new FakeClock()
  installGlobals(clock)
  installAudioWorkletNode()
  return { clock, audioContext: new FakeAudioContext(48000) }
}

export function createManualContext(frameCount: number = 1024, channelCount: number = 2): FrameBufferContext {
  return createFrameBufferContext({ frameCount, channelCount })
}

export function createFillerContext(channelCount: number = 2, fillInterval: number = 10): FillerFrameBufferContext {
  return createFillerFrameBufferContext({ channelCount, sampleRate: 48000, fillInterval })
}

export async function createManualNode(): Promise<OutputStreamNode> {
  const context = createManualContext()
  const strategy = new ManualBufferWriteStrategy(context)
  return OutputStreamNode.create(
    new FakeAudioContext(48000) as unknown as BaseAudioContext,
    context,
    strategy,
  )
}

export async function createTimedNode(filler: FrameBufferFiller): Promise<OutputStreamNode> {
  const context = createFillerContext()
  const strategy = new TimedBufferWriteStrategy(context, filler)
  return OutputStreamNode.create(
    new FakeAudioContext(48000) as unknown as BaseAudioContext,
    context,
    strategy,
  )
}

/**
 * Creates an OutputStreamNode driven by the worker strategy, plus the in-process
 * worker pair and the real BufferFillWorker instance bound to the worker side.
 *
 * The worker-side handler is constructed first (mirroring a real Worker whose
 * module evaluates before any host message arrives), so its 'init' reply can
 * resolve node creation.
 */
export async function createWorkerDrivenNode(
  fillerGenerator: new () => FrameBufferFiller,
): Promise<{ node: OutputStreamNode, pair: FakeWorkerPair, worker: BufferFillWorker<unknown> }> {
  const pair = createWorkerPair()
  // Construct the real worker-side handler against the fake worker global (`self`)
  // before the host posts 'init', exactly like a real worker lifecycle.
  const worker = new BufferFillWorker<unknown>(fillerGenerator)
  const context = createFillerContext()
  const strategy = new WorkerBufferWriteStrategy<unknown>(context, workerConstructorOf(pair), {})
  const node = await OutputStreamNode.create(
    new FakeAudioContext(48000) as unknown as BaseAudioContext,
    context,
    strategy,
  )
  await flushMicrotasks()
  return { node, pair, worker }
}

/**
 * Simulates the processor acknowledging the node's stop message. The real node
 * resolves its stop promise only when this message arrives.
 */
export function processorAcksStop(node: OutputStreamNode, totalProcessedFrames: bigint = BigInt(0)): void {
  fakePort(node).emitFromProcessor({ type: 'stop', totalProcessedFrames })
}

export function flushMicrotasks(): Promise<void> {
  // Two rounds suffice for the queueMicrotask message hops used by the fakes.
  return new Promise(resolve => queueMicrotask(() => queueMicrotask(() => resolve())))
}

export function assert(condition: boolean, message: string = 'assertion failed'): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`)
  }
}

export function assertSamePromise(p1: Promise<void>, p2: Promise<void>, message: string): void {
  assert(Object.is(p1, p2), message)
}
