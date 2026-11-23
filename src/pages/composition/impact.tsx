import Page from '@/components/Page'
import { createImpactPlayback, shouldAcceptImpactTimeEdit } from '@/lib/impactTimeline'
import type { ImpactTimelineContext } from '@/lib/impactTimeline'
import { defaultImpactUniforms, impact } from '@/shaders'
import { defaultImpactVisualUniforms } from '@/shaders/impact'
import type { ImpactVisualUniforms } from '@/shaders/impact'
import { useFrame } from '@react-three/fiber'
import { button, folder, useControls } from 'leva'
import type { ButtonInput } from 'leva/dist/declarations/src/types'
import { useLayoutEffect, useMemo, useRef } from 'react'
import { Vector4 } from 'three'
import type { MeshBasicNodeMaterial } from 'three/webgpu'

type Preset = { name: string; visual: ImpactVisualUniforms; duration: number }

/**
 * Presets only carry the visuals they own plus a duration. Playback state (time,
 * seed, autoplay) is never baked into a preset: the timeline redraws it on every
 * switch, so a preset can't resurrect a stale playhead or seed.
 */
const impactPresets: Preset[] = [
  {
    name: 'Smash',
    duration: 0.5,
    visual: {
      ...defaultImpactVisualUniforms,
      circleColor: new Vector4(1, 0.1, 0, 1),
      vesicaColor: new Vector4(1, 0.6, 0, 1),
      vesicaCount: 6,
      circleSizeStart: 0,
      circleSizeEnd: 0.6,
      circleThickness: 0.13,
    },
  },
  {
    name: 'Void Blast',
    duration: 0.7,
    visual: {
      ...defaultImpactVisualUniforms,
      circleColor: new Vector4(0, 0, 0, 0.9),
      vesicaColor: new Vector4(0.1, 0, 1, 1),
      vesicaCount: 6,
      circleSizeStart: 1,
      circleSizeEnd: 0.2,
      circleThickness: 0.18,
    },
  },
  {
    name: 'Cherry Blossom',
    duration: 0.7,
    visual: {
      ...defaultImpactVisualUniforms,
      circleColor: new Vector4(1, 0.8, 1, 1),
      vesicaColor: new Vector4(1, 0.4, 1, 1),
      vesicaCount: 10,
      circleSizeStart: 0.2,
      circleSizeEnd: 0.6,
      circleThickness: 0.1,
    },
  },
  {
    name: 'Default',
    duration: defaultImpactUniforms.duration,
    visual: {
      ...defaultImpactVisualUniforms,
      circleColor: defaultImpactUniforms.circleColor.clone(),
      vesicaColor: defaultImpactUniforms.vesicaColor.clone(),
    },
  },
]

const defaultPreset = impactPresets[0]
const defaultUniforms = defaultPreset.visual
const defaultDuration = defaultPreset.duration

type LevaColor = { r: number; g: number; b: number; a: number }

/** Controls mirrored one-way from the page. Leva excludes transient inputs from its own setter type. */
type ImpactControlPatch = Partial<{
  circleColor: LevaColor
  vesicaColor: LevaColor
  circleSizeStart: number
  circleSizeEnd: number
  circleThickness: number
  vesicaCount: number
  time: number
  duration: number
  autoplay: boolean
}>

const toLevaColor = (color: Vector4): LevaColor => ({
  r: color.x * 255,
  g: color.y * 255,
  b: color.z * 255,
  a: color.w,
})

const fromLevaColor = (color: LevaColor) => new Vector4(color.r / 255, color.g / 255, color.b / 255, color.a)

const toLevaUniforms = (visual: ImpactVisualUniforms) => ({
  circleColor: toLevaColor(visual.circleColor),
  vesicaColor: toLevaColor(visual.vesicaColor),
  circleSizeStart: visual.circleSizeStart,
  circleSizeEnd: visual.circleSizeEnd,
  circleThickness: visual.circleThickness,
  vesicaCount: visual.vesicaCount,
})

const ImpactMaterial = () => {
  const materialRef = useRef<MeshBasicNodeMaterial>(null)

  // The shader starts with the timeline's own values, so the very first frame
  // already matches the preset shown in the controls.
  const { uniforms, nodes } = useMemo(
    () => impact({ time: 0, seed: defaultImpactUniforms.seed, duration: defaultDuration }),
    [],
  )
  const playback = useMemo(
    () => createImpactPlayback({ duration: defaultDuration, seed: defaultImpactUniforms.seed }),
    [],
  )

  /** The single write path from controls/presets into the shader's visual uniforms. */
  const applyVisualUniforms = useMemo(
    () => (visual: ImpactVisualUniforms) => {
      uniforms.circleColor.value.copy(visual.circleColor)
      uniforms.vesicaColor.value.copy(visual.vesicaColor)
      uniforms.circleSizeStart.value = visual.circleSizeStart
      uniforms.circleSizeEnd.value = visual.circleSizeEnd
      uniforms.circleThickness.value = visual.circleThickness
      uniforms.vesicaCount.value = visual.vesicaCount
    },
    [uniforms],
  )

  const [{ circleColor, vesicaColor, vesicaCount, circleSizeStart, circleSizeEnd, circleThickness }, setControlsRaw] =
    useControls(() => {
      const handleTimeChange = (value: number, _path: string, context: ImpactTimelineContext) => {
        // Programmatic slider refreshes and the initial call echo back through
        // onChange; only real panel edits are allowed to move the playhead.
        if (!shouldAcceptImpactTimeEdit(playback.state, value, context)) return
        playback.seekFromPanel(value)
        uniforms.time.value = playback.state.time
      }

      const handleDurationChange = (value: number) => {
        playback.setDurationFromPanel(value)
        uniforms.duration.value = playback.state.duration
      }

      const handleAutoplayChange = (value: boolean) => {
        playback.setAutoplayFromPanel(value)
        // Pausing stops the throttled refreshes; snap the slider to the exact
        // playhead so the user starts dragging from what is on screen.
        if (!playback.state.autoplay) setControls({ time: playback.state.time })
      }

      const presets: Record<string, ButtonInput> = Object.fromEntries(
        impactPresets.map(preset => [
          preset.name,
          button(() => {
            playback.applyPreset(preset)
            // Write the new looks before the next frame is drawn, so the first
            // frame after the click already uses the preset's colors and sizes.
            applyVisualUniforms(preset.visual)
            uniforms.time.value = playback.state.time
            uniforms.seed.value = playback.state.seed
            uniforms.duration.value = playback.state.duration
            setControls({
              ...toLevaUniforms(preset.visual),
              duration: preset.duration,
              autoplay: true,
              time: 0,
            })
          }),
        ]),
      )

      return {
        Animation: folder({
          time: {
            value: 0,
            min: 0,
            max: 1,
            step: 0.01,
            transient: true,
            onChange: handleTimeChange,
            onEditStart: () => playback.beginScrub(),
            onEditEnd: () => playback.endScrub(),
          },
          duration: {
            value: defaultDuration,
            min: 0,
            max: 3,
            step: 0.1,
            transient: true,
            onChange: handleDurationChange,
          },
          autoplay: { value: true, transient: true, onChange: handleAutoplayChange },
        }),
        Uniforms: folder({
          circleColor: { value: toLevaColor(defaultUniforms.circleColor) },
          vesicaColor: { value: toLevaColor(defaultUniforms.vesicaColor) },
          circleSizeStart: { value: defaultUniforms.circleSizeStart, min: 0, max: 1, step: 0.01 },
          circleSizeEnd: { value: defaultUniforms.circleSizeEnd, min: 0, max: 1, step: 0.01 },
          circleThickness: { value: defaultUniforms.circleThickness, min: 0, max: 1, step: 0.01 },
          vesicaCount: {
            value: defaultUniforms.vesicaCount,
            min: 0,
            max: 15,
            step: 1,
          },
        }),
        Presets: folder(presets),
      }
    })

  // Transient inputs are omitted from leva's setter type; the page writes them
  // deliberately, so widen the setter once here instead of casting per call.
  const setControls = setControlsRaw as (patch: ImpactControlPatch) => void

  // Shadows and preset clicks both arrive through the controls; mirror them into
  // the uniforms before paint so a frame never renders the previous visuals.
  useLayoutEffect(() => {
    applyVisualUniforms({
      circleColor: fromLevaColor(circleColor),
      vesicaColor: fromLevaColor(vesicaColor),
      circleSizeStart,
      circleSizeEnd,
      circleThickness,
      vesicaCount,
    })
  }, [applyVisualUniforms, circleColor, vesicaColor, circleSizeStart, circleSizeEnd, circleThickness, vesicaCount])

  useFrame((_, delta) => {
    const step = playback.advance(delta)

    // The timeline is the only writer of the playback uniforms.
    uniforms.time.value = step.time
    uniforms.seed.value = step.seed
    uniforms.duration.value = playback.state.duration

    if (step.reflect) setControls({ time: step.time })
  })

  return <meshBasicNodeMaterial ref={materialRef} {...nodes} transparent />
}

const ImpactPage = () => (
  <Page title="Impact" levaProps={{ theme: { sizes: { rootWidth: '310px' } } }} is2D>
    <ImpactMaterial />
  </Page>
)

export default ImpactPage
