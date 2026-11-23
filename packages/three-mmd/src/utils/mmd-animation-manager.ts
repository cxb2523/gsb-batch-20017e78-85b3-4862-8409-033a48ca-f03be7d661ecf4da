import type { AnimationClip, Audio, Camera } from 'three'

import type { MMDUpdateOptions } from './mmd'

import { AnimationMixer, Object3D } from 'three'

import { MMD } from './mmd'

export interface AudioAnimationOptions {
  delayTime?: number
}

export interface MMDAnimationOptions {
  animation?: AnimationClip | AnimationClip[]
}

const playAnimation = (
  mixer: AnimationMixer,
  animation?: AnimationClip | AnimationClip[],
  duration?: number,
) => {
  if (animation == null)
    return

  const animations = (Array.isArray(animation) ? animation : [animation]) as readonly AnimationClip[]
  animations.forEach((clip) => {
    if (duration != null) {
      clip = clip.clone()
      clip.duration = duration
    }

    mixer.clipAction(clip).play()
  })
}

/** Coordinates MMD, camera, and audio animation on a single render-loop update. */
export class MMDAnimationManager {
  private audio?: Audio
  private audioDelay = 0
  private audioDuration?: number

  /** Time elapsed inside the current cycle, in [0, duration) when a duration is configured. */
  private audioElapsed = 0
  /** Whether the manager started the currently playing audio and may stop it again. */
  private audioStartedByManager = false
  /** Whether the current cycle already triggered (or deliberately skipped) the audio. */
  private audioTriggered = false

  private camera?: Camera
  private cameraMixer?: AnimationMixer
  private cameraTarget?: Object3D
  private readonly duration?: number
  private readonly models = new Map<MMD, AnimationMixer>()

  public constructor(options: { duration?: number } = {}) {
    if (options.duration != null && (!Number.isFinite(options.duration) || options.duration <= 0))
      throw new RangeError('MMDAnimationManager: duration must be a positive finite number.')

    this.duration = options.duration
  }

  public add(mmd: MMD, options?: MMDAnimationOptions): this
  public add(camera: Camera, options?: MMDAnimationOptions): this
  public add(audio: Audio, options?: AudioAnimationOptions): this
  public add(
    object: Audio | Camera | MMD,
    options: AudioAnimationOptions | MMDAnimationOptions = {},
  ): this {
    if (object instanceof MMD) {
      if (this.models.has(object))
        throw new Error('MMDAnimationManager: MMD has already been added.')

      const mmdOptions = options as MMDAnimationOptions
      const mixer = new AnimationMixer(object.mesh)
      const { animation } = mmdOptions

      this.models.set(object, mixer)
      playAnimation(mixer, animation, this.duration)
      return this
    }
    else if ('isCamera' in object) {
      if (this.camera !== undefined)
        throw new Error('MMDAnimationManager: Camera has already been added.')

      const cameraOptions = options as MMDAnimationOptions
      this.camera = object

      if (cameraOptions.animation != null) {
        const target = new Object3D()
        target.name = 'target'

        object.add(target)
        this.cameraTarget = target
        this.cameraMixer = new AnimationMixer(object)
        playAnimation(this.cameraMixer, cameraOptions.animation, this.duration)
      }

      return this
    }
    else if (object.type === 'Audio') {
      if (this.audio !== undefined)
        throw new Error('MMDAnimationManager: Audio has already been added.')

      const audioOptions = options as AudioAnimationOptions
      this.audio = object
      this.audioDelay = audioOptions.delayTime ?? 0
      this.audioDuration = object.buffer?.duration
      this.audioElapsed = 0
      // Audio that was already playing when it was added is left alone: the
      // manager only takes over once the source is silent.
      this.audioTriggered = object.isPlaying
      this.audioStartedByManager = false
      return this
    }
    else {
      throw new TypeError('MMDAnimationManager.add: expected an MMD, Camera, or Audio.')
    }
  }

  public dispose() {
    for (const mmd of this.models.keys())
      this.remove(mmd)

    if (this.camera !== undefined)
      this.remove(this.camera)

    if (this.audio !== undefined)
      this.remove(this.audio)
  }

  public remove(object: Audio | Camera | MMD): this {
    if (object instanceof MMD) {
      const mixer = this.models.get(object)
      if (mixer == null)
        return this

      mixer.stopAllAction()
      // Forget the action state so the same model can be added again, and put
      // the IK switches animation took over back to their pre-animation values.
      mixer.uncacheRoot(object.mesh)
      object.resetAnimationState()
      this.models.delete(object)
      return this
    }
    else if ('isCamera' in object) {
      if (this.camera !== object)
        return this

      if (this.cameraMixer != null) {
        this.cameraMixer.stopAllAction()
        this.cameraMixer.uncacheRoot(object)
      }
      if (this.cameraTarget?.parent === object)
        object.remove(this.cameraTarget)

      this.camera = undefined
      this.cameraMixer = undefined
      this.cameraTarget = undefined
      return this
    }
    else if (object.type === 'Audio') {
      if (this.audio !== object)
        return this

      // Only stop audio the manager itself started; externally started audio
      // must keep playing after it is removed from the manager.
      if (this.audioStartedByManager && object.isPlaying)
        object.stop()

      this.audio = undefined
      this.audioDelay = 0
      this.audioDuration = undefined
      this.audioElapsed = 0
      this.audioTriggered = false
      this.audioStartedByManager = false
      return this
    }
    else {
      throw new Error('MMDAnimationManager.remove: expected an MMD, Camera, or Audio.')
    }
  }

  public update(delta: number, options?: MMDUpdateOptions): this {
    this.updateAudio(delta)

    for (const [mmd, mixer] of this.models)
      this.updateMMD(mmd, mixer, delta, options)

    if (this.camera != null && this.cameraMixer != null && this.cameraTarget != null) {
      this.cameraMixer.update(delta)
      const camera = this.camera as Camera & { updateProjectionMatrix?: () => void }
      camera.updateProjectionMatrix?.()
      this.camera.up.set(0, 1, 0)
      this.camera.up.applyQuaternion(this.camera.quaternion)
      this.camera.lookAt(this.cameraTarget.position)
    }

    return this
  }

  private updateAudio(delta: number) {
    if (this.audio == null)
      return

    const audio = this.audio
    this.audioElapsed += delta

    if (this.duration != null) {
      while (this.audioElapsed >= this.duration) {
        this.audioElapsed -= this.duration
        // Start every cycle from silence so the next cycle can trigger the
        // audio again at its own delayTime. Only stop audio the manager owns;
        // audio started from outside must keep playing.
        if (this.audioStartedByManager && audio.isPlaying)
          audio.stop()
        this.audioStartedByManager = false
        this.audioTriggered = false
      }
    }

    // The playable window is [delayTime, delayTime + audio duration]. Audio
    // shorter than the cycle therefore stays silent for the remainder of the
    // cycle instead of being started early.
    const audioEnd = this.audioDuration == null
      ? Number.POSITIVE_INFINITY
      : this.audioDelay + this.audioDuration

    if (this.audioTriggered || this.audioElapsed < this.audioDelay || this.audioElapsed > audioEnd)
      return

    // Mark the cycle as handled even for audio the manager did not start, so
    // it never plays or stops a source it does not own.
    this.audioTriggered = true
    if (!audio.isPlaying) {
      audio.play()
      this.audioStartedByManager = true
    }
  }

  private updateMMD(
    mmd: MMD,
    mixer: AnimationMixer,
    delta: number,
    options?: MMDUpdateOptions,
  ) {
    let skeletalAnimationLooped = false
    const onLoop = (event: { action: { getClip: () => AnimationClip } }) => {
      if (!event.action.getClip().tracks.some(track => track.name.startsWith('.bones'))) {
        return
      }

      skeletalAnimationLooped = true
    }

    mmd.beforeUpdate()
    mixer.addEventListener('loop', onLoop)
    try {
      mixer.update(delta)
    }
    finally {
      mixer.removeEventListener('loop', onLoop)
    }

    // A new cycle starts from the state animation found when it took over:
    // restore the IK switches to their pre-animation values and drop the
    // fixed-axis bone cache so the first frame re-derives it from the freshly
    // sampled animation pose instead of the previous cycle's output. The
    // property track then re-applies the new cycle's states on top.
    if (skeletalAnimationLooped)
      mmd.resetAnimationState()

    mmd.updateAnimation(mixer)
    mmd.beforePhysics(options)

    if (skeletalAnimationLooped)
      mmd.physics?.reset?.()

    if (options?.physics !== false)
      mmd.physics?.update(delta)
    mmd.afterPhysics(options)
  }
}
