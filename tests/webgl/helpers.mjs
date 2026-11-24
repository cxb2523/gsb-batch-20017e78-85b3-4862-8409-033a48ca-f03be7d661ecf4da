/**
 * Test harness for the WebGL A/B flip acceptance suite.
 *
 * Drives the real zustand stores exactly the way the UI does: files are added
 * through mediaStore.addFile (producing blob URLs the app fully controls) and
 * clips through timelineStore.addClip. No component internals are mocked.
 *
 * The stores are exposed on window by src/test/testBridge.ts (dev builds only).
 */

/**
 * Load a fixture file from the dev server into a browser File and register it
 * in the media store. Returns the stored MediaFile. Retries the final lookup
 * because addFile replaces a pending entry in a separate state update.
 */
export async function addFixtureMedia(page, path, name) {
  return page.evaluate(
    async ({ path, name }) => {
      const res = await fetch(path)
      const blob = await res.blob()
      const file = new File([blob], name, { type: blob.type || 'image/png' })
      const media = await window.__dualviewMedia.getState().addFile(file)
      // The processed entry keeps the pending id; confirm it is actually in
      // the store before returning (handles the async replacement update).
      let stored = null
      for (let i = 0; i < 20 && !stored; i++) {
        stored = window.__dualviewMedia.getState().files.find(f => f.id === media.id)
        if (!stored) await new Promise(r => setTimeout(r, 50))
      }
      if (!stored) throw new Error('media entry never appeared in store: ' + name)
      return stored
    },
    { path, name },
  )
}

/**
 * Register a fixture as media, then point its stored URL at a route-controlled
 * address the test can hold open with Playwright (`page.route`). While the
 * route is held, the <img>/<video> element cannot finish loading, which gives
 * the test a deterministic "new source not ready" interval.
 */
export async function addGatedImageMedia(page, path, name, gatedUrl) {
  const media = await addFixtureMedia(page, path, name)
  await page.evaluate(
    ({ id, url }) => {
      window.__dualviewMedia.setState(state => ({
        files: state.files.map(f => (f.id === id ? { ...f, url } : f)),
      }))
    },
    { id: media.id, url: gatedUrl },
  )
  return { mediaId: media.id, gatedUrl }
}

export async function addClipOnTrack(page, mediaId, trackId) {
  await page.evaluate(
    ({ mediaId, trackId }) => {
      window.__dualviewTimeline.getState().addClip(trackId, mediaId, 0, 10)
    },
    { mediaId, trackId },
  )
}

export async function removeTrackClips(page, trackId) {
  await page.evaluate(trackId => {
    const track = window.__dualviewTimeline
      .getState()
      .tracks.find(t => t.id === trackId)
    for (const clip of [...(track?.clips ?? [])]) {
      window.__dualviewTimeline.getState().removeClip(clip.id)
    }
  }, trackId)
}

/** Switch the preview to the WebGL comparison view (empty state is fine). */
export async function mountWebGLView(page) {
  await page.goto('/')
  await page.waitForFunction(() => Boolean(window.__dualviewProject))
  await page.evaluate(() => {
    window.__dualviewProject.getState().setComparisonMode('webgl-compare')
  })
  // The WebGL canvas only mounts once both media slots have content, so the
  // individual tests wait for it after registering media + clips.
}

/** The visible WebGL comparison canvas (waits until it has mounted). */
export function comparisonCanvas(page) {
  return page.locator('canvas:not(.hidden)').first()
}

export async function waitForComparisonCanvas(page, timeout = 20000) {
  const canvas = comparisonCanvas(page)
  await canvas.waitFor({ state: 'visible', timeout })
  return canvas
}

export async function setWebGLMode(page, mode) {
  await page.evaluate(mode => {
    window.__dualviewProject.getState().setWebGLComparisonMode(mode)
  }, mode)
}

export async function setFlip(page, flipped) {
  await page.evaluate(flipped => {
    const store = window.__dualviewProject.getState()
    if (store.webglComparisonSettings.flipAB !== flipped) {
      store.toggleWebGLFlipAB()
    }
  }, flipped)
}

export async function setRoi(page, roi) {
  await page.evaluate(roi => {
    window.__dualviewProject.getState().setROI(roi)
  }, roi)
}

export async function clearRoi(page) {
  await page.evaluate(() => {
    window.__dualviewProject.getState().setROI(null)
  })
}

export async function enableMetricsOverlay(page) {
  await page.evaluate(() => {
    const s = window.__dualviewProject.getState()
    if (!s.webglComparisonSettings.showMetricsOverlay) s.toggleWebGLMetricsOverlay()
  })
}

export async function enableCursorInspector(page) {
  await page.evaluate(() => {
    const s = window.__dualviewProject.getState()
    if (!s.webglComparisonSettings.showCursorInspector) s.toggleWebGLCursorInspector()
  })
}

export function getMetrics(page) {
  return page.evaluate(
    () => window.__dualviewProject.getState().webglAnalysisMetrics,
  )
}

/**
 * Wait until the metrics store has a value computed for the *current* source
 * pair. Metric computation is throttled (~500ms) and gated on readiness, so a
 * fresh read right after a flip/switch can otherwise still be null or stale.
 */
export async function waitForMetrics(page, { minTimestamp = 0, timeout = 10000 } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const m = await getMetrics(page)
    if (m && m.timestamp >= minTimestamp) return m
    await page.waitForTimeout(200)
  }
  return getMetrics(page)
}

/** Wait until the "loading new sources" badge is absent. */
export async function waitForSourcesReady(page, timeout = 15000) {
  await page.waitForFunction(
    () =>
      ![...document.querySelectorAll('div')].some(
        d => d.textContent && d.textContent.includes('Loading new sources'),
      ),
    { timeout },
  )
}

/** Wait until the "loading new sources" badge is visible. */
export async function waitForSourcesLoading(page, timeout = 5000) {
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('div')].some(
        d => d.textContent && d.textContent.includes('Loading new sources'),
      ),
    { timeout },
  )
}

/** Wait until the metrics overlay reports its sources are not ready. */
export async function waitForMetricsUnavailable(page, timeout = 8000) {
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('div')].some(
        d => d.textContent && d.textContent.includes('Sources not ready'),
      ),
    { timeout },
  )
}

/**
 * Read the pixel the cursor inspector currently shows for each logical slot.
 * Moves the mouse over the canvas center and polls until both values arrive.
 */
export async function readCursorPixels(page, canvas) {
  const box = await canvas.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)

  // Plain evaluate-based polling (more debuggable than waitForFunction and
  // independent of its isolated-evaluation semantics).
  const deadline = Date.now() + 15000
  let pixels = { a: null, b: null }
  while (Date.now() < deadline) {
    pixels = await page.evaluate(() => {
      const read = label => {
        const labelEl = [...document.querySelectorAll('div')].find(
          d => d.textContent.trim() === label,
        )
        const valueEl = labelEl?.nextElementSibling
        if (!valueEl) return null
        // The value cell holds three numeric <span>s (R,G,B) plus a swatch.
        // Read the spans directly: their concatenated textContent has no
        // whitespace, so a single \d+ regex would merge them into one number.
        const nums = [...valueEl.querySelectorAll('span')]
          .slice(0, 3)
          .map(s => Number(s.textContent))
        return nums.length === 3 && nums.every(n => Number.isFinite(n))
          ? { r: nums[0], g: nums[1], b: nums[2] }
          : null
      }
      return { a: read('Source A:'), b: read('Source B:') }
    })
    if (pixels.a && pixels.b) return pixels
    await page.waitForTimeout(200)
  }
  return pixels
}

/** Read an arbitrary normalized position on the WebGL canvas. */
export async function readCanvasAt(page, canvas, nx, ny) {
  const handle = await canvas.elementHandle()
  return page.evaluate(
    ({ c, nx, ny }) => {
      const gl = c.getContext('webgl') || c.getContext('webgl2')
      const px = new Uint8Array(4)
      gl.readPixels(
        Math.floor(nx * c.width),
        Math.floor(ny * c.height),
        1,
        1,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        px,
      )
      return { r: px[0], g: px[1], b: px[2] }
    },
    { c: handle, nx, ny },
  )
}

/** Read several normalized canvas points in a single browser round-trip. */
export async function readCanvasPoints(page, canvas, points) {
  const handle = await canvas.elementHandle()
  return page.evaluate(
    ({ c, points }) => {
      const gl = c.getContext('webgl') || c.getContext('webgl2')
      const px = new Uint8Array(4)
      return points.map(([nx, ny]) => {
        gl.readPixels(
          Math.floor(nx * c.width),
          Math.floor(ny * c.height),
          1,
          1,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          px,
        )
        return { r: px[0], g: px[1], b: px[2] }
      })
    },
    { c: handle, points },
  )
}

// Interior probe points offset from the checkerboard tile grids (x every
// 0.05, y every 1/15) so each reads one pure-color tile rather than a blend.
const PROBE_POINTS = [
  [0.23, 0.17], [0.31, 0.29], [0.43, 0.41], [0.47, 0.53],
  [0.53, 0.61], [0.67, 0.73], [0.73, 0.37], [0.37, 0.83],
  [0.29, 0.53], [0.59, 0.17],
]

const closeToColor = (actual, expected, tol = 25) =>
  Math.abs(actual.r - expected.r) <= tol &&
  Math.abs(actual.g - expected.g) <= tol &&
  Math.abs(actual.b - expected.b) <= tol

/**
 * Find a canvas point whose rendered color matches `target`. Useful because
 * checkerboard tile parity depends on the physical canvas resolution.
 * Returns the normalized point and its sampled color.
 */
export async function findPointWithColor(page, canvas, target, tol = 25) {
  for (const [nx, ny] of PROBE_POINTS) {
    const color = await readCanvasAt(page, canvas, nx, ny)
    if (closeToColor(color, target, tol)) {
      return { point: [nx, ny], color }
    }
  }
  return null
}
