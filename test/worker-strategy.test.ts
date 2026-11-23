/**
 * WorkerBufferWriteStrategy / BufferFillWorker stop-chain tests.
 *
 * A real BufferFillWorker runs in-process against a fake worker global (`self`)
 * and the shared fake clock, so the worker 'init'/'start'/'stop' message handling
 * and the worker-side interval timer are exercised for real.
 *
 * Covers: user-first stop (worker terminated, timer released), worker-first stop
 * (filler exhaustion reports stop and the user call joins the same chain),
 * duplicate worker stop messages, and repeated user stops.
 */
import {
  assert,
  assertSamePromise,
  connectNode,
  createWorkerDrivenNode,
  EndlessFiller,
  fakePort,
  flushMicrotasks,
  getActiveClock,
  processorAcksStop,
  setupHarness,
} from './helpers'
import type { FrameBufferFiller } from '../src/frame-buffer-filler'
import type { FrameBufferWriter } from '@ain1084/audio-frame-buffer'
import type { OutputStreamNode } from '../src/output-stream-node'

/** Filler generator used on the worker side; the class itself is instantiated there. */
class EndlessFillerGenerator extends EndlessFiller {
  public constructor() {
    super()
  }
}

/**
 * Filler whose first N fills succeed and every later fill reports end-of-data.
 * One instance is constructed inside the worker by BufferFillWorker.
 */
class ExhaustingFiller implements FrameBufferFiller {
  public static fillsBeforeExhaustion: number = 2
  public fillCallCount: number = 0
  public fill(writer: FrameBufferWriter): boolean {
    writer.write(segment => segment.frameCount)
    this.fillCallCount++
    return this.fillCallCount <= ExhaustingFiller.fillsBeforeExhaustion
  }
}

function startWorkerNode(node: OutputStreamNode): void {
  connectNode(node)
  assert(node.start(), 'worker node start must succeed')
}

export async function testWorkerUserFirstStopTerminatesWorker(): Promise<void> {
  const { clock } = setupHarness()
  const { node, pair } = await createWorkerDrivenNode(EndlessFillerGenerator)
  startWorkerNode(node)
  await flushMicrotasks()
  assert(clock.activeTimerCount === 1, 'worker-side fill interval must be running after start')

  const stopPromise = node.stop()
  await flushMicrotasks()
  assert(pair.hostWorker.terminated, 'user stop must terminate the worker')
  assert(clock.activeTimerCount === 0, 'worker-side interval must be cleared on stop')

  // Even if the clock were advanced, a terminated worker cannot fill anymore.
  clock.tick()
  clock.tick()
  assert(fakePort(node).posted.length === 1, 'exactly one processor stop message from the user stop')

  const second = node.stop()
  assertSamePromise(stopPromise, second, 'duplicate user stop joins the same completion signal')
  assert(pair.hostWorker.terminated, 'worker is not terminated twice (no error on repeat stop)')

  processorAcksStop(node)
  await stopPromise
}

export async function testWorkerFirstStopThenUserStop(): Promise<void> {
  setupHarness()
  const clock = getActiveClock()
  const { node, pair } = await createWorkerDrivenNode(ExhaustingFiller)
  startWorkerNode(node)
  await flushMicrotasks()

  // Drive the worker-side interval until the filler reports exhaustion.
  clock.tick()
  clock.tick()
  await flushMicrotasks()

  // The worker posted a 'stop' message; the strategy translated it into a node
  // stop, so the node must already be stopping and the worker released.
  const port = fakePort(node)
  assert(port.posted.length === 1, 'worker-reported stop must trigger exactly one processor stop')
  assert(port.posted[0].type === 'stop')
  assert(pair.hostWorker.terminated, 'node teardown must terminate the worker even when the worker stops first')
  assert(clock.activeTimerCount === 0, 'no worker timer may survive a worker-first stop')

  // User stop arrives while the processor has not acknowledged yet: it must join
  // the in-flight chain instead of starting a second teardown.
  const firstSignal = node.stop()
  const secondSignal = node.stop()
  assertSamePromise(firstSignal, secondSignal, 'user stop after worker stop shares the pending signal')
  assert(port.posted.length === 1, 'user stop must not post a second processor message')

  processorAcksStop(node)
  await Promise.all([firstSignal, secondSignal])
  assert(port.closed)
}

export async function testWorkerStopMessageAfterTerminationIgnored(): Promise<void> {
  setupHarness()
  const { node, pair } = await createWorkerDrivenNode(EndlessFillerGenerator)
  startWorkerNode(node)
  await flushMicrotasks()

  const stopPromise = node.stop()
  await flushMicrotasks()
  assert(pair.hostWorker.terminated)

  // Simulate a stray late worker-to-host message arriving after teardown (e.g.
  // an in-flight 'stop' delivered by the event loop). The host handler has been
  // detached, so it must not re-enter the node stop chain.
  const messagesBefore = fakePort(node).posted.length
  pair.hostWorker.dispatch({ type: 'stop', stopFrames: BigInt(123) })
  await flushMicrotasks()
  assert(fakePort(node).posted.length === messagesBefore, 'a late worker message must not trigger another stop')
  processorAcksStop(node)
  await stopPromise
  await flushMicrotasks()
}

export async function testWorkerRepeatedStopDoesNotDoubleTeardown(): Promise<void> {
  setupHarness()
  const { node, pair } = await createWorkerDrivenNode(EndlessFillerGenerator)
  startWorkerNode(node)
  await flushMicrotasks()

  const p1 = node.stop()
  const p2 = node.stop()
  const p3 = node.stop()
  assertSamePromise(p1, p2, 'all concurrent stop calls share one promise (1/2)')
  assertSamePromise(p2, p3, 'all concurrent stop calls share one promise (2/3)')
  await flushMicrotasks()
  assert(pair.hostWorker.terminated)
  processorAcksStop(node)
  await Promise.all([p1, p2, p3])
}

export async function testWorkerStopMessageBeforeStartIsSafe(): Promise<void> {
  setupHarness()
  const { node, pair } = await createWorkerDrivenNode(EndlessFillerGenerator)
  await flushMicrotasks()
  // A main-thread 'stop' posted while the worker never received 'start' must not
  // throw on the worker side (null-context stop is a no-op).
  pair.workerGlobal.dispatch({ type: 'stop' })
  await flushMicrotasks()
  assert(!pair.hostWorker.terminated, 'a worker-side stop alone does not terminate anything')
  await node.stop()
  assert(fakePort(node).closed, 'node without start stops via the ready-state path')
}

export async function testWorkerInitStartStopMessagePath(): Promise<void> {
  setupHarness()
  const clock = getActiveClock()
  const { node, pair } = await createWorkerDrivenNode(EndlessFillerGenerator)
  // init-done has already resolved node creation; verify the worker retained it.
  assert(pair.hostWorker.postMessageCalls >= 1, 'init message was posted to the worker')
  startWorkerNode(node)
  await flushMicrotasks()
  const startMessages = pair.hostWorker.postMessageCalls
  assert(startMessages >= 2, 'start message was posted to the worker')
  assert(clock.activeTimerCount === 1, 'worker interval started')

  const stopPromise = node.stop()
  // The host posts an explicit 'stop' to the worker before terminating it.
  await flushMicrotasks()
  const afterStopMessages = pair.hostWorker.postMessageCalls
  assert(afterStopMessages > startMessages, 'a stop message is posted before worker termination')
  assert(clock.activeTimerCount === 0, 'worker stop message clears the interval timer')
  assert(pair.hostWorker.terminated, 'the worker is terminated on stop')
  processorAcksStop(node)
  await stopPromise
  await flushMicrotasks()
}
