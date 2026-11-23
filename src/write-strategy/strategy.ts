import type { OutputStreamNode } from '../output-stream-node'

/**
 * BufferWriteStrategy interface
 * Defines the methods for buffer writing strategies.
 */
export interface BufferWriteStrategy {
  /**
   * Initializes the strategy.
   * @param node - The OutputStreamNode instance.
   * @returns A promise that resolves to true when initialization is complete.
   */
  onInit(node: OutputStreamNode): Promise<boolean>

  /**
   * Starts the strategy.
   * @param node - The OutputStreamNode instance.
   * @returns A boolean indicating whether the strategy started successfully.
   */
  onStart(node: OutputStreamNode): boolean

  /**
   * Notifies the strategy that the node has entered the 'stopping' state.
   *
   * Called at most once, when a user- or strategy-triggered stop() begins the
   * started -> stopping transition. Strategies that own recurring work (timers,
   * workers) must release it here so no filler can run after stop has been
   * requested, even before the processor acknowledges the stop.
   */
  onStopping(): void

  /**
   * Stops the strategy.
   */
  onStopped(): void
}
