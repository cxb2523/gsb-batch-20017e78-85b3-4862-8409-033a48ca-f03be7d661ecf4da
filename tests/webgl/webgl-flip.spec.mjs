import { test, expect } from '@playwright/test'
import {
  mountWebGLView,
  addFixtureMedia,
  addGatedImageMedia,
  addClipOnTrack,
  removeTrackClips,
  setWebGLMode,
  setFlip,
  setRoi,
  clearRoi,
  enableMetricsOverlay,
  enableCursorInspector,
  getMetrics,
  waitForMetrics,
  waitForSourcesReady,
  waitForSourcesLoading,
  waitForMetricsUnavailable,
  waitForComparisonCanvas,
  readCursorPixels,
  readCanvasAt,
  readCanvasPoints,
  findPointWithColor,
  comparisonCanvas,
} from './helpers.mjs'

const RED = { r: 220, g: 30, b: 30 }
const BLUE = { r: 30, g: 40, b: 220 }
const GREEN = { r: 30, g: 200, b: 40 }

const closeTo = (actual, expected, tol = 12) =>
  Math.abs(actual.r - expected.r) <= tol &&
  Math.abs(actual.g - expected.g) <= tol &&
  Math.abs(actual.b - expected.b) <= tol

// Dense interior scan used to discover points that land inside pure-color
// tiles (the checkerboard shader blends tile boundaries, so fixed points can
// straddle two tiles).
const SCAN_POINTS = []
for (let gy = 1; gy < 10; gy++) {
  for (let gx = 1; gx < 20; gx++) {
    SCAN_POINTS.push([gx / 21, gy / 11])
  }
}

/** Collect normalized points whose rendered color matches each solid source. */
async function collectPurePoints(page, canvas) {
  const colors = await readCanvasPoints(page, canvas, SCAN_POINTS)
  const redPoints = []
  const bluePoints = []
  colors.forEach((c, i) => {
    if (closeTo(c, RED)) redPoints.push(SCAN_POINTS[i])
    else if (closeTo(c, BLUE)) bluePoints.push(SCAN_POINTS[i])
  })
  return { redPoints, bluePoints }
}

test.beforeEach(async ({ page }) => {
  await mountWebGLView(page)
})

test.describe('WEBGL flip mapping: one mapping source for render, cursor and metrics', () => {
  test('flip swaps logical A/B consistently across cursor picker, metrics and rendered texture', async ({ page }) => {
    // Arrange: red on physical track A, blue on physical track B.
    const red = await addFixtureMedia(page, '/tests/fixtures/media/red.png', 'red.png')
    const blue = await addFixtureMedia(page, '/tests/fixtures/media/blue.png', 'blue.png')
    await addClipOnTrack(page, red.id, 'track-a')
    await addClipOnTrack(page, blue.id, 'track-b')

    const canvas = await waitForComparisonCanvas(page)
    await setWebGLMode(page, 'pro-checkerboard')
    await enableCursorInspector(page)
    await enableMetricsOverlay(page)
    await waitForSourcesReady(page)

    // --- Not flipped: logical A = red (track A), logical B = blue (track B)
    await setFlip(page, false)
    await waitForSourcesReady(page)

    const pixelsBefore = await readCursorPixels(page, canvas)
    expect(closeTo(pixelsBefore.a, RED)).toBe(true)
    expect(closeTo(pixelsBefore.b, BLUE)).toBe(true)

    const metricsBefore = await waitForMetrics(page)
    expect(metricsBefore).not.toBeNull()

    // Discover points that render pure texture A (red) and pure texture B
    // (blue). The checkerboard shader blends tile boundaries, so we only use
    // points known to sit inside a single tile.
    const before = await collectPurePoints(page, canvas)
    expect(before.redPoints.length).toBeGreaterThan(3)
    expect(before.bluePoints.length).toBeGreaterThan(3)

    // --- Flip: logical A must become blue, logical B red everywhere at once
    await setFlip(page, true)
    await waitForSourcesReady(page)
    expect(await page.evaluate(() =>
      window.__dualviewProject.getState().webglComparisonSettings.flipAB,
    )).toBe(true)

    const pixelsAfter = await readCursorPixels(page, canvas)
    expect(closeTo(pixelsAfter.a, BLUE)).toBe(true)
    expect(closeTo(pixelsAfter.b, RED)).toBe(true)

    // At each previously-pure point, the rendered source must have inverted:
    // a point that showed texture A (red) now shows texture B (blue), and vice
    // versa. Boundary-blended points that are no longer pure are skipped rather
    // than asserted, so the check targets the clear interior of each tile.
    const after = await collectPurePoints(page, canvas)
    const pureAfter = new Map()
    for (const p of after.redPoints) pureAfter.set(p.join(','), RED)
    for (const p of after.bluePoints) pureAfter.set(p.join(','), BLUE)

    let swapped = 0
    for (const p of before.redPoints) {
      const now = pureAfter.get(p.join(','))
      if (now) {
        expect(closeTo(now, BLUE)).toBe(true)
        swapped++
      }
    }
    for (const p of before.bluePoints) {
      const now = pureAfter.get(p.join(','))
      if (now) {
        expect(closeTo(now, RED)).toBe(true)
        swapped++
      }
    }
    // A meaningful set of interior tiles must demonstrably have inverted.
    expect(swapped).toBeGreaterThan(3)

    // SSIM/Delta E are symmetric: metrics for the same pair must stay
    // statistically identical after the flip (same sources, same computation).
    // Absolute tolerances reflect each metric's scale and the sub-pixel jitter
    // from re-drawn downsampled metric canvases.
    const metricsAfter = await waitForMetrics(page, { minTimestamp: metricsBefore.timestamp })
    expect(metricsAfter).not.toBeNull()
    expect(Math.abs(metricsAfter.ssim - metricsBefore.ssim)).toBeLessThanOrEqual(0.05)
    expect(Math.abs(metricsAfter.deltaE - metricsBefore.deltaE)).toBeLessThanOrEqual(8)
    expect(Math.abs(metricsAfter.diffPixelPercent - metricsBefore.diffPixelPercent)).toBeLessThanOrEqual(2)
  })

  test('flip does not reload media or reset video/source readiness', async ({ page }) => {
    const red = await addFixtureMedia(page, '/tests/fixtures/media/red.png', 'red.png')
    const blue = await addFixtureMedia(page, '/tests/fixtures/media/blue.png', 'blue.png')
    await addClipOnTrack(page, red.id, 'track-a')
    await addClipOnTrack(page, blue.id, 'track-b')
    await waitForComparisonCanvas(page)
    await waitForSourcesReady(page)

    // Physical element src attributes must be untouched by a flip.
    const srcBefore = await page.evaluate(() => {
      const videos = [...document.querySelectorAll('video')]
      const imgs = [...document.querySelectorAll('img.hidden, img[alt=""]')]
      return {
        videos: videos.map(v => v.getAttribute('src')),
        imgs: imgs.map(i => i.getAttribute('src')),
      }
    })

    await setFlip(page, true)
    await waitForSourcesReady(page)

    const srcAfter = await page.evaluate(() => {
      const videos = [...document.querySelectorAll('video')]
      const imgs = [...document.querySelectorAll('img.hidden, img[alt=""]')]
      return {
        videos: videos.map(v => v.getAttribute('src')),
        imgs: imgs.map(i => i.getAttribute('src')),
      }
    })
    expect(srcAfter).toEqual(srcBefore)

    // No loading badge may appear as a consequence of flipping alone.
    const loadingVisible = await page.evaluate(() =>
      [...document.querySelectorAll('div')].some(
        d => d.textContent && d.textContent.includes('Loading new sources'),
      ),
    )
    expect(loadingVisible).toBe(false)
  })

  test('media switch: stale frame and stale metrics are blocked until the new source is sampleable', async ({ page }) => {
    const red = await addFixtureMedia(page, '/tests/fixtures/media/red.png', 'red.png')
    const blue = await addFixtureMedia(page, '/tests/fixtures/media/blue.png', 'blue.png')
    await addClipOnTrack(page, red.id, 'track-a')
    await addClipOnTrack(page, blue.id, 'track-b')
    const canvas = await waitForComparisonCanvas(page)
    await enableMetricsOverlay(page)
    await waitForSourcesReady(page)

    // Find a checkerboard tile currently fed by texture A (red). Tile parity
    // depends on canvas resolution, so discover the point rather than assume.
    await setWebGLMode(page, 'pro-checkerboard')
    const redTile = await findPointWithColor(page, canvas, RED)
    expect(redTile).not.toBeNull()
    const [tileX, tileY] = redTile.point
    const metricsBefore = await waitForMetrics(page)
    expect(metricsBefore).not.toBeNull()

    // Gate the replacement image's response: while closed the <img> cannot
    // finish loading, so track A's new source stays not-ready. Releasing the
    // gate fulfills the in-flight request with the real bytes, which reliably
    // lets the element complete its load.
    const gatedUrl = 'http://127.0.0.1:4180/gated/green.png'
    let releaseGate
    const gate = new Promise(resolve => {
      releaseGate = resolve
    })
    const greenB64 = await page.evaluate(async () => {
      const res = await fetch('/tests/fixtures/media/green.png')
      const buf = new Uint8Array(await res.arrayBuffer())
      let binary = ''
      for (const byte of buf) binary += String.fromCharCode(byte)
      return btoa(binary)
    })
    const greenBytes = Buffer.from(greenB64, 'base64')

    await page.route(gatedUrl, async route => {
      await gate
      await route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: greenBytes,
      })
    })

    const gated = await addGatedImageMedia(
      page,
      '/tests/fixtures/media/green.png',
      'green.png',
      gatedUrl,
    )

    // Swap track A's clip from red to the gated green source.
    await removeTrackClips(page, 'track-a')
    await addClipOnTrack(page, gated.mediaId, 'track-a')

    await waitForSourcesLoading(page)

    // During the not-ready window:
    // 1) metrics show unavailable and were NOT refreshed with new numbers
    await waitForMetricsUnavailable(page)
    const metricsDuring = await getMetrics(page)
    expect(metricsDuring).toEqual(metricsBefore) // previous valid result retained

    // 2) the texture for logical A must be the neutral placeholder: the tile
    //    that used to show red must show neither the old red nor new green.
    const duringTile = await readCanvasAt(page, canvas, tileX, tileY)
    expect(closeTo(duringTile, RED, 25)).toBe(false)
    expect(closeTo(duringTile, GREEN, 25)).toBe(false)

    // 3) cursor inspector reports no stale pixel values
    await enableCursorInspector(page)
    await canvas.hover({ position: { x: 200, y: 150 } })
    await page.waitForTimeout(200)
    const inspectorGone = await page.evaluate(() =>
      [...document.querySelectorAll('div')].every(
        d => !(d.textContent && d.textContent.includes('Pixel Inspector')),
      ),
    )
    expect(inspectorGone).toBe(true)

    // Release the gate: the in-flight request fulfills and the new source
    // becomes sampleable.
    releaseGate()
    await waitForSourcesReady(page)
    await page.unroute(gatedUrl)

    // After readiness: metrics resume updating and reflect the new green/blue pair.
    const metricsAfter = await waitForMetrics(page, { minTimestamp: metricsBefore.timestamp + 1 })
    expect(metricsAfter).not.toBeNull()
    expect(metricsAfter.timestamp).not.toBe(metricsBefore.timestamp)

    // Green must now be present as texture A: discover a pure-green tile and
    // confirm the old red source no longer feeds any tile. (Checker tile
    // parity makes a fixed-point assertion unreliable, so we assert on the
    // discovered green tile and the absence of red instead.)
    const greenTile = await findPointWithColor(page, canvas, GREEN)
    expect(greenTile).not.toBeNull()
    const { redPoints: redAfterSwap } = await collectPurePoints(page, canvas)
    expect(redAfterSwap).toHaveLength(0)
    expect(closeTo(greenTile.color, GREEN)).toBe(true)
  })

  test('ROI stays aligned to the same source region after a flip', async ({ page }) => {
    // Both images are half red / half blue, with inverted halves. A ROI on the
    // left half therefore measures red-vs-blue; ROI coordinates are normalized
    // source coordinates and must remain valid regardless of flip ordering.
    const imgA = await addFixtureMedia(page, '/tests/fixtures/media/half-red-blue.png', 'hrb.png')
    const imgB = await addFixtureMedia(page, '/tests/fixtures/media/half-blue-red.png', 'hbr.png')
    await addClipOnTrack(page, imgA.id, 'track-a')
    await addClipOnTrack(page, imgB.id, 'track-b')
    await waitForComparisonCanvas(page)
    await enableMetricsOverlay(page)
    await waitForSourcesReady(page)

    // Capture wall-clock markers before each settings change and only accept
    // metrics computed afterwards, so a stale pre-ROI result can never be read
    // as the ROI measurement.
    // ROI = left half (normalized coords in source space)
    let t0 = Date.now()
    await setRoi(page, { x: 0, y: 0, width: 0.5, height: 1 })
    const leftMetrics = await waitForMetrics(page, { minTimestamp: t0 })
    expect(leftMetrics).not.toBeNull()
    expect(leftMetrics.diffPixelPercent).toBeGreaterThan(50) // left halves differ

    // ROI = right half
    t0 = Date.now()
    await setRoi(page, { x: 0.5, y: 0, width: 0.5, height: 1 })
    const rightMetrics = await waitForMetrics(page, { minTimestamp: t0 })
    expect(rightMetrics.diffPixelPercent).toBeGreaterThan(50) // right halves also differ

    // Flipping A/B must not shift ROI geometry: left-ROI metrics after a flip
    // stay in the same measurement regime as before it (same region, symmetric
    // computation). Tolerances absorb the sub-pixel jitter from re-drawn
    // downsampled metric canvases; the strong claim is that both sides still
    // register a strong difference, not bit-exact equality.
    const within = (a, b, absTol) => Math.abs(a - b) <= absTol
    await setFlip(page, true)
    await waitForSourcesReady(page)
    t0 = Date.now()
    await setRoi(page, { x: 0, y: 0, width: 0.5, height: 1 })
    const flippedLeft = await waitForMetrics(page, { minTimestamp: t0 })
    expect(flippedLeft).not.toBeNull()
    expect(within(flippedLeft.diffPixelPercent, leftMetrics.diffPixelPercent, 3)).toBe(true)
    expect(within(flippedLeft.deltaE, leftMetrics.deltaE, 10)).toBe(true)
    expect(within(flippedLeft.ssim, leftMetrics.ssim, 0.1)).toBe(true)

    // And right ROI still targets the right half after flip.
    t0 = Date.now()
    await setRoi(page, { x: 0.5, y: 0, width: 0.5, height: 1 })
    const flippedRight = await waitForMetrics(page, { minTimestamp: t0 })
    expect(within(flippedRight.diffPixelPercent, rightMetrics.diffPixelPercent, 3)).toBe(true)

    await clearRoi(page)
    await setFlip(page, false)
  })

  test('mode switching and export entries remain functional across flips', async ({ page }) => {
    const red = await addFixtureMedia(page, '/tests/fixtures/media/red.png', 'red.png')
    const blue = await addFixtureMedia(page, '/tests/fixtures/media/blue.png', 'blue.png')
    await addClipOnTrack(page, red.id, 'track-a')
    await addClipOnTrack(page, blue.id, 'track-b')
    await waitForComparisonCanvas(page)
    await waitForSourcesReady(page)

    // Mode changes keep working while flipped.
    await setFlip(page, true)
    for (const mode of ['diff-absolute', 'diff-perceptual', 'pro-checkerboard', 'struct-edge']) {
      await setWebGLMode(page, mode)
      const activeMode = await page.evaluate(
        () => window.__dualviewProject.getState().webglComparisonSettings.mode,
      )
      expect(activeMode).toBe(mode)
      await expect(comparisonCanvas(page)).toBeVisible()
    }

    // Export entries stay present, enabled and wired while flipped. We assert
    // on the controls' presence/state only and avoid triggering an actual
    // download or clipboard write: headless software-rendered Chromium handles
    // data-URL downloads/clipboard inconsistently and can stall page teardown.
    const screenshotBtn = page.getByTitle('Save Screenshot (PNG)')
    await expect(screenshotBtn).toBeVisible()
    await expect(screenshotBtn).toBeEnabled()
    await expect(page.getByTitle('Copy to Clipboard')).toBeVisible()
    await expect(page.getByTitle('Export PDF Analysis Report (WEBGL-010)')).toBeVisible()

    // The canvas remains live after the mode/flip/export-control exercise.
    await expect(comparisonCanvas(page)).toBeVisible()
  })
})
