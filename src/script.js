import "./style.css"
import * as dat from "dat.gui"
import * as THREE from "three"
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js"
import { createSceneRig, RESOURCE_KEYS, RESOURCE_LABELS } from "./scene/createSceneRig.js"
import { createLoadingOverlay } from "./ui/loadingOverlay.js"

/**
 * Base
 */
const canvas = document.querySelector("canvas.webgl")

// Debug settings —— 与场景句柄解耦：
// 重建时新句柄会读取这里的当前值，因此调试项在重建后仍然生效
const debugObject = {
  waterColor1: "#96c4e8",
  waterColor2: "#e1c1eb",
  fireflySize: 200,
  clearColor: "#d49c9c",
}

// Scene
const scene = new THREE.Scene()
scene.fog = new THREE.Fog(0xffffff, 0, 17)

/**
 * Sizes
 */
const sizes = {
  width: window.innerWidth,
  height: window.innerHeight,
}

/**
 * Camera
 */
const camera = new THREE.PerspectiveCamera(35, sizes.width / sizes.height, 0.1, 100)
camera.position.x = 4.1
camera.position.y = 2.8
camera.position.z = 4.1
scene.add(camera)

// Controls
const controls = new OrbitControls(camera, canvas)
controls.enableDamping = true

/**
 * Renderer
 */
const renderer = new THREE.WebGLRenderer({
  canvas: canvas,
  antialias: true,
})
renderer.setSize(sizes.width, sizes.height)
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.outputEncoding = THREE.sRGBEncoding
renderer.setClearColor(debugObject.clearColor)

/**
 * 场景生命周期：任意时刻只有一个活动句柄
 */
let activeRig = null
let rigEpoch = 0
// 仅保留少量最近的历史，便于在控制台里核对释放明细
const rigHistory = []

const overlay = createLoadingOverlay({
  root: document.querySelector(".loading-overlay"),
  message: document.querySelector(".loading-message"),
  detail: document.querySelector(".loading-detail"),
  retry: document.querySelector(".loading-retry"),
  onRetry: () => rebuild({ reason: "retry" }),
})

function disposeActiveRig(reason) {
  if (!activeRig) return null
  const summary = activeRig.dispose(reason)
  activeRig = null
  return summary
}

function describeFailures(summary) {
  const lines = []
  if (summary && summary.failures.length) {
    summary.failures.forEach((failure) => {
      lines.push(`• ${failure.label}：${failure.message}`)
    })
  }
  if (summary && summary.blocked && summary.blocked.length) {
    summary.blocked.forEach((entry) => {
      const blockedLabels = entry.blockedBy
        .map((key) => RESOURCE_LABELS[key] || key)
        .join("、")
      lines.push(`• ${RESOURCE_LABELS[entry.key] || entry.key}：因 ${blockedLabels} 失败已跳过`)
    })
  }
  if (!lines.length) lines.push("资源加载失败（未提供具体资源信息）")
  return lines
}

async function rebuild(options) {
  const opts = options || {}
  const epoch = ++rigEpoch
  const failResources = opts.failResources || []

  // 1) 先释放旧场景（几何体 / 材质 / 贴图 / Draco 解码器），保证渲染循环里只剩新句柄
  const disposed = disposeActiveRig("rebuild")
  if (disposed) {
    rigHistory.push({ type: "dispose", ...disposed })
    trimHistory()
  }

  // 2) 新句柄：所有 loader 都是新建的，旧请求即使迟到也只会被它自己的
  //    disposed 标记拦下，不会写入新场景
  let rig
  try {
    rig = createSceneRig({
      scene,
      settings: {
        waterColor1: debugObject.waterColor1,
        waterColor2: debugObject.waterColor2,
        fireflySize: debugObject.fireflySize,
      },
      failResources,
      applyDelayMs: opts.applyDelayMs || 0,
      pixelRatio: Math.min(window.devicePixelRatio, 2),
      onLog: (event, payload) => {
        if (window.__GARDEN_DEBUG__) console.info(`[garden] ${event}`, payload)
      },
    })
  } catch (error) {
    overlay.showError({
      message: "场景初始化失败。",
      details: [String((error && error.message) || error)],
    })
    return { epoch, ok: false, status: "failed", failures: [], blocked: [] }
  }
  activeRig = rig

  const stillCurrent = () => epoch === rigEpoch && activeRig === rig

  overlay.showLoading({
    message: failResources.length ? "正在加载锦鲤池（含模拟失败）…" : "正在加载锦鲤池…",
  })

  const summary = await rig.ready

  // 3) 迟到的结算结果不允许改写遮罩 / 场景状态
  if (!stillCurrent()) {
    const alreadyDisposed = rig.isDisposed()
    const lateSummary = rig.dispose("superseded")
    if (!alreadyDisposed) {
      rigHistory.push({ type: "dispose", ...lateSummary })
      trimHistory()
    }
    return {
      ignored: true,
      epoch,
      reason: "一次更新的重建已经开始，本次结果被丢弃",
    }
  }

  if (summary.ok) {
    overlay.showReady()
  } else {
    overlay.showError({
      message: "锦鲤池加载失败，请检查资源后重试。",
      details: describeFailures(summary),
    })
  }

  const report = {
    epoch,
    rigId: rig.id,
    status: summary.status,
    ok: summary.ok,
    failures: summary.failures,
    blocked: summary.blocked,
    resources: summary.ok ? rig.getStats().resources : null,
  }
  rigHistory.push({ type: "settle", ...report })
  trimHistory()

  if (window.__GARDEN_DEBUG__) console.info("[garden] rebuild settled", report)
  return report
}

function trimHistory() {
  const limit = 40
  if (rigHistory.length > limit) rigHistory.splice(0, rigHistory.length - limit)
}

/**
 * Debug GUI
 */
const guiControllers = {}
const gui = new dat.GUI({
  width: 400,
  closed: true,
})

guiControllers.waterColor1 = gui
  .addColor(debugObject, "waterColor1")
  .name("waterColor1")
  .onChange(() => {
    if (activeRig) activeRig.setWaterColor1(debugObject.waterColor1)
  })
guiControllers.waterColor2 = gui
  .addColor(debugObject, "waterColor2")
  .name("waterColor2")
  .onChange(() => {
    if (activeRig) activeRig.setWaterColor2(debugObject.waterColor2)
  })
guiControllers.fireflySize = gui
  .add(debugObject, "fireflySize")
  .min(0)
  .max(500)
  .step(1)
  .name("firefliesSize")
  .onChange(() => {
    if (activeRig) activeRig.setFireflySize(debugObject.fireflySize)
  })
guiControllers.clearColor = gui.addColor(debugObject, "clearColor").onChange(() => {
  renderer.setClearColor(debugObject.clearColor)
})

const rebuildFolder = gui.addFolder("Rebuild")
rebuildFolder.add({ rebuild: () => rebuild({ reason: "gui" }) }, "rebuild").name("重建场景")
rebuildFolder
  .add(
    {
      rebuildBroken: () => rebuild({ reason: "gui-simulated", failResources: ["garden"] }),
    },
    "rebuildBroken"
  )
  .name("重建（模拟庭院模型失败）")

/**
 * 控制台验证入口
 */
function applyDebugValue(key) {
  if (key === "waterColor1") {
    if (activeRig) activeRig.setWaterColor1(debugObject.waterColor1)
  } else if (key === "waterColor2") {
    if (activeRig) activeRig.setWaterColor2(debugObject.waterColor2)
  } else if (key === "fireflySize") {
    if (activeRig) activeRig.setFireflySize(debugObject.fireflySize)
  } else if (key === "clearColor") {
    renderer.setClearColor(debugObject.clearColor)
  }
  const controller = guiControllers[key]
  if (controller) controller.updateDisplay()
}

window.gardenDebug = {
  rebuild: (options) => rebuild(options),
  rebuildWithFailures: (keys) => rebuild({ failResources: keys, reason: "console" }),
  // 等价于在 GUI 里改值；重建后新句柄会从 debugObject 继承
  setDebug: (values) => {
    Object.keys(values || {}).forEach((key) => {
      if (key in debugObject) debugObject[key] = values[key]
    })
    Object.keys(values || {}).forEach(applyDebugValue)
    return {
      waterColor1: debugObject.waterColor1,
      waterColor2: debugObject.waterColor2,
      fireflySize: debugObject.fireflySize,
      clearColor: debugObject.clearColor,
    }
  },
  getDebug: () => Object.assign({}, debugObject),
  state: () => ({
    activeRigId: activeRig ? activeRig.id : null,
    active: activeRig ? activeRig.getStats() : null,
    overlay: overlay.getState(),
    history: rigHistory.slice(),
    resourceKeys: RESOURCE_KEYS.slice(),
    resourceLabels: RESOURCE_LABELS,
    clearColor: `#${renderer.getClearColor(new THREE.Color()).getHexString()}`,
    // 场景中应始终只有 1 个 rig 根节点
    sceneRigs: scene.children
      .filter((child) => child.name && child.name.indexOf("garden-rig-") === 0)
      .map((child) => ({ name: child.name, children: child.children.length })),
  }),
  // 渲染信息快照：反复重建后 geometries / textures 不应持续增长
  rendererInfo: () => ({
    geometries: renderer.info.memory.geometries,
    textures: renderer.info.memory.textures,
    programs: renderer.info.programs ? renderer.info.programs.length : null,
  }),
}

/**
 * Resize
 */
window.addEventListener("resize", () => {
  sizes.width = window.innerWidth
  sizes.height = window.innerHeight

  camera.aspect = sizes.width / sizes.height
  camera.updateProjectionMatrix()

  renderer.setSize(sizes.width, sizes.height)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))

  if (activeRig) activeRig.setPixelRatio(Math.min(window.devicePixelRatio, 2))
})

/**
 * Animate —— 只更新当前活动句柄
 */
const clock = new THREE.Clock()

const tick = () => {
  const elapsedTime = clock.getElapsedTime()

  if (activeRig && !activeRig.isDisposed()) {
    activeRig.update(elapsedTime)
  }

  controls.update()
  renderer.render(scene, camera)

  window.requestAnimationFrame(tick)
}

tick()

// 首次装配
rebuild({ reason: "initial" })
