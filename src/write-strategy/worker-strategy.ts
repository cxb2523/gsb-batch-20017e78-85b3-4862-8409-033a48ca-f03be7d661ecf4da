import type { BufferWriteStrategy } from './strategy'
import type { FillerFrameBufferContext } from '../filler-frame-buffer-context'
import type { MessageToStrategy, MessageToWorker } from './worker/message'
import type { OutputStreamNode } from '../output-stream-node'

/**
 * Parameters for creating a PlayContext.
 * @property node - The OutputStreamNode instance.
 * @property context - The FillerFrameBufferContext instance.
 * @property workerConstructor - The constructor for the Worker.
 * @property fillerParam - The parameters for the FrameBufferFiller.
 */
type PlayerContextParams<FillerParams> = Readonly<{
  node: OutputStreamNode
  context: FillerFrameBufferContext
  workerConstructor: new () => Worker
  fillerParam: FillerParams
}>

/**
 * PlayContext class
 * Manages the buffer filling process within a web worker.
 */
class Context<FillerParams> {
  private readonly _node: OutputStreamNode
  private readonly _bufferContext: FillerFrameBufferContext
  private readonly _fillerParam: FillerParams
  private readonly _worker: Worker
  private _stopped = false

  /**
   * Creates an instance of PlayContext.
   * @param params - The parameters for the PlayContext.
   */
  private constructor(params: PlayerContextParams<FillerParams>) {
    this._node = params.node
    this._bufferContext = params.context
    this._worker = new params.workerConstructor()
    this._fillerParam = params.fillerParam
    this._worker.onmessage = this.handleWorkerMessage.bind(this)
  }

  /**
   * Creates and initializes an instance of PlayContext.
   * @param params - The parameters for the PlayContext.
   * @returns A promise that resolves to an instance of PlayContext.
   */
  public static async create<FillerParams>(params: PlayerContextParams<FillerParams>) {
    const instance = new Context(params)
    await instance.init()
    return instance
  }

  /**
   * Handles messages from the worker.
   *
   * A worker-reported 'stop' and a user-triggered node.stop() can race. Both end
   * up calling OutputStreamNode.stop(), whose state machine makes the transition
   * idempotent; once this context has been torn down the worker is already
   * terminated, so late messages are ignored here as well.
   * @param ev - The message event from the worker.
   */
  private handleWorkerMessage(ev: MessageEvent<MessageToStrategy>): void {
    if (this._stopped) {
      return
    }
    if (ev.data.type === 'stop') {
      this._node.stop(ev.data.stopFrames)
    }
  }

  /**
   * Initializes the PlayContext by sending the 'init' message to the worker.
   * @returns A promise that resolves when initialization is complete.
   */
  private init() {
    return new Promise<void>((resolve) => {
      const message: MessageToWorker<FillerParams> = {
        type: 'init',
        config: this._bufferContext,
        fillerParams: this._fillerParam,
      }
      this._worker.postMessage(message)
      const listener = (ev: MessageEvent<MessageToStrategy>) => {
        if (ev.data.type === 'init-done') {
          this._worker.removeEventListener('message', listener)
          resolve()
        }
      }
      this._worker.addEventListener('message', listener)
    })
  }

  /**
   * Starts the buffer filling process by sending the 'start' message to the worker.
   */
  public start() {
    const message: MessageToWorker<FillerParams> = {
      type: 'start',
    }
    this._worker.postMessage(message)
  }

  /**
   * Stops the worker: asks it to clear its fill interval, detaches message
   * handling and terminates it.
   *
   * Idempotent so that a worker-reported stop racing with a user stop cannot
   * terminate (or post to) an already released worker a second time.
   */
  public stopped() {
    if (this._stopped) {
      return
    }
    this._stopped = true
    // Ask the worker side to clear its interval timer before the worker is
    // terminated, exercising the BufferFillWorker 'stop' message path and
    // guaranteeing no timer survives.
    const message: MessageToWorker<FillerParams> = { type: 'stop' }
    this._worker.onmessage = null
    this._worker.postMessage(message)
    this._worker.terminate()
  }
}

/**
 * WorkerBufferWriteStrategy class
 * Implements the BufferWriteStrategy interface using a web worker to manage buffer filling.
 */
export class WorkerBufferWriteStrategy<FillerParam> implements BufferWriteStrategy {
  private readonly _createPlayContext: (node: OutputStreamNode) => Promise<Context<FillerParam>>
  private _context: Context<FillerParam> | null = null

  /**
   * Creates an instance of WorkerBufferWriteStrategy.
   * @param bufferContext - The context for the filler frame buffer.
   * @param workerConstructor - The constructor for the Worker.
   * @param fillerParam - The parameters for the FrameBufferFiller.
   */
  constructor(bufferContext: FillerFrameBufferContext, workerConstructor: new () => Worker, fillerParam: FillerParam) {
    this._createPlayContext = (node: OutputStreamNode) => Context.create<FillerParam>({ node, context: bufferContext, workerConstructor, fillerParam })
  }

  /**
   * Initializes the strategy.
   * @param node - The OutputStreamNode instance.
   * @returns A promise that resolves to true when initialization is complete.
   */
  async onInit(node: OutputStreamNode): Promise<boolean> {
    this._context = await this._createPlayContext(node)
    return true
  }

  /**
   * Starts the strategy.
   * @param node - The OutputStreamNode instance.
   * @returns A boolean indicating whether the strategy started successfully.
   */
  onStart(/* node: OutputStreamNode */): boolean {
    if (!this._context) {
      throw new Error('Invalid state: context is null.')
    }
    this._context.start()
    return true
  }

  /**
   * Releases the worker as soon as the node begins stopping, so the worker is
   * terminated and its fill interval cleared while the processor stop is still
   * in flight. Idempotent: a worker-reported stop racing with a user stop runs
   * this release only once.
   */
  onStopping(): void {
    this._context?.stopped()
  }

  /**
   * Stops the strategy.
   * Idempotent: the worker (and its interval timer) is released only once,
   * even if the node stop chain were to invoke teardown more than once.
   */
  onStopped(): void {
    this._context?.stopped()
  }
}
