import type { Ref } from 'vue'
import type { PlayerEngineOptions } from './playerEngine'
import { onMounted, onUnmounted } from 'vue'
import { createPlayerEngine } from './playerEngine'

export type { PlayerControls } from './playerEngine'

export function usePlayer(
  videoRef: Ref<HTMLVideoElement | null>,
  options: PlayerEngineOptions = {},
) {
  const engine = createPlayerEngine(videoRef, options)

  onMounted(() => {
    engine.attach()
  })

  onUnmounted(() => {
    engine.detach()
  })

  return { state: engine.state, controls: engine.controls, loadSource: engine.loadSource }
}
