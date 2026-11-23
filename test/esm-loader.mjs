/**
 * Node ESM loader for the offline test build.
 *
 * The library sources use extensionless relative imports (bundler style) and the
 * @ain1084/audio-frame-buffer dependency ships ESM without a "type": "module"
 * package.json field. This loader resolves both cases so the compiled output runs
 * under plain `node` without a bundler or real audio device.
 */
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * @param {string} specifier
 * @param {object} context
 * @param {Function} nextResolve
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@ain1084/audio-frame-buffer') {
    const entry = new URL(
      './node_modules/@ain1084/audio-frame-buffer/dist/index.js',
      pathToFileURL(`${process.cwd()}/`).href,
    )
    return { url: entry.href, format: 'module', shortCircuit: true }
  }

  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !specifier.endsWith('.js')) {
    const candidate = new URL(`${specifier}.js`, context.parentURL)
    if (existsSync(fileURLToPath(candidate))) {
      return { url: candidate.href, format: 'module', shortCircuit: true }
    }
  }

  return nextResolve(specifier, context)
}

/**
 * Force ESM interpretation for the dependency (its package.json lacks type: module).
 * @param {string} url
 * @param {object} context
 * @param {Function} nextLoad
 */
export async function load(url, context, nextLoad) {
  if (url.includes('@ain1084/audio-frame-buffer')) {
    return nextLoad(url, { ...context, format: 'module' })
  }
  return nextLoad(url, context)
}
