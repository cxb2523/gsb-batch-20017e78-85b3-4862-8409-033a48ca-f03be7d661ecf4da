/**
 * Bootstrap entry: installs the fake Web Audio / Worker globals before any
 * library module is evaluated (ESM static imports are hoisted, so the
 * AudioWorkletNode global must exist before OutputStreamNode is imported).
 */
import { FakeClock, installAudioWorkletNode, installGlobals } from './fakes'

installGlobals(new FakeClock())
installAudioWorkletNode()

await import('./run-tests')
