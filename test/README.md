# 本地验证

用本地生成的视频样例（`videos/v1~v4.mp4`，ffmpeg 合成的纯色+单音短片）验证播放器的
跳转、自动切换与关闭重开。

## 文件

- `player.test.html` — 验证页：加载 `vue` 与 `lib/canvas-player.umd.js`，用 4 个片段
  （时长 2/4/3/2 秒，累计 11 秒，含跨源与同源复用）调用 `$canvasVideoPlayer(list)`。
- `run-e2e.js` — 端到端断言脚本（puppeteer-core + 无头浏览器），共 35 项断言。
- `videos/` — 本地视频样例。

## 运行

```bash
npm install                 # 安装构建依赖
npm run build               # 生成 lib/（Node 17+ 需要 NODE_OPTIONS=--openssl-legacy-provider）

# 准备浏览器（二选一）：
#   a) npx @puppeteer/browsers install chrome-headless-shell@stable
#   b) 使用本机 Chrome / Chrome for Testing，设置 CHROME_EXE 指向可执行文件
npm i -D puppeteer-core     # 或装在任意目录，用 PUPPETEER_PATH 指定

CHROME_EXE=/path/to/chrome-headless-shell.exe node test/run-e2e.js
```

环境变量：`CHROME_EXE`（浏览器路径）、`PUPPETEER_PATH`（puppeteer-core 位置）、
`PORT`（静态服务端口，默认 8917）。

注意：宿主机受企业策略管理的 Chrome 可能拒绝远程调试（CDP），此时请使用
chrome-headless-shell 或 Chrome for Testing。
