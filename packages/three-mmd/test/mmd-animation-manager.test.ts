import { PmxObject } from 'babylon-mmd/esm/Loader/Parser/pmxObject'
import {
  AnimationClip,
  Bone,
  BufferGeometry,
  MeshBasicMaterial,
  NumberKeyframeTrack,
  PerspectiveCamera,
  Skeleton,
  SkinnedMesh,
  Vector3,
  VectorKeyframeTrack,
} from 'three'
import { describe, expect, it, vi } from 'vitest'

import { MMD, MMDAnimationManager } from '../src'

const createMmd = (name: string) => {
  const bone = new Bone()
  bone.name = name

  const mesh = new SkinnedMesh(new BufferGeometry(), new MeshBasicMaterial())
  mesh.add(bone)
  mesh.bind(new Skeleton([bone]))

  const pmx: PmxObject = {
    bones: [{
      appendTransform: undefined,
      axisLimit: undefined,
      englishName: name,
      externalParentTransform: undefined,
      flag: 0,
      ik: undefined,
      localVector: undefined,
      name,
      parentBoneIndex: -1,
      position: [0, 0, 0],
      tailPosition: [0, 0, 0],
      transformOrder: 0,
    }],
    displayFrames: [],
    header: {
      additionalVec4Count: 0,
      boneIndexSize: 4,
      comment: '',
      encoding: PmxObject.Header.Encoding.Utf8,
      englishComment: '',
      englishModelName: '',
      materialIndexSize: 4,
      modelName: name,
      morphIndexSize: 4,
      rigidBodyIndexSize: 4,
      signature: 'PMX',
      textureIndexSize: 4,
      version: 2,
      vertexIndexSize: 4,
    },
    indices: new Uint8Array(),
    joints: [],
    materials: [],
    morphs: [],
    rigidBodies: [],
    softBodies: [],
    textures: [],
    vertices: [],
  }

  return new MMD(pmx, mesh)
}

const createClip = (name: string) =>
  new AnimationClip(name, 1, [new VectorKeyframeTrack('.position', [0, 1], [0, 0, 0, 1, 0, 0])])

const createCameraClip = () =>
  new AnimationClip('camera animation', 1, [
    new VectorKeyframeTrack('target.position', [0, 1], [0, 0, -1, 1, 2, -3]),
    new NumberKeyframeTrack('.fov', [0, 1], [30, 60]),
  ])

describe('mMDAnimationManager', () => {
  it('advances every registered MMD through its mixer and MMD update', () => {
    const first = createMmd('first')
    const second = createMmd('second')
    const firstPhysicsUpdate = vi.fn()
    const secondPhysicsUpdate = vi.fn()
    const firstPhysics = {
      createHelper: <T>() => undefined as T,
      update: firstPhysicsUpdate,
    }
    const secondPhysics = {
      createHelper: <T>() => undefined as T,
      update: secondPhysicsUpdate,
    }
    first.setPhysics(() => firstPhysics)
    second.setPhysics(() => secondPhysics)
    const manager = new MMDAnimationManager()

    manager.add(first, { animation: createClip('first animation') })
    manager.add(second, { animation: createClip('second animation') })
    manager.update(0.25)

    expect(first.mesh.position.x).toBeCloseTo(0.25)
    expect(second.mesh.position.x).toBeCloseTo(0.25)
    expect(firstPhysicsUpdate).toHaveBeenCalledOnce()
    expect(firstPhysicsUpdate).toHaveBeenCalledWith(0.25)
    expect(secondPhysicsUpdate).toHaveBeenCalledOnce()
    expect(secondPhysicsUpdate).toHaveBeenCalledWith(0.25)
  })

  it('resets physics when a skeletal animation loops', () => {
    const mmd = createMmd('physics-loop')
    const events: string[] = []
    const resetPositions: number[] = []
    const physics = {
      createHelper: <T>() => undefined as T,
      reset: () => {
        resetPositions.push(mmd.mesh.skeleton.bones[0].position.x)
        events.push('reset')
      },
      update: () => events.push('update'),
    }
    mmd.setPhysics(() => physics)
    const manager = new MMDAnimationManager({ duration: 2 })

    manager.add(mmd, {
      animation: new AnimationClip('skeletal animation', 1, [
        new VectorKeyframeTrack('.bones[0].position', [0, 1], [0, 0, 0, 1, 0, 0]),
      ]),
    })
    manager.update(2.1)

    expect(events).toEqual(['reset', 'update'])
    expect(resetPositions[0]).toBeCloseTo(0.1)

    manager.update(2.1, { physics: false })
    expect(events).toEqual(['reset', 'update', 'reset'])
  })

  it('restores animation state alongside physics when a skeletal animation loops', () => {
    const mmd = createMmd('state-loop')
    const events: string[] = []
    const physics = {
      createHelper: <T>() => undefined as T,
      reset: () => events.push('physics-reset'),
      update: () => events.push('physics-update'),
    }
    mmd.setPhysics(() => physics)
    const resetAnimationState = vi.spyOn(mmd, 'resetAnimationState')
    const manager = new MMDAnimationManager({ duration: 2 })

    manager.add(mmd, {
      animation: new AnimationClip('skeletal animation', 1, [
        new VectorKeyframeTrack('.bones[0].position', [0, 1], [0, 0, 0, 1, 0, 0]),
      ]),
    })

    manager.update(1)
    expect(resetAnimationState).not.toHaveBeenCalled()

    // Crossing the cycle boundary resets both the animation state (IK,
    // fixed-axis cache) and the physics service.
    manager.update(1.5)
    expect(resetAnimationState).toHaveBeenCalledOnce()
    expect(events).toEqual(['physics-update', 'physics-reset', 'physics-update'])
  })

  it('does not reset animation state for a loop without skeletal tracks', () => {
    const mmd = createMmd('property-loop')
    const resetAnimationState = vi.spyOn(mmd, 'resetAnimationState')
    const manager = new MMDAnimationManager({ duration: 2 })

    manager.add(mmd, {
      animation: new AnimationClip('property only', 1, [
        new VectorKeyframeTrack('.position', [0, 1], [0, 0, 0, 1, 0, 0]),
      ]),
    })

    manager.update(2.1)

    expect(resetAnimationState).not.toHaveBeenCalled()
  })

  it('passes MMD update options to every registered model', () => {
    const mmd = createMmd('options')
    const physicsUpdate = vi.fn()
    const physics = {
      createHelper: <T>() => undefined as T,
      update: physicsUpdate,
    }
    mmd.setPhysics(() => physics)
    const manager = new MMDAnimationManager()

    manager.add(mmd)
    manager.update(0.25, { physics: false })
    expect(physicsUpdate).not.toHaveBeenCalled()

    manager.update(0.25)
    expect(physicsUpdate).toHaveBeenCalledOnce()
    expect(physicsUpdate).toHaveBeenCalledWith(0.25)
  })

  it('syncs registered animation clips to the configured duration without changing the source clip', () => {
    const mmd = createMmd('duration')
    const animation = createClip('duration animation')
    const manager = new MMDAnimationManager({ duration: 2 })

    manager.add(mmd, { animation })
    manager.update(1.5)
    expect(mmd.mesh.position.x).toBeCloseTo(1)
    expect(animation.duration).toBe(1)

    manager.update(0.5)
    expect(mmd.mesh.position.x).toBeCloseTo(0)
  })

  it('updates the registered MMD camera and its target after animation', () => {
    const camera = new PerspectiveCamera(30, 1, 0.1, 100)
    const manager = new MMDAnimationManager()

    manager.add(camera, { animation: createCameraClip() })
    manager.update(0.5)

    expect(camera.fov).toBe(45)
    expect(camera.children).toHaveLength(1)
    expect(camera.children[0]).toMatchObject({ name: 'target' })
    expect(camera.children[0].position.toArray()).toEqual([0.5, 1, -2])
    const direction = camera.getWorldDirection(new Vector3())
    expect(direction.x).toBeCloseTo(0.21821789, 6)
    expect(direction.y).toBeCloseTo(0.43643578, 6)
    expect(direction.z).toBeCloseTo(-0.87287156, 6)
  })

  it('does not update or attach a target to a camera without animation', () => {
    const camera = new PerspectiveCamera()
    camera.position.set(1, 2, 3)
    camera.rotation.set(0.1, 0.2, 0.3)
    const position = camera.position.clone()
    const quaternion = camera.quaternion.clone()
    const manager = new MMDAnimationManager()

    manager.add(camera)
    manager.update(1)

    expect(camera.position.equals(position)).toBe(true)
    expect(camera.quaternion.equals(quaternion)).toBe(true)
    expect(camera.children).toHaveLength(0)

    manager.remove(camera)
    expect(() => manager.add(new PerspectiveCamera())).not.toThrow()
  })

  it('starts delayed audio once and stops audio it started when removed', () => {
    let playing = false
    const play = vi.fn(() => {
      playing = true
    })
    const stop = vi.fn(() => {
      playing = false
    })
    const audio = {
      get isPlaying() {
        return playing
      },
      play,
      stop,
      type: 'Audio',
    } as unknown as import('three').Audio
    const manager = new MMDAnimationManager()

    manager.add(audio, { delayTime: 1 })
    manager.update(0.5)
    expect(play).not.toHaveBeenCalled()

    manager.update(0.5)
    manager.update(1)
    expect(play).toHaveBeenCalledOnce()

    manager.remove(audio)
    expect(stop).toHaveBeenCalledOnce()
  })

  it('restarts audio after each configured duration and delay', () => {
    let playing = false
    const play = vi.fn(() => {
      playing = true
    })
    const stop = vi.fn(() => {
      playing = false
    })
    const audio = {
      get isPlaying() {
        return playing
      },
      play,
      stop,
      type: 'Audio',
    } as unknown as import('three').Audio
    const manager = new MMDAnimationManager({ duration: 2 })

    manager.add(audio, { delayTime: 0.5 })
    manager.update(0.5)
    expect(play).toHaveBeenCalledOnce()

    manager.update(1.5)
    expect(stop).toHaveBeenCalledOnce()
    expect(play).toHaveBeenCalledOnce()

    manager.update(0.5)
    expect(play).toHaveBeenCalledTimes(2)
  })

  it('does not start audio in the trailing silence of a global loop', () => {
    let playing = false
    const play = vi.fn(() => {
      playing = true
    })
    const stop = vi.fn(() => {
      playing = false
    })
    const audio = {
      buffer: { duration: 3 },
      get isPlaying() {
        return playing
      },
      play,
      stop,
      type: 'Audio',
    } as unknown as import('three').Audio
    const manager = new MMDAnimationManager({ duration: 10 })

    manager.add(audio, { delayTime: 2 })
    manager.update(6)
    expect(play).not.toHaveBeenCalled()

    manager.update(10)
    expect(play).not.toHaveBeenCalled()

    manager.update(6)
    expect(play).toHaveBeenCalledOnce()
  })

  it('removes one model without affecting other registered objects', () => {
    const first = createMmd('first')
    const second = createMmd('second')
    const camera = new PerspectiveCamera()
    const manager = new MMDAnimationManager()

    manager.add(first)
    manager.add(second, { animation: createClip('second animation') })
    manager.add(camera)
    manager.remove(first)
    second.mesh.position.x = 0
    manager.update(0.25)

    expect(first.mesh.position.x).toBe(0)
    expect(second.mesh.position.x).toBeCloseTo(0.25)

    manager.dispose()
    expect(camera.children).toHaveLength(0)
  })

  const createAudio = (duration?: number) => {
    let playing = false
    const play = vi.fn(() => {
      playing = true
    })
    const stop = vi.fn(() => {
      playing = false
    })
    const audio = {
      buffer: duration === undefined ? undefined : { duration },
      get isPlaying() {
        return playing
      },
      play,
      stop,
      type: 'Audio',
    } as unknown as import('three').Audio

    return { audio, play, stop }
  }

  it('does not stop audio that was already playing when remove is called', () => {
    const { audio, play, stop } = createAudio()
    const manager = new MMDAnimationManager()

    // Started outside the manager: it owns playback, not the manager.
    void audio.play()
    manager.add(audio, { delayTime: 0 })
    manager.update(1)
    manager.remove(audio)

    expect(play).toHaveBeenCalledOnce()
    expect(stop).not.toHaveBeenCalled()
  })

  it('does not stop externally started audio at a cycle boundary', () => {
    const { audio, play, stop } = createAudio()
    const manager = new MMDAnimationManager({ duration: 2 })

    void audio.play()
    manager.add(audio, { delayTime: 0 })
    manager.update(0.5)
    manager.update(2)

    expect(play).toHaveBeenCalledOnce()
    expect(stop).not.toHaveBeenCalled()
  })

  it('restarts audio at delayTime on every configured cycle', () => {
    const { audio, play, stop } = createAudio(1)
    const manager = new MMDAnimationManager({ duration: 2 })

    manager.add(audio, { delayTime: 0.5 })
    manager.update(0.5)
    expect(play).toHaveBeenCalledOnce()

    // Cycle boundary: manager-owned audio is stopped and the next cycle waits
    // for its own delayTime before triggering again.
    manager.update(1.9)
    expect(stop).toHaveBeenCalledOnce()
    expect(play).toHaveBeenCalledOnce()

    manager.update(0.5)
    expect(play).toHaveBeenCalledTimes(2)

    manager.update(1.5)
    manager.update(0.5)
    expect(play).toHaveBeenCalledTimes(3)
  })

  it('never plays audio during a cycle where the delay window has already passed', () => {
    const { audio, play } = createAudio(1)
    const manager = new MMDAnimationManager({ duration: 10 })

    manager.add(audio, { delayTime: 1 })
    // The whole delay window is skipped in one large step.
    manager.update(5)
    expect(play).not.toHaveBeenCalled()

    // The tail silence after delayTime + duration must not start audio either.
    manager.update(4)
    expect(play).not.toHaveBeenCalled()

    // Just before the next delay, still silent.
    manager.update(0.9)
    expect(play).not.toHaveBeenCalled()

    // Crossing into the next cycle and then into its delay window triggers
    // exactly once.
    manager.update(0.2)
    expect(play).not.toHaveBeenCalled()
    manager.update(1)
    expect(play).toHaveBeenCalledOnce()
  })

  it('starts manager audio in the delay window and stops at the next cycle', () => {
    const { audio, play, stop } = createAudio()
    const manager = new MMDAnimationManager({ duration: 2 })

    manager.add(audio, { delayTime: 1 })
    manager.update(0.5)
    expect(play).not.toHaveBeenCalled()

    manager.update(0.5)
    expect(play).toHaveBeenCalledOnce()

    manager.update(1)
    expect(stop).toHaveBeenCalledOnce()

    manager.update(0.5)
    expect(play).toHaveBeenCalledOnce()

    manager.update(0.5)
    expect(play).toHaveBeenCalledTimes(2)
  })

  it('can add the same objects again after dispose', () => {
    const mmd = createMmd('reuse')
    const camera = new PerspectiveCamera()
    const { audio, play } = createAudio()
    const animation = createClip('reuse animation')
    const manager = new MMDAnimationManager({ duration: 2 })

    manager.add(mmd, { animation })
    manager.add(camera, { animation: createCameraClip() })
    manager.add(audio, { delayTime: 0.5 })
    manager.update(0.5)
    expect(play).toHaveBeenCalledOnce()

    manager.dispose()

    expect(() => {
      manager.add(mmd, { animation: createClip('reuse again') })
      manager.add(camera, { animation: createCameraClip() })
      manager.add(audio, { delayTime: 0.5 })
    }).not.toThrow()

    manager.update(0.5)
    expect(play).toHaveBeenCalledTimes(2)
    expect(camera.children).toHaveLength(1)

    // The re-added audio also restarts across the configured cycles.
    manager.update(1.5)
    manager.update(0.5)
    expect(play).toHaveBeenCalledTimes(3)
  })
})
