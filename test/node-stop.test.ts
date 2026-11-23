/**
 * OutputStreamNode stop-chain semantics with the manual write strategy.
 *
 * Covers: normal stop, repeated stop while stopping (same completion signal),
 * stop after stopped, stop in ready state, start-once semantics.
 */
import { StopEvent } from '../src/events'
import {
  assert,
  assertSamePromise,
  connectNode,
  createManualNode,
  fakePort,
  flushMicrotasks,
  isDisconnected,
  processorAcksStop,
  setupHarness,
} from './helpers'
import type { OutputStreamNode } from '../src/output-stream-node'

function connectAndStart(node: OutputStreamNode): void {
  connectNode(node)
  assert(node.start(), 'start() on a ready connected node must succeed')
  assert(node.isStart, 'node must report isStart after start()')
}

export async function testManualNormalStop(): Promise<void> {
  setupHarness()
  const node = await createManualNode()
  connectAndStart(node)

  const stopPromise = node.stop()
  const port = fakePort(node)
  assert(port.posted.length === 1, 'exactly one stop message must be posted to the processor')
  assert(port.posted[0].type === 'stop', 'posted message must be a stop message')

  let resolved = false
  void stopPromise.then(() => {
    resolved = true
  })
  await flushMicrotasks()
  assert(!resolved, 'stop promise must stay pending until the processor acknowledges stop')

  processorAcksStop(node)
  await flushMicrotasks()
  assert(resolved, 'stop promise must resolve once the processor acknowledges stop')
  assert(port.closed, 'port must be closed after stop completes')
  assert(isDisconnected(node), 'node must be disconnected after stop completes')
}

export async function testRepeatedStopWhileStoppingSharesPromise(): Promise<void> {
  setupHarness()
  const node = await createManualNode()
  connectAndStart(node)

  const first = node.stop(BigInt(100))
  const second = node.stop(BigInt(200))
  const third = node.stop()
  assertSamePromise(first, second, 'second stop() while stopping must return the same promise')
  assertSamePromise(first, third, 'third stop() while stopping must return the same promise')
  assert(fakePort(node).posted.length === 1, 'only the first stop() may post a processor message')

  let resolvedCount = 0
  for (const p of [first, second, third]) {
    void p.then(() => resolvedCount++)
  }
  processorAcksStop(node)
  await flushMicrotasks()
  assert(resolvedCount === 3, 'every shared stop promise must settle when teardown completes')
}

export async function testStopAfterStoppedReturnsSettledSignal(): Promise<void> {
  setupHarness()
  const node = await createManualNode()
  connectAndStart(node)

  const first = node.stop()
  processorAcksStop(node)
  await first
  const second = node.stop()
  assertSamePromise(first, second, 'stop() after stopped must return the same settled promise')
  await flushMicrotasks()
  assert(fakePort(node).closed, 'port stays closed')
  assert(isDisconnected(node), 'node stays disconnected')
}

export async function testReadyStopGoesDirectlyToStopped(): Promise<void> {
  setupHarness()
  const node = await createManualNode()

  let stopEventSeen = false
  node.addEventListener(StopEvent.type, () => {
    stopEventSeen = true
  })

  const stopPromise = node.stop()
  await flushMicrotasks()
  const port = fakePort(node)
  assert(port.closed, 'ready-state stop must close the port without a processor handshake')
  assert(isDisconnected(node), 'ready-state stop must disconnect the node')
  assert(port.posted.length === 0, 'no processor stop message is sent when playback never started')
  assert(!stopEventSeen, 'no StopEvent is dispatched for a ready-state stop')

  const again = node.stop()
  assertSamePromise(stopPromise, again, 'repeated ready-state stops share the completion signal')
}

export async function testStartCanOnlySucceedOnce(): Promise<void> {
  setupHarness()
  const node = await createManualNode()
  connectNode(node)
  assert(node.start(), 'first start() succeeds')
  assert(!node.start(), 'second start() while started must return false, not throw')

  node.stop()
  processorAcksStop(node)
  let threw = false
  try {
    node.start()
  }
  catch {
    threw = true
  }
  assert(threw, 'start() after stop must throw')
}

export async function testStartWhileStoppingThrows(): Promise<void> {
  setupHarness()
  const node = await createManualNode()
  connectAndStart(node)
  node.stop()
  let threw = false
  try {
    node.start()
  }
  catch {
    threw = true
  }
  assert(threw, 'start() while stopping must throw')
  processorAcksStop(node)
}

export async function testStopEventDispatchedOnce(): Promise<void> {
  setupHarness()
  const node = await createManualNode()
  connectAndStart(node)
  let eventCount = 0
  node.addEventListener(StopEvent.type, () => {
    eventCount++
  })
  node.stop()
  node.stop()
  processorAcksStop(node)
  await flushMicrotasks()
  assert(eventCount === 1, 'a single StopEvent must be dispatched despite duplicate stop() calls')
}
