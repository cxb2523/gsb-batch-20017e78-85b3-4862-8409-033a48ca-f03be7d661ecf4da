import * as THREE from "three"
import gsap from "gsap"
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js"
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js"
import { Flow } from "three/examples/jsm/modifiers/CurveModifier.js"
import firefliesVertexShader from "../shaders/fireflies/vertex.glsl"
import firefliesFragmentShader from "../shaders/fireflies/fragment.glsl"
import waterVertexShader from "../shaders/water/vertex.glsl"
import waterFragmentShader from "../shaders/water/fragment.glsl"

/**
 * 场景装配入口（scene rig）
 *
 * 一次装配 = 一个可释放的句柄：
 *   - 同步创建：地面、水面、萤火虫、锦鲤游动曲线
 *   - 异步装配：锦鲤贴图 / 锦鲤模型 / 庭院烘焙贴图 / 庭院模型
 *   - handle.ready 在“所有必需资源成功”或“任一必需资源失败”时都会 resolve，
 *     绝不以 pending 状态卡住加载遮罩。
 *
 * 调试项从外部 settings 读取，因此重建后新句柄会自动沿用当前颜色 / 尺寸等设置。
 */

export const RESOURCE_LABELS = {
  matcap: "锦鲤材质贴图（matcaps11.png）",
  baked: "庭院烘焙贴图（jg-bake.jpg）",
  koi: "锦鲤模型（koi.glb）",
  garden: "庭院模型（japanese-garden.glb）",
}

export const RESOURCE_KEYS = ["matcap", "baked", "koi", "garden"]

const DEFAULT_URLS = {
  matcap: "./matcaps11.png",
  baked: "./jg-bake.jpg",
  koi: "./koi.glb",
  garden: "./japanese-garden.glb",
}

const KOI_CURVE_POINTS = [
  [-0.3, 0.2, -0.3],
  [0.5, 0.2, -0.1],
  [0.2, 0.2, 0.7],
  [-0.8, 0.2, 0.7],
  [-0.6, 0.2, 0.1],
  [-0.6, 0.2, -0.2],
]

let rigSequence = 0

class StaleResultError extends Error {
  constructor(key) {
    super(`rig 已释放，丢弃 ${key} 的迟到结果`)
    this.name = "StaleResultError"
    this.resourceKey = key
  }
}

function isStaleError(error) {
  return error instanceof StaleResultError || error.name === "StaleResultError"
}

function createResourceError(key, url, cause, message) {
  const label = RESOURCE_LABELS[key] || key
  const causeMessage =
    cause && cause.message && cause.message !== url ? `：${cause.message}` : ""
  const error = new Error(
    message || `请求 ${url} 失败（文件缺失、网络错误或解码失败）${causeMessage}`
  )
  error.name = "ResourceError"
  error.resourceKey = key
  error.resourceUrl = url
  error.resourceLabel = label
  error.cause = cause || null
  return error
}

function createRegistry() {
  return {
    geometries: new Set(),
    materials: new Set(),
    textures: new Set(),
  }
}

function collectMaterialTextures(material, onTexture) {
  for (const key in material) {
    const value = material[key]
    if (value && value.isTexture) onTexture(value)
  }

  if (material.uniforms) {
    for (const key in material.uniforms) {
      const uniform = material.uniforms[key]
      const value = uniform && uniform.value
      if (value && value.isTexture) onTexture(value)
    }
  }
}

function collectMaterial(material, registry) {
  if (!material) return
  if (Array.isArray(material)) {
    material.forEach((entry) => collectMaterial(entry, registry))
    return
  }

  registry.materials.add(material)
  collectMaterialTextures(material, (texture) => registry.textures.add(texture))
}

function collectObjectResources(object3D, registry) {
  if (!object3D) return
  object3D.traverse((child) => {
    if (child.geometry) registry.geometries.add(child.geometry)
    if (child.material) collectMaterial(child.material, registry)
  })
}

function releaseRegistry(registry) {
  registry.geometries.forEach((geometry) => geometry.dispose())
  registry.materials.forEach((material) => material.dispose())
  registry.textures.forEach((texture) => texture.dispose())
  registry.geometries.clear()
  registry.materials.clear()
  registry.textures.clear()
}

function releaseDetachedObject(object3D) {
  const registry = createRegistry()
  collectObjectResources(object3D, registry)
  releaseRegistry(registry)
}

function withSimulatedFailure(key, url, failResources) {
  if (!failResources || failResources.indexOf(key) === -1) return url
  const slash = Math.max(url.lastIndexOf("/"), url.lastIndexOf("\\"))
  const filename = slash === -1 ? url : url.slice(slash + 1)
  // 故意指向不存在的路径，走真实的 loader 失败分支
  return `./__simulate_missing__/${key}-${filename}`
}

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

/**
 * @param {Object} options
 * @param {THREE.Scene} options.scene 场景
 * @param {Object} options.settings 调试项（waterColor1/2、fireflySize 等）
 * @param {string[]} [options.failResources] 需要模拟加载失败的资源 key
 * @param {Object} [options.urls] 覆盖默认资源地址
 * @param {number} [options.applyDelayMs] 结果写入场景前的延迟（用于演示“旧请求迟到”）
 * @param {number} [options.pixelRatio] 萤火虫点尺寸使用的像素比
 * @param {Function} [options.onLog] 生命周期日志
 */
export function createSceneRig(options) {
  const opts = options || {}
  const scene = opts.scene
  const settings = opts.settings || {}
  const failResources = opts.failResources || []
  const urls = Object.assign({}, DEFAULT_URLS, opts.urls || {})
  const dracoDecoderPath = opts.dracoDecoderPath || "draco/"
  const applyDelayMs = opts.applyDelayMs || 0
  const pixelRatio = opts.pixelRatio || Math.min(window.devicePixelRatio, 2)
  const onLog = opts.onLog || function () {}

  if (!scene) throw new Error("createSceneRig: options.scene is required")

  const rigId = ++rigSequence
  const startedAt = typeof performance !== "undefined" ? performance.now() : 0
  const registry = createRegistry()
  const managerErrors = []

  let disposed = false
  let disposedSummary = null
  let flow = null
  let shishiodoshiTween = null

  // 释放信号：让仍在等待的旧任务立即结束。Draco worker 被 terminate 后，
  // 其 decode Promise 可能永远不会 settle，必须靠信号把整条链路收尾。
  let signalDisposal = null
  const disposalSignal = new Promise((resolve) => {
    signalDisposal = resolve
  })

  function raceWithDisposal(promise, key) {
    return Promise.race([
      promise,
      disposalSignal.then(() => {
        throw new StaleResultError(key)
      }),
    ])
  }

  const root = new THREE.Group()
  root.name = `garden-rig-${rigId}`
  scene.add(root)

  /**
   * Loaders —— 每个句柄独占一套，重建时随句柄一起释放，
   * 因此旧请求的 LoadingManager / 回调不会影响新场景。
   */
  const manager = new THREE.LoadingManager()
  manager.onError = (url) => {
    managerErrors.push(url)
    onLog("resource-error", { rigId, url })
  }

  const textureLoader = new THREE.TextureLoader(manager)

  const dracoLoader = new DRACOLoader(manager)
  dracoLoader.setDecoderPath(dracoDecoderPath)

  const gltfLoader = new GLTFLoader(manager)
  gltfLoader.setDRACOLoader(dracoLoader)

  /**
   * 同步装配：地面 / 水面 / 萤火虫 / 曲线
   */
  const floorGeometry = new THREE.PlaneBufferGeometry(4, 4, 1)
  const floorMaterial = new THREE.MeshBasicMaterial({ color: "#2b1d0e" })
  registry.geometries.add(floorGeometry)
  collectMaterial(floorMaterial, registry)
  const floorMesh = new THREE.Mesh(floorGeometry, floorMaterial)
  floorMesh.rotation.x = Math.PI * 0.5
  root.add(floorMesh)

  const curve = new THREE.CatmullRomCurve3(
    KOI_CURVE_POINTS.map((point) => new THREE.Vector3(point[0], point[1], point[2]))
  )
  curve.curveType = "centripetal"
  curve.closed = true

  const lineGeometry = new THREE.BufferGeometry().setFromPoints(curve.getPoints(50))
  const lineMaterial = new THREE.LineBasicMaterial({
    transparent: true,
    opacity: 0,
  })
  registry.geometries.add(lineGeometry)
  collectMaterial(lineMaterial, registry)
  root.add(new THREE.LineLoop(lineGeometry, lineMaterial))

  // Water
  const waterGeometry = new THREE.PlaneGeometry(2.5, 2.5, 150, 150)
  const waterMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uColor1: { value: new THREE.Color(settings.waterColor1 || "#96c4e8") },
      uColor2: { value: new THREE.Color(settings.waterColor2 || "#e1c1eb") },
    },
    vertexShader: waterVertexShader,
    fragmentShader: waterFragmentShader,
    transparent: true,
  })
  registry.geometries.add(waterGeometry)
  collectMaterial(waterMaterial, registry)

  const waterMesh = new THREE.Mesh(waterGeometry, waterMaterial)
  waterMesh.rotation.x = -Math.PI * 0.5
  waterMesh.position.set(0, 0.3, 0.2)
  root.add(waterMesh)

  // Fireflies
  const firefliesCount = 30
  const positionArray = new Float32Array(firefliesCount * 3)
  const scaleArray = new Float32Array(firefliesCount)

  for (let i = 0; i < firefliesCount; i++) {
    positionArray[i * 3 + 0] = (Math.random() - 0.5) * 4
    positionArray[i * 3 + 1] = Math.random() * 1.5 + 0.3
    positionArray[i * 3 + 2] = (Math.random() - 0.5) * 4 + 0.5
    scaleArray[i] = Math.random()
  }

  const firefliesGeometry = new THREE.BufferGeometry()
  firefliesGeometry.setAttribute("position", new THREE.BufferAttribute(positionArray, 3))
  firefliesGeometry.setAttribute("aScale", new THREE.BufferAttribute(scaleArray, 1))

  const firefliesMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uPixelRatio: { value: pixelRatio },
      uSize: { value: typeof settings.fireflySize === "number" ? settings.fireflySize : 200 },
      uTime: { value: 0 },
    },
    vertexShader: firefliesVertexShader,
    fragmentShader: firefliesFragmentShader,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  registry.geometries.add(firefliesGeometry)
  collectMaterial(firefliesMaterial, registry)

  const fireflies = new THREE.Points(firefliesGeometry, firefliesMaterial)
  fireflies.name = "fireflies"
  root.add(fireflies)

  /**
   * 异步资源加载
   */
  function loadTextureResource(key, url) {
    const requestedUrl = withSimulatedFailure(key, url, failResources)
    const pending = new Promise((resolve, reject) => {
      textureLoader.load(
        requestedUrl,
        (texture) => {
          if (disposed) {
            texture.dispose()
            reject(new StaleResultError(key))
            return
          }
          resolve(texture)
        },
        undefined,
        (error) => reject(createResourceError(key, url, error))
      )
    })
    return raceWithDisposal(pending, key)
  }

  function loadGltfResource(key, url) {
    const requestedUrl = withSimulatedFailure(key, url, failResources)
    const pending = new Promise((resolve, reject) => {
      gltfLoader.load(
        requestedUrl,
        (gltf) => {
          if (disposed) {
            releaseDetachedObject(gltf.scene)
            reject(new StaleResultError(key))
            return
          }
          resolve(gltf)
        },
        undefined,
        (error) => reject(createResourceError(key, url, error))
      )
    })
    return raceWithDisposal(pending, key)
  }

  async function waitApplyWindow() {
    if (!applyDelayMs) return
    await wait(applyDelayMs)
  }

  // 结果在“到达”与“写入场景”之间可能发生释放：
  // 此时既不能写入新场景，也不能把它挂到已清空的 registry 上，必须就地回收。
  function claimOrDiscard(key, object3D) {
    if (!disposed) return
    releaseDetachedObject(object3D)
    throw new StaleResultError(key)
  }

  async function assembleKoi(matcapTexture) {
    const gltf = await loadGltfResource("koi", urls.koi)
    claimOrDiscard("koi", gltf.scene)
    await waitApplyWindow()
    claimOrDiscard("koi", gltf.scene)

    // 先登记 gltf 原始资源，再由本句柄的 registry 统一回收
    collectObjectResources(gltf.scene, registry)

    const koiRoot = gltf.scene.children.find((child) => child.name === "fish")
    const fishMesh = koiRoot && koiRoot.children[0]
    if (!fishMesh) {
      throw createResourceError(
        "koi",
        urls.koi,
        null,
        `${RESOURCE_LABELS.koi}内容不完整：找不到 "fish" 节点`
      )
    }

    const koiMaterial = new THREE.MeshMatcapMaterial({ matcap: matcapTexture })
    collectMaterial(koiMaterial, registry)
    fishMesh.material = koiMaterial

    const koiFlow = new Flow(gltf.scene)
    koiFlow.updateCurve(0, curve)
    collectObjectResources(koiFlow.object3D, registry)
    registry.textures.add(koiFlow.splineTexure)

    flow = koiFlow
    root.add(koiFlow.object3D)
    onLog("koi-ready", { rigId })
  }

  async function assembleGarden(bakedTexture) {
    const gltf = await loadGltfResource("garden", urls.garden)
    claimOrDiscard("garden", gltf.scene)
    await waitApplyWindow()
    claimOrDiscard("garden", gltf.scene)

    collectObjectResources(gltf.scene, registry)

    const bakedMesh = gltf.scene.children.find((child) => child.name === "bake")
    const shishiodoshiMesh = gltf.scene.children.find((child) => child.name === "shishi")
    const lampMesh = gltf.scene.children.find((child) => child.name === "lamp")
    if (!bakedMesh || !shishiodoshiMesh || !lampMesh) {
      throw createResourceError(
        "garden",
        urls.garden,
        null,
        `${RESOURCE_LABELS.garden}内容不完整：缺少 bake / shishi / lamp 节点`
      )
    }

    const bakedMaterial = new THREE.MeshBasicMaterial({ map: bakedTexture })
    const lampMaterial = new THREE.MeshBasicMaterial({ color: "#f5deb3" })
    collectMaterial(bakedMaterial, registry)
    collectMaterial(lampMaterial, registry)

    bakedMesh.material = bakedMaterial
    shishiodoshiMesh.material = bakedMaterial
    lampMesh.material = lampMaterial

    shishiodoshiTween = gsap.to(shishiodoshiMesh.rotation, {
      x: Math.PI * 0.25,
      repeat: -1,
      yoyo: true,
      repeatDelay: 2,
      ease: "power3.out",
      duration: 2,
    })

    root.add(gltf.scene)
    onLog("garden-ready", { rigId })
  }

  async function runTask(key, run, dependencies) {
    const blockedBy = (dependencies || []).filter((result) => result.status !== "ok")
    if (blockedBy.length) {
      return {
        key,
        status: "blocked",
        blockedBy: blockedBy.map((result) => result.key),
      }
    }

    try {
      const value = await run()
      return { key, status: "ok", value }
    } catch (error) {
      if (isStaleError(error)) return { key, status: "stale" }
      return { key, status: "error", error }
    }
  }

  const ready = (async () => {
    try {
      const matcapTask = runTask("matcap", async () => {
        const texture = await loadTextureResource("matcap", urls.matcap)
        registry.textures.add(texture)
        return texture
      })

      const bakedTask = runTask("baked", async () => {
        const texture = await loadTextureResource("baked", urls.baked)
        texture.flipY = false
        texture.encoding = THREE.sRGBEncoding
        registry.textures.add(texture)
        return texture
      })

      const textureResults = await Promise.all([matcapTask, bakedTask])
      const matcapResult = textureResults[0]
      const bakedResult = textureResults[1]

      const modelResults = await Promise.all([
        runTask("koi", () => assembleKoi(matcapResult.value), [matcapResult]),
        runTask("garden", () => assembleGarden(bakedResult.value), [bakedResult]),
      ])

      const results = [matcapResult, bakedResult, modelResults[0], modelResults[1]]
      const failures = results
        .filter((result) => result.status === "error")
        .map((result) => ({
          key: result.key,
          label: RESOURCE_LABELS[result.key] || result.key,
          url: urls[result.key],
          message: result.error.message,
        }))
      const blocked = results
        .filter((result) => result.status === "blocked")
        .map((result) => ({
          key: result.key,
          blockedBy: result.blockedBy,
        }))

      const ok = results.every((result) => result.status === "ok")
      const status = disposed ? "disposed" : ok ? "ready" : "failed"

      const summary = {
        rigId,
        status,
        ok,
        failures,
        blocked,
        managerErrors: managerErrors.slice(),
        results: results.map((result) => ({
          key: result.key,
          status: result.status,
        })),
      }
      onLog("rig-settled", summary)
      return summary
    } catch (error) {
      return {
        rigId,
        status: disposed ? "disposed" : "failed",
        ok: false,
        failures: [],
        blocked: [],
        managerErrors: managerErrors.slice(),
        internalError: error,
      }
    }
  })()

  /**
   * 渲染循环 / 调试接口：释放后全部为空操作
   */
  function update(elapsedTime) {
    if (disposed) return
    firefliesMaterial.uniforms.uTime.value = elapsedTime
    waterMaterial.uniforms.uTime.value = elapsedTime
    if (flow) flow.moveAlongCurve(0.001)
  }

  function setWaterColor1(color) {
    if (disposed) return
    waterMaterial.uniforms.uColor1.value.set(color)
  }

  function setWaterColor2(color) {
    if (disposed) return
    waterMaterial.uniforms.uColor2.value.set(color)
  }

  function setFireflySize(size) {
    if (disposed) return
    firefliesMaterial.uniforms.uSize.value = size
  }

  function setPixelRatio(ratio) {
    if (disposed) return
    firefliesMaterial.uniforms.uPixelRatio.value = ratio
  }

  function getStats() {
    if (disposed) {
      return { rigId, disposed: true, summary: disposedSummary }
    }
    return {
      rigId,
      disposed: false,
      rootChildren: root.children.length,
      resources: {
        geometries: registry.geometries.size,
        materials: registry.materials.size,
        textures: registry.textures.size,
      },
      koiAssembled: Boolean(flow),
      waterColor1: `#${waterMaterial.uniforms.uColor1.value.getHexString()}`,
      waterColor2: `#${waterMaterial.uniforms.uColor2.value.getHexString()}`,
      fireflySize: firefliesMaterial.uniforms.uSize.value,
    }
  }

  function dispose(reason) {
    if (disposed) return disposedSummary
    disposed = true
    if (signalDisposal) {
      signalDisposal()
      signalDisposal = null
    }

    if (shishiodoshiTween) {
      shishiodoshiTween.kill()
      shishiodoshiTween = null
    }
    flow = null

    // 兜底收集：兜住任何未显式登记的几何体 / 材质 / 贴图
    collectObjectResources(root, registry)

    if (root.parent) root.parent.remove(root)
    root.clear()

    const summary = {
      rigId,
      reason: reason || "manual",
      geometries: registry.geometries.size,
      materials: registry.materials.size,
      textures: registry.textures.size,
      dracoDisposed: true,
      lifetimeMs:
        typeof performance !== "undefined" ? Math.round(performance.now() - startedAt) : 0,
    }

    releaseRegistry(registry)

    const revokeDecoderSource = () => {
      if (!dracoLoader.workerSourceURL) return
      URL.revokeObjectURL(dracoLoader.workerSourceURL)
      dracoLoader.workerSourceURL = null
    }

    try {
      dracoLoader.dispose()
    } catch (error) {
      onLog("draco-dispose-error", { rigId, error })
    }
    // 解码器可能尚未初始化完成：初始化完成后同样回收 Blob URL，
    // 并再次 dispose，终止初始化竞态中可能新建的 worker
    if (dracoLoader.decoderPending) {
      dracoLoader.decoderPending.then(
        () => {
          revokeDecoderSource()
          try {
            dracoLoader.dispose()
          } catch (error) {
            /* ignore */
          }
        },
        () => {
          revokeDecoderSource()
        }
      )
    } else {
      revokeDecoderSource()
    }

    disposedSummary = summary
    onLog("rig-disposed", summary)
    return summary
  }

  return {
    id: rigId,
    root,
    ready,
    update,
    setWaterColor1,
    setWaterColor2,
    setFireflySize,
    setPixelRatio,
    getStats,
    dispose,
    isDisposed: () => disposed,
  }
}
