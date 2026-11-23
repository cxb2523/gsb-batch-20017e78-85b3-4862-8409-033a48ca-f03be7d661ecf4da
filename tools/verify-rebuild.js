#!/usr/bin/env node
/**
 * 本地验证：加载遮罩状态机 + 场景重建 + 资源释放
 *
 * 这个脚本会：
 *   1. 起一个临时静态服务器托管 `dist/`
 *   2. 用无头 Chrome 打开页面，通过 CDP 驱动 `window.gardenDebug`
 *   3. 断言：首次装配、连续重建、失败提示、迟到请求、调试项继承、释放后无错误
 *
 * 用法（先 `npm run build`，或在支持旧工具链的 Node 下构建）：
 *
 *   node tools/verify-rebuild.js
 *   node tools/verify-rebuild.js --dist dist --chrome "C:/Program Files/Google/Chrome/Application/chrome.exe"
 *   CHROME_PATH="/path/to/chrome" node tools/verify-rebuild.js
 *
 * 环境变量：
 *   DIST_DIR    产物目录（默认 dist）
 *   CHROME_PATH 浏览器可执行文件（默认自动探测 Chrome / Edge）
 *   NODE_BIN    可选：指定运行时（例如便携版 Node 16）
 *
 * 退出码 0 = 全部断言通过；1 = 有断言失败。
 */
const http = require("http")
const fs = require("fs")
const path = require("path")
const os = require("os")
const { spawn } = require("child_process")

const REPO_ROOT = path.resolve(__dirname, "..")

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--dist") out.dist = argv[++i]
    else if (arg === "--chrome") out.chrome = argv[++i]
    else if (arg === "--port") out.port = Number(argv[++i])
    else if (arg === "--keep-profile") out.keepProfile = true
    else if (arg === "--verbose") out.verbose = true
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const DIST = path.resolve(REPO_ROOT, args.dist || process.env.DIST_DIR || "dist")

function findChrome() {
  if (args.chrome || process.env.CHROME_PATH) return args.chrome || process.env.CHROME_PATH
  const candidates =
    process.platform === "win32"
      ? [
          "C:/Program Files/Google/Chrome/Application/chrome.exe",
          "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
          "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
          "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
        ]
      : process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ]
      : [
          "/usr/bin/google-chrome",
          "/usr/bin/google-chrome-stable",
          "/usr/bin/chromium",
          "/usr/bin/chromium-browser",
        ]

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  throw new Error(
    "找不到 Chrome/Edge，请用 --chrome 或 CHROME_PATH 指定可执行文件路径"
  )
}

function loadWebSocket() {
  // 复用项目已有的 ws，避免额外安装依赖
  const candidates = [
    path.join(REPO_ROOT, "node_modules", "ws"),
    path.join(REPO_ROOT, "node_modules", "webpack-dev-server", "node_modules", "ws"),
    "ws",
  ]
  for (const candidate of candidates) {
    try {
      return require(candidate)
    } catch (error) {
      /* try next */
    }
  }
  throw new Error("需要 ws 模块（npm ci 会安装），或手动 npm i -D ws")
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".glb": "model/gltf-binary",
  ".wasm": "application/wasm",
  ".map": "application/json",
}

function startStaticServer(root) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split("?")[0])
      const filePath = path.join(root, urlPath === "/" ? "index.html" : urlPath)
      if (!path.resolve(filePath).startsWith(path.resolve(root))) {
        res.writeHead(403).end("forbidden")
        return
      }
      fs.readFile(filePath, (error, data) => {
        if (error) {
          res.writeHead(404).end("not found")
          return
        }
        res.writeHead(200, {
          "Content-Type":
            MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream",
          "Cache-Control": "no-store",
        })
        res.end(data)
      })
    })
    server.listen(0, "127.0.0.1", () => resolve(server))
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = ""
        res.on("data", (chunk) => (body += chunk))
        res.on("end", () => {
          try {
            resolve(JSON.parse(body))
          } catch (error) {
            reject(error)
          }
        })
      })
      .on("error", reject)
  })
}

async function waitForDevtools(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      return await httpGetJson(`http://127.0.0.1:${port}/json/version`)
    } catch (error) {
      if (Date.now() > deadline) throw new Error("等待 DevTools 端口超时")
      await sleep(200)
    }
  }
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.nextId = 0
    this.pending = new Map()
    ws.on("message", (raw) => {
      const message = JSON.parse(raw)
      if (!message.id) return
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
      else entry.resolve(message.result)
    })
  }

  send(method, params) {
    const id = ++this.nextId
    this.ws.send(JSON.stringify({ id, method, params: params || {} }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }

  async evaluate(expression) {
    let lastError = null
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const result = await this.send("Runtime.evaluate", {
          expression,
          awaitPromise: true,
          returnByValue: true,
        })
        if (result.exceptionDetails) {
          const text = JSON.stringify(
            result.exceptionDetails.exception || result.exceptionDetails
          )
          if (/Execution context was destroyed|Cannot find context|navigated/i.test(text)) {
            lastError = new Error(text)
            await sleep(300)
            continue
          }
          throw new Error("页面异常: " + text)
        }
        return result.result.value
      } catch (error) {
        lastError = error
        if (/Execution context was destroyed|Cannot find context|navigated/i.test(error.message)) {
          await sleep(300)
          continue
        }
        throw error
      }
    }
    throw lastError || new Error("evaluate 失败")
  }
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok) })
  const suffix = detail === undefined ? "" : `  -> ${detail}`
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${suffix}`)
}

async function main() {
  if (!fs.existsSync(path.join(DIST, "index.html"))) {
    throw new Error(`找不到 ${path.join(DIST, "index.html")}，请先运行构建（npm run build）`)
  }

  const WebSocket = loadWebSocket()
  const chromePath = findChrome()
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-verify-"))

  const server = await startStaticServer(DIST)
  const httpPort = server.address().port
  const pageUrl = `http://127.0.0.1:${httpPort}/index.html`
  const debugPort = args.port || 9333 + Math.floor(Math.random() * 400)

  console.log(`浏览器: ${chromePath}`)
  console.log(`页面:   ${pageUrl}`)
  console.log(`产物:   ${DIST}\n`)

  // 注意：新版 Chrome 的 --headless=new 在该环境不允许远程调试，
  // 这里使用仍可用的 --headless；若你的 Chrome 已移除该模式，可换成 --headless=new --remote-allow-origins=*
  const browser = spawn(
    chromePath,
    [
      "--headless",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--enable-unsafe-swiftshader",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--window-size=1280,720",
      pageUrl,
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  )

  let browserStderr = ""
  browser.stderr.on("data", (chunk) => (browserStderr += chunk))
  if (args.verbose) browser.stderr.pipe(process.stderr)

  try {
    await waitForDevtools(debugPort, 30000)

    let target = null
    for (let attempt = 0; attempt < 80 && !target; attempt++) {
      const list = await httpGetJson(`http://127.0.0.1:${debugPort}/json/list`)
      target = list.find((entry) => entry.type === "page" && entry.url.includes("index.html"))
      if (!target) await sleep(250)
    }
    if (!target) throw new Error("找不到页面目标（页面可能已崩溃）")

    const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false })
    await new Promise((resolve, reject) => {
      ws.on("open", resolve)
      ws.on("error", reject)
    })

    const cdp = new Cdp(ws)
    await cdp.send("Runtime.enable")
    await cdp.send("Page.enable")

    await cdp.evaluate(`(async () => {
      for (let i = 0; i < 300; i++) {
        if (document.readyState === 'complete' && window.gardenDebug) return true
        await new Promise(r => setTimeout(r, 100))
      }
      return false
    })()`)

    // ---------- 1. 首次装配成功 ----------
    const initial = await cdp.evaluate(`(async () => {
      for (let i = 0; i < 300; i++) {
        if (gardenDebug.state().overlay !== 'loading') break
        await new Promise(r => setTimeout(r, 100))
      }
      const s = gardenDebug.state()
      return {
        overlay: s.overlay,
        activeRigId: s.activeRigId,
        resources: s.active && s.active.resources,
        renderer: gardenDebug.rendererInfo(),
        settles: s.history.filter(h => h.type === 'settle'),
      }
    })()`)
    check("首次装配成功后遮罩进入 ready", initial.overlay === "ready", `overlay=${initial.overlay}`)
    check(
      "4 个必需资源全部成功",
      initial.settles.some((entry) => entry.status === "ready" && entry.ok === true),
      JSON.stringify(initial.settles)
    )
    check(
      "遮罩淡出结束后 display:none",
      await (async () => {
        await sleep(1600)
        return cdp.evaluate(
          `getComputedStyle(document.querySelector('.loading-overlay')).display === 'none'`
        )
      })()
    )

    // 等 renderer 真正把首屏资源上传到 GPU（renderer.info 只统计已上传的部分），
    // 否则基线会偏低，导致“重建后计数不增长”的误判。
    const baseline = await cdp.evaluate(`(async () => {
      let previous = null
      let stable = 0
      for (let i = 0; i < 100; i++) {
        const current = gardenDebug.rendererInfo()
        if (previous && current.geometries === previous.geometries && current.textures === previous.textures) {
          stable++
          if (stable >= 3) return current
        } else {
          stable = 0
        }
        previous = current
        await new Promise(r => setTimeout(r, 120))
      }
      return gardenDebug.rendererInfo()
    })()`)

    // ---------- 2. 连续重建：单一活动场景 + 资源不累积 ----------
    const before = baseline
    const rebuilt = await cdp.evaluate(`(async () => {
      const reports = []
      for (let i = 0; i < 3; i++) reports.push(await gardenDebug.rebuild({ reason: 'verify-loop' }))
      const s = gardenDebug.state()
      return {
        reports,
        activeRigId: s.activeRigId,
        overlay: s.overlay,
        disposals: s.history.filter(h => h.type === 'dispose' && h.reason === 'rebuild'),
        sceneRigs: s.sceneRigs,
      }
    })()`)
    check(
      "连续 3 次重建均成功",
      rebuilt.reports.every((report) => report && report.ok === true),
      rebuilt.reports.map((report) => report && report.status).join(",")
    )
    check(
      "每次重建都释放旧场景的几何体 / 材质 / 贴图",
      rebuilt.disposals.length >= 3 &&
        rebuilt.disposals.every((entry) => entry.geometries > 0 && entry.materials > 0),
      JSON.stringify(
        rebuilt.disposals.map((entry) => ({
          g: entry.geometries,
          m: entry.materials,
          t: entry.textures,
        }))
      )
    )
    check(
      "任意时刻只有一个活动场景根节点",
      rebuilt.sceneRigs.length === 1 &&
        rebuilt.sceneRigs[0].name === `garden-rig-${rebuilt.activeRigId}`,
      JSON.stringify(rebuilt.sceneRigs)
    )
    check("重建后遮罩仍为 ready", rebuilt.overlay === "ready", rebuilt.overlay)

    await sleep(600)
    const after = await cdp.evaluate(`gardenDebug.rendererInfo()`)
    check(
      "反复重建后 renderer 的 geometry / texture 计数不增长",
      after.geometries <= before.geometries + 1 && after.textures <= before.textures + 1,
      `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`
    )

    // ---------- 3. 模拟资源加载失败 ----------
    const failure = await cdp.evaluate(`(async () => {
      const report = await gardenDebug.rebuild({ reason: 'verify-fail', failResources: ['garden'] })
      const el = document.querySelector('.loading-overlay')
      return {
        report,
        overlay: gardenDebug.state().overlay,
        display: getComputedStyle(el).display,
        opacity: Number(getComputedStyle(el).opacity),
        message: document.querySelector('.loading-message').textContent,
        detail: document.querySelector('.loading-detail').textContent,
        retryVisible: !document.querySelector('.loading-retry').hidden,
      }
    })()`)
    check(
      "失败时遮罩保持可见（不淡出、不静默卡死）",
      failure.overlay === "error" &&
        failure.display !== "none" &&
        failure.opacity > 0.9 &&
        failure.retryVisible,
      JSON.stringify({
        overlay: failure.overlay,
        display: failure.display,
        opacity: failure.opacity,
      })
    )
    check(
      "失败提示可读，指名失败的资源",
      /庭院模型/.test(failure.detail) && /失败/.test(failure.message),
      `${failure.message} | ${failure.detail.replace(/\n/g, " ")}`
    )

    const koiFailure = await cdp.evaluate(`(async () => {
      const report = await gardenDebug.rebuild({ reason: 'verify-fail-koi', failResources: ['koi'] })
      return {
        report,
        overlay: gardenDebug.state().overlay,
        detail: document.querySelector('.loading-detail').textContent,
      }
    })()`)
    check(
      "锦鲤模型失败同样被捕获",
      koiFailure.overlay === "error" && /锦鲤模型/.test(koiFailure.detail),
      koiFailure.detail.replace(/\n/g, " ")
    )

    const textureFailure = await cdp.evaluate(`(async () => {
      const report = await gardenDebug.rebuild({ reason: 'verify-fail-matcap', failResources: ['matcap'] })
      return {
        report,
        overlay: gardenDebug.state().overlay,
        detail: document.querySelector('.loading-detail').textContent,
      }
    })()`)
    check(
      "贴图失败时遮罩照样结算（不会永久 loading）",
      textureFailure.overlay === "error" && textureFailure.report.ok === false,
      textureFailure.overlay
    )
    check(
      "贴图失败会阻断依赖它的模型并写入提示",
      textureFailure.report.blocked.some(
        (entry) => entry.key === "koi" && entry.blockedBy.indexOf("matcap") !== -1
      ),
      JSON.stringify(textureFailure.report.blocked)
    )

    const recovered = await cdp.evaluate(`(async () => {
      await gardenDebug.rebuild({ reason: 'verify-retry' })
      return gardenDebug.state().overlay
    })()`)
    check("失败后可恢复到 ready", recovered === "ready", recovered)

    // ---------- 4. 迟到的旧请求不得写入新场景 ----------
    const stale = await cdp.evaluate(`(async () => {
      const slow = gardenDebug.rebuild({ reason: 'verify-slow', applyDelayMs: 1500 })
      await new Promise(r => setTimeout(r, 120))
      const fast = gardenDebug.rebuild({ reason: 'verify-fast' })
      const [slowReport, fastReport] = await Promise.all([slow, fast])
      await new Promise(r => setTimeout(r, 600))
      const s = gardenDebug.state()
      return { slowReport, fastReport, activeRigId: s.activeRigId, overlay: s.overlay, sceneRigs: s.sceneRigs }
    })()`)
    check(
      "迟到的旧请求结果被丢弃",
      stale.slowReport && stale.slowReport.ignored === true,
      JSON.stringify(stale.slowReport)
    )
    check(
      "迟到的旧场景被释放，未写入新场景",
      stale.activeRigId === stale.fastReport.rigId &&
        stale.sceneRigs.length === 1 &&
        stale.sceneRigs[0].name === `garden-rig-${stale.activeRigId}`,
      `active=${stale.activeRigId} sceneRigs=${JSON.stringify(stale.sceneRigs)}`
    )
    check("丢弃旧结果后遮罩仍为 ready", stale.overlay === "ready", stale.overlay)

    // ---------- 5. 调试项在重建后仍作用于新场景 ----------
    const debugValues = await cdp.evaluate(`(async () => {
      gardenDebug.setDebug({
        waterColor1: '#112233',
        waterColor2: '#445566',
        fireflySize: 321,
        clearColor: '#0a0b0c',
      })
      const before = gardenDebug.state()
      await gardenDebug.rebuild({ reason: 'verify-debug-persist' })
      const after = gardenDebug.state()
      return { before, after }
    })()`)
    check(
      "水面颜色 / 萤火虫尺寸在重建后作用于新场景",
      debugValues.after.active.waterColor1 === "#112233" &&
        debugValues.after.active.waterColor2 === "#445566" &&
        debugValues.after.active.fireflySize === 321 &&
        debugValues.after.activeRigId !== debugValues.before.activeRigId,
      `before=${JSON.stringify(debugValues.before.active)} after=${JSON.stringify(
        debugValues.after.active
      )}`
    )
    check(
      "清屏色在重建后仍生效",
      debugValues.after.clearColor === "#0a0b0c",
      debugValues.after.clearColor
    )
    // 复原，避免影响后续人工检查
    await cdp.evaluate(
      `gardenDebug.setDebug({ waterColor1: '#96c4e8', waterColor2: '#e1c1eb', fireflySize: 200, clearColor: '#d49c9c' })`
    )

    // ---------- 6. 首次加载即失败（原始 bug 场景） ----------
    await cdp.send("Network.enable")
    await cdp.send("Network.setBlockedURLs", { urls: ["*japanese-garden.glb*"] })
    await cdp.send("Page.reload", { ignoreCache: true })
    await sleep(1200)
    const coldFailure = await cdp.evaluate(`(async () => {
      for (let i = 0; i < 300; i++) {
        if (window.gardenDebug && gardenDebug.state().overlay !== 'loading') break
        await new Promise(r => setTimeout(r, 100))
      }
      const el = document.querySelector('.loading-overlay')
      const s = gardenDebug.state()
      return {
        overlay: s.overlay,
        display: getComputedStyle(el).display,
        message: document.querySelector('.loading-message').textContent,
        detail: document.querySelector('.loading-detail').textContent,
        retryVisible: !document.querySelector('.loading-retry').hidden,
        sceneRigs: s.sceneRigs,
      }
    })()`)
    check(
      "首屏加载失败时展示错误而非永久黑屏",
      coldFailure.overlay === "error" &&
        coldFailure.display !== "none" &&
        /失败/.test(coldFailure.detail) &&
        coldFailure.retryVisible,
      JSON.stringify(coldFailure)
    )

    await cdp.send("Network.setBlockedURLs", { urls: [] })
    await cdp.evaluate(`document.querySelector('.loading-retry').click()`)
    const afterClick = await cdp.evaluate(`(async () => {
      for (let i = 0; i < 300; i++) {
        if (gardenDebug.state().overlay === 'ready') break
        await new Promise(r => setTimeout(r, 100))
      }
      const s = gardenDebug.state()
      return { overlay: s.overlay, sceneRigs: s.sceneRigs }
    })()`)
    check(
      "点击重试按钮可恢复，且只剩一个场景",
      afterClick.overlay === "ready" && afterClick.sceneRigs.length === 1,
      JSON.stringify(afterClick)
    )

    // ---------- 7. 释放后不再访问已销毁对象 ----------
    const noErrors = await cdp.evaluate(`(async () => {
      await gardenDebug.rebuild({ reason: 'verify-final' })
      const errors = []
      const original = console.error
      console.error = (...a) => { errors.push(a.join(' ')); original(...a) }
      await new Promise(r => setTimeout(r, 1000))
      console.error = original
      return errors
    })()`)
    check(
      "重建后渲染循环无控制台错误",
      Array.isArray(noErrors) && noErrors.length === 0,
      JSON.stringify(noErrors && noErrors.slice(0, 3))
    )

    ws.close()
  } finally {
    // 只终止本脚本自己启动的浏览器进程
    try {
      browser.kill()
    } catch (error) {
      /* ignore */
    }
    server.close()
    if (!args.keepProfile) {
      try {
        fs.rmSync(profileDir, { recursive: true, force: true })
      } catch (error) {
        /* ignore */
      }
    } else {
      console.log(`保留浏览器 profile: ${profileDir}`)
    }
  }

  const failed = results.filter((entry) => !entry.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length) {
    console.log("失败项：")
    failed.forEach((entry) => console.log(`  - ${entry.name}`))
    if (browserStderr && !args.verbose) console.log(`\n浏览器 stderr 末尾:\n${browserStderr.slice(-1200)}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(`\n验证失败: ${error && error.message}`)
  process.exitCode = 1
})
