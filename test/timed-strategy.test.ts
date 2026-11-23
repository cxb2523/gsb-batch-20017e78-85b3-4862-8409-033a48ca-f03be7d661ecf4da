/**
 * TimedBufferWriteStrategy stop-chain tests.
 *
 * Covers: user stop clears the interval (no further filler callbacks), filler
 * exhaustion drives the node stop chain by itself, throwing filler tears down the
 * timer, repeated stop does not touch a stopped node, and start failure when the
 * initial fill reports end-of-data.
 */
import {
  assert,
  assertSamePromise,
  connectNode,
  createTimedNode,
  EndlessFiller,
  fakePort,
  flushMicrotasks,
  isDisconnected,
  processorAcksStop,
  ScriptedFiller,
  setupHarness,
} from './helpers'
import type { OutputStreamNode } from '../src/output-stream-node'

function startNode(node: OutputStreamNode): void {
  connectNode(node)
  assert(node.start(), 'timed node start must succeed')
}

export async function testTimedUserStopReleasesInterval(): Promise<void> {
  const { clock } = setupHarness()
  const filler = new EndlessFiller()
  const node = await createTimedNode(filler)
  startNode(node)
  assert(clock.activeTimerCount === 1, 'one fill interval must be active after start')

  clock.tick()
  const fillsBeforeStop = filler.fillCallCount
  assert(fillsBeforeStop >= 1, 'interval tick must invoke the filler while started')

  const stopPromise = node.stop()
  assert(clock.activeTimerCount === 0, 'stop must clear the fill interval')
  clock.tick()
  clock.tick()
  assert(filler.fillCallCount === fillsBeforeStop, 'filler must not be called again after stop')

  processorAcksStop(node)
  await stopPromise
  clock.tick()
  assert(filler.fillCallCount === fillsBeforeStop, 'no filler calls after the node has stopped')
}

export async function testTimedRepeatedStopSharesPromise(): Promise<void> {
  const { clock } = setupHarness()
  const node = await createTimedNode(new EndlessFiller())
  startNode(node)

  const first = node.stop()
  const second = node.stop()
  assertSamePromise(first, second, 'repeated stop on a timed node must share the completion promise')
  assert(clock.activeTimerCount === 0, 'interval cleared by the first stop')
  processorAcksStop(node)
  await Promise.all([first, second])
}

export async function testTimedFillerExhaustionStopsNode(): Promise<void> {
  const { clock } = setupHarness()
  // Constructor performs one initial fill (true), then the first tick exhausts.
  const filler = new ScriptedFiller([true, false])
  const node = await createTimedNode(filler)
  startNode(node)
  assert(clock.activeTimerCount === 1, 'interval active while data remains')

  clock.tick()
  assert(clock.activeTimerCount === 0, 'exhaustion must clear the interval before stopping')
  const port = fakePort(node)
  assert(port.posted.length === 1, 'exhaustion must post exactly one processor stop message')
  assert(port.posted[0].type === 'stop', 'exhaustion posts a stop message')

  // Late ticks must do nothing.
  clock.tick()
  clock.tick()
  assert(port.posted.length === 1, 'late timer ticks must not post further stop messages')

  processorAcksStop(node)
  await flushMicrotasks()
  assert(port.closed, 'node completes teardown after processor acknowledgement')
}

export async function testTimedUserStopBeatsPendingExhaustion(): Promise<void> {
  const { clock } = setupHarness()
  const filler = new EndlessFiller()
  const node = await createTimedNode(filler)
  startNode(node)

  // User stops first; even though the filler would keep returning true, the
  // cleared interval can no longer run, and no second stop is ever generated.
  const stopPromise = node.stop()
  assert(clock.activeTimerCount === 0)
  clock.tick()
  assert(fakePort(node).posted.length === 1, 'only the user stop posts a message')
  const second = node.stop()
  assertSamePromise(stopPromise, second, 'duplicate stop reuses the pending completion signal')
  processorAcksStop(node)
  await stopPromise
}

export async function testTimedThrowingFillerCleansUp(): Promise<void> {
  const { clock } = setupHarness()
  // Constructor's initial fill must succeed; the first timer tick then throws.
  const filler = new ScriptedFiller([true])
  const originalFill = filler.fill.bind(filler)
  let ticked = false
  filler.fill = (writer) => {
    if (!ticked) {
      ticked = true
      return originalFill(writer)
    }
    throw new Error('boom')
  }
  const node = await createTimedNode(filler)
  startNode(node)

  clock.tick()
  assert(clock.activeTimerCount === 0, 'a throwing filler must clear the interval')
  assert(fakePort(node).posted.length === 1, 'a throwing filler must trigger the node stop chain once')
  processorAcksStop(node)
  await flushMicrotasks()
  assert(fakePort(node).closed)
}

export async function testTimedInitialFillExhaustionFailsStart(): Promise<void> {
  setupHarness()
  const filler = new ScriptedFiller([false])
  const node = await createTimedNode(filler)
  connectNode(node)
  assert(!node.start(), 'start must fail when the initial fill reports end-of-data')
  // start() internally calls stop(totalWriteFrames); that path must still settle
  // cleanly and leave the node stopped.
  await flushMicrotasks()
  assert(fakePort(node).closed, 'failed start still completes node teardown')
  const again = node.stop()
  await flushMicrotasks()
  assert(fakePort(node).closed, 'stop on the already-stopped node is harmless')
  void again
}

export async function testTimedStopWithoutStart(): Promise<void> {
  setupHarness()
  const filler = new EndlessFiller()
  const node = await createTimedNode(filler)
  // Never started: no interval exists.
  await node.stop()
  assert(fakePort(node).closed, 'ready-state stop closes the port')
  assert(isDisconnected(node), 'ready-state stop disconnects the node')
}
