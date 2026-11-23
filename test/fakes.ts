/**
 * Offline test doubles for the Web Audio / Web Worker environment.
 *
 * No real audio device or Worker thread is involved: a fake AudioWorkletNode
 * base class, a controllable clock (setInterval/clearInterval), and an in-process
 * Worker pair route messages through the real OutputStreamNode, the three real
 * BufferWriteStrategy implementations and the real BufferFillWorker code.
 */

export type IntervalCallback = () => void

/**
 * Process-wide id source so timer handles never collide across FakeClock
 * instances: the global clearInterval must not cancel another clock's timer.
 */
let nextTimerId: number = 1

/**
 * Deterministic, manually driven clock shared by every setInterval call in a test.
 * Timers never fire on their own; tests call tick() to advance the clock.
 */
export class FakeClock {
  private readonly _timers: Map<number, { callback: IntervalCallback, interval: number }> = new Map()
  private _now: number = 0

  public setInterval(callback: IntervalCallback, interval: number): number {
    const id = nextTimerId++
    this._timers.set(id, { callback, interval })
    return id
  }

  public clearInterval(id: number): void {
    this._timers.delete(id)
  }

  /** Fires every live timer once (matching one interval tick). */
  public tick(): void {
    this._now++
    // Snapshot: callbacks created/cleared during this tick do not perturb the set.
    for (const entry of [...this._timers.values()]) {
      entry.callback()
    }
  }

  public get activeTimerCount(): number {
    return this._timers.size
  }

  public get now(): number {
    return this._now
  }
}

let activeClock: FakeClock | null = null

/**
 * Installs the global timer/window/self shims required by the library sources.
 * Must be called once before importing library modules.
 */
export function installGlobals(clock: FakeClock): void {
  activeClock = clock
  const globals = globalThis as Record<string, unknown>
  globals.window = {
    setInterval: (cb: IntervalCallback, ms: number) => clock.setInterval(cb, ms),
    clearInterval: (id: number) => clock.clearInterval(id),
  }
  globals.setInterval = (cb: IntervalCallback, ms: number) => clock.setInterval(cb, ms)
  globals.clearInterval = (id: number) => clock.clearInterval(id)
}

export function getActiveClock(): FakeClock {
  if (!activeClock) {
    throw new Error('installGlobals() must be called first')
  }
  return activeClock
}

type AnyMessage = Record<string, unknown>

type WorkerMessageHandler = ((ev: MessageEvent) => void) | null

/**
 * Minimal EventTarget subset used by the fake Worker, message port and
 * AudioWorkletNode base. Supports onmessage/onmessage-style handlers, named
 * listeners and dispatchEvent, including the custom StopEvent the node emits.
 */
class FakeEventTarget {
  private _onmessage: WorkerMessageHandler = null
  private readonly _listeners: Map<string, Set<(ev: Event) => void>> = new Map()

  public get onmessage(): WorkerMessageHandler {
    return this._onmessage
  }

  public set onmessage(handler: WorkerMessageHandler) {
    this._onmessage = handler
  }

  public addEventListener(type: string, listener: (ev: Event) => void): void {
    let set = this._listeners.get(type)
    if (!set) {
      set = new Set()
      this._listeners.set(type, set)
    }
    set.add(listener)
  }

  public removeEventListener(type: string, listener: (ev: Event) => void): void {
    this._listeners.get(type)?.delete(listener)
  }

  public dispatchEvent(event: Event): boolean {
    const type = event.type
    if (type === 'message' && this._onmessage) {
      this._onmessage(event as MessageEvent)
    }
    for (const listener of [...(this._listeners.get(type) ?? [])]) {
      listener(event)
    }
    return true
  }

  public dispatch(message: AnyMessage): void {
    this.dispatchEvent(new MessageEvent('message', { data: message }))
  }
}

/**
 * Fake MessagePort standing in for the AudioWorkletNode.port pair.
 * `posted` records every message the node sends to the (fake) processor.
 */
export class FakeMessagePort extends FakeEventTarget {
  public readonly posted: AnyMessage[] = []
  private _closed: boolean = false

  public postMessage(message: AnyMessage): void {
    if (this._closed) {
      throw new Error('Cannot postMessage on a closed port.')
    }
    this.posted.push(message)
  }

  /** Simulates the processor sending a message back to the node. */
  public emitFromProcessor(message: AnyMessage): void {
    if (this._closed) {
      throw new Error('Cannot emit on a closed port.')
    }
    this.dispatch(message)
  }

  public close(): void {
    this._closed = true
    this.onmessage = null
  }

  public get closed(): boolean {
    return this._closed
  }
}

/**
 * Base class standing in for AudioWorkletNode. The real OutputStreamNode extends
 * AudioWorkletNode (an EventTarget); this mirrors the surface the node uses.
 */
export class FakeAudioWorkletNode extends FakeEventTarget {
  public readonly port: FakeMessagePort
  public numberOfOutputs: number = 0
  private _disconnected: boolean = false

  public constructor() {
    super()
    this.port = new FakeMessagePort()
  }

  public connect(): void {
    this.numberOfOutputs = 1
  }

  public disconnect(): void {
    this._disconnected = true
    this.numberOfOutputs = 0
  }

  public get disconnected(): boolean {
    return this._disconnected
  }
}

/**
 * Installs the AudioWorkletNode global so `extends AudioWorkletNode` resolves
 * against the fake base class.
 */
export function installAudioWorkletNode(): void {
  (globalThis as Record<string, unknown>).AudioWorkletNode = FakeAudioWorkletNode
}

/**
 * Minimal AudioContext double (only sampleRate is read by the library in tests).
 */
export class FakeAudioContext {
  public constructor(public readonly sampleRate: number = 48000) {}
}

/**
 * One side of an in-process Worker pair. The "worker" side runs the real
 * BufferFillWorker message handling against the same fake clock; the "host" side
 * is the object handed to WorkerBufferWriteStrategy (it implements the Worker
 * surface the strategy uses).
 */
class FakeWorkerEndpoint extends FakeEventTarget {
  public postMessageCalls: number = 0
  public terminated: boolean = false
  private _peer: FakeWorkerEndpoint | null = null

  public setPeer(peer: FakeWorkerEndpoint): void {
    this._peer = peer
  }

  public postMessage(message: AnyMessage): void {
    this.postMessageCalls++
    const peer = this._peer
    if (!peer) {
      throw new Error('Worker endpoints are not connected.')
    }
    if (peer.terminated) {
      // A real browser silently drops messages posted to a terminated worker.
      return
    }
    // Deliver as a separate task, mirroring asynchronous Worker messaging.
    queueMicrotask(() => {
      if (peer.terminated) {
        return
      }
      try {
        peer.dispatch(message)
      }
      catch (error) {
        // A handler error inside the worker must not tear down the host test run.
        console.log('worker message handler error:', error instanceof Error ? error.message : error)
      }
    })
  }

  public terminate(): void {
    this.terminated = true
    this.onmessage = null
  }
}

/**
 * Worker-global endpoint. In addition to the messaging surface it exposes the
 * `self.setInterval`/`clearInterval`/`postMessage` globals that the real
 * BufferFillWorker code calls inside a Web Worker, all routed onto the shared
 * fake clock and the connected host endpoint.
 */
class FakeWorkerGlobalEndpoint extends FakeWorkerEndpoint {
  public constructor(private readonly _clock: FakeClock) {
    super()
  }

  public setInterval(callback: IntervalCallback, interval: number): number {
    return this._clock.setInterval(callback, interval)
  }

  public clearInterval(id: number): void {
    this._clock.clearInterval(id)
  }

  public postMessage(message: AnyMessage): void {
    // Worker -> host message, same delivery path as the endpoint pair.
    super.postMessage(message)
  }
}

export interface FakeWorkerPair {
  /** Object satisfying the Worker interface, passed as workerConstructor(). */
  hostWorker: FakeWorkerEndpoint
  /** Endpoint representing the worker global scope side. */
  workerGlobal: FakeWorkerGlobalEndpoint
}

/**
 * Creates a connected in-process worker pair and publishes the worker-global
 * endpoint as `self`, so the real BufferFillWorker (which talks to `self`)
 * runs its message/timer code path inside the test process.
 */
export function createWorkerPair(): FakeWorkerPair {
  const hostWorker = new FakeWorkerEndpoint()
  const workerGlobal = new FakeWorkerGlobalEndpoint(getActiveClock())
  hostWorker.setPeer(workerGlobal)
  workerGlobal.setPeer(hostWorker)
  ;(globalThis as Record<string, unknown>).self = workerGlobal
  return { hostWorker, workerGlobal }
}

/**
 * Constructor function matching `new () => Worker` used by
 * WorkerBufferWriteStrategy; every instantiation returns the same host endpoint
 * of the given pair (the strategy only ever constructs one worker).
 */
export function workerConstructorOf(pair: FakeWorkerPair): new () => Worker {
  return class {
    public constructor() {
      return pair.hostWorker as unknown as Worker
    }
  } as unknown as new () => Worker
}
