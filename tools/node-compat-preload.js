/**
 * 预加载补丁：让 postcss 8.2 的 `postcss/package.json` 子路径在新 Node 上可解析。
 * 通过 `node -r tools/node-compat-preload.js` 使用。
 */
const path = require("path")
const Module = require("module")

const originalResolveFilename = Module._resolveFilename

Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === "postcss/package.json") {
    try {
      // require.resolve("postcss") -> <pkg>/lib/postcss.js，需再上溯一层
      const entry = require.resolve("postcss")
      const pkgRoot = path.resolve(path.dirname(entry), "..")
      return path.join(pkgRoot, "package.json")
    } catch (error) {
      /* fall through to default resolution */
    }
  }
  return originalResolveFilename.call(this, request, parent, isMain, options)
}
