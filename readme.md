# Three.js Japanese Garden


![threejs-japanese-garden](https://user-images.githubusercontent.com/56504519/115539883-771da800-a2d8-11eb-8440-339098db52aa.jpg)


https://shunyakoide.github.io/three-js-japanese-garden/

## 开发与构建

```bash
npm ci
npm run dev      # 本地开发服务器
npm run build    # 产出 dist/
```

依赖中的 webpack 5.24 / postcss 8.2 来自 2021 年，`npm run build` 通过 `tools/build.js`
包装了一层兼容处理（补 `--openssl-legacy-provider`、修正 `postcss/package.json` 的解析），
因此 Node 16（CI 版本）与新一些的 Node 都能构建。若想绕过包装器直接调用 webpack，
在 Node 16 上可以正常工作，在新 Node 上则会因 OpenSSL 3 失败。

## 加载与场景生命周期

场景装配与加载遮罩拆成了两个模块：

- `src/scene/createSceneRig.js` —— **场景装配入口**。每次调用创建一个可释放的句柄，
  负责地面、水面、萤火虫、锦鲤与庭院模型，并返回：
  `{ id, root, ready, update, setWaterColor1/2, setFireflySize, setPixelRatio, getStats, dispose }`。
  - `ready` 是一个 Promise，**成功或失败都会结算**（`{ status: "ready" | "failed", ok, failures, blocked }`），
    因此遮罩不会因为某个模型加载失败而永久停留。
  - 每个句柄独占自己的 `LoadingManager` / `GLTFLoader` / `DRACOLoader`；
    `dispose()` 会释放登记在册的几何体、材质、贴图，终止 Draco worker 并回收其 Blob URL，
    并让仍在等待的旧请求以 `StaleResultError` 结束。
  - 迟到的结果既不会写入新场景，也不会被悄悄丢弃：若它已经进入句柄，由 `dispose()` 回收；
    若它到达时句柄已释放，会就地释放。
- `src/ui/loadingOverlay.js` —— **遮罩状态机**：`loading → ready（淡出并 display:none）`
  或 `loading → error（保持可见 + 失败详情 + 重试按钮）`。

`src/script.js` 里的 `rebuild()` 把两者串成一条可重入链路：

1. 先 `dispose` 旧句柄（几何体 / 材质 / 贴图 / Draco 解码器）；
2. 再创建新句柄；
3. 只有“最新一次重建”的结算结果能改写遮罩与场景（`epoch` 守卫）。

渲染循环只更新 `activeRig`，释放后的句柄所有方法都是空操作。

### 调试项

`waterColor1` / `waterColor2` / `fireflySize` / `clearColor` 保存在 `script.js` 的
`debugObject` 中，由 GUI 修改。重建时新句柄会读取当前值，因此颜色、萤火虫尺寸与清屏色在
重建后依旧作用于新场景。

## 本地验证

构建后执行：

```bash
npm run build
npm run verify
```

`tools/verify-rebuild.js` 会起一个临时静态服务器，用无头 Chrome 通过 CDP 驱动页面里的
`window.gardenDebug`，断言 22 项行为（首次装配、连续重建、失败提示、迟到请求、调试项继承、
释放后无错误）。可用参数：

```bash
node tools/verify-rebuild.js --chrome "C:/Program Files/Google/Chrome/Application/chrome.exe"
node tools/verify-rebuild.js --dist dist --verbose
```

### 手动在浏览器里验证

打开页面后，控制台里有 `window.gardenDebug`：

| 操作 | 命令 | 期望现象 |
| --- | --- | --- |
| 反复重建 | `for (let i = 0; i < 5; i++) await gardenDebug.rebuild()` | 遮罩短暂出现后淡出；`gardenDebug.state().sceneRigs` 始终只有 1 项；`gardenDebug.rendererInfo()` 的 `geometries` / `textures` 不持续增长 |
| 模拟庭院模型失败 | `await gardenDebug.rebuild({ failResources: ['garden'] })` | 遮罩保持黑色、`data-state="error"`、显示“庭院模型（japanese-garden.glb）”失败原因与「重试」按钮 |
| 模拟锦鲤模型失败 | `await gardenDebug.rebuild({ failResources: ['koi'] })` | 同上，提示指名锦鲤模型 |
| 模拟贴图失败 | `await gardenDebug.rebuild({ failResources: ['matcap'] })` | 提示贴图失败，并说明锦鲤模型因依赖它被跳过 |
| 恢复 | `await gardenDebug.rebuild()` | 遮罩淡出、场景恢复 |
| 迟到的旧请求 | `const a = gardenDebug.rebuild({ applyDelayMs: 1500 }); await new Promise(r => setTimeout(r, 100)); await gardenDebug.rebuild(); await a` | 返回 `{ ignored: true }`；场景里仍只有最新句柄的根节点 |
| 查看状态 | `gardenDebug.state()` | 含 `activeRigId`、`active.resources`、`overlay`、`history`（含每次 `dispose` 释放了多少几何体 / 材质 / 贴图）、`sceneRigs` |
| 调试项继承 | `gardenDebug.setDebug({ waterColor1: '#112233', fireflySize: 321 }); await gardenDebug.rebuild(); gardenDebug.state().active` | 新句柄的 `waterColor1` / `fireflySize` 为设定值 |

页面上的 GUI（默认折叠）里也有 `Rebuild` 分组：「重建场景」与「重建（模拟庭院模型失败）」两个按钮。

也可以人为制造失败：浏览器 DevTools → Network 面板把 `japanese-garden.glb` 设为 block，
然后刷新页面——遮罩应当显示失败提示而不是一直转圈。
