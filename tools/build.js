#!/usr/bin/env node
/**
 * 构建包装器。
 *
 * 本项目锁定的是 2021 年的 webpack 5.24 / postcss 8.2，它们与新版 Node（OpenSSL 3）不兼容：
 *   1. webpack 的默认 md4 哈希在 OpenSSL 3 下不可用；
 *   2. css-loader 会 `require("postcss/package.json")`，而 postcss 8.2 的 `exports`
 *      没有导出 `./package.json`（Node 16 的解析器不检查，新 Node 会报错）。
 *
 * 这里不改 node_modules、也不要求降级 Node：
 *   - Node >= 17 时补上 `--openssl-legacy-provider`（Node 16 没有该开关）；
 *   - 通过 `-r tools/node-compat-preload.js` 给子进程打上 postcss 解析补丁。
 *
 * 用法：node tools/build.js [--config <webpack config>]
 */
const path = require("path")
const { spawnSync } = require("child_process")

const REPO_ROOT = path.resolve(__dirname, "..")
const PRELOAD = path.join(__dirname, "node-compat-preload.js")
const WEBPACK_CLI = require.resolve("webpack-cli/bin/cli.js", { paths: [REPO_ROOT] })

const extraArgs = process.argv.slice(2)
const cliArgs = extraArgs.length ? extraArgs : ["--config", "./bundler/webpack.prod.js"]

const major = Number(process.versions.node.split(".")[0])
const nodeArgs = ["-r", PRELOAD]
// Node 16 不认识 --openssl-legacy-provider，只在需要时加
if (major >= 17) nodeArgs.push("--openssl-legacy-provider")

const result = spawnSync(process.execPath, nodeArgs.concat([WEBPACK_CLI], cliArgs), {
  stdio: "inherit",
  cwd: REPO_ROOT,
})
process.exit(result.status === null ? 1 : result.status)
