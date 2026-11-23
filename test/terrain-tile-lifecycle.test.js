import { assert } from '@esm-bundle/chai'
import reglInit from 'regl'
import { DtmTileManager, SatTileCache } from '../src/layers/gis/ImageTerrainImpl.js'
import { tileToMercBbox } from '../src/layers/gis/TileLayer.js'

// ─── Local fake tile source (no network) ─────────────────────────────────────
// A solid-color PNG generated at runtime as a data: URL. Used for both the DTM
// source and the imagery source — tile content is irrelevant for lifecycle,
// alignment and texture-release checks (those depend on tile math and bounds).

function makeTileDataUrl() {
  const c = document.createElement('canvas')
  c.width = 8
  c.height = 8
  const ctx = c.getContext('2d')
  ctx.fillStyle = 'rgb(120, 130, 140)'
  ctx.fillRect(0, 0, 8, 8)
  return c.toDataURL('image/png')
}

// ─── regl setup (same getExtension patch as texture-upload.test.js) ──────────

function createRegl() {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 64
  document.body.appendChild(canvas)

  const gl = canvas.getContext('webgl2')
  if (!gl) throw new Error('WebGL2 not available')

  const orig = gl.getExtension.bind(gl)
  const wgl2Core = ['oes_texture_float', 'oes_texture_float_linear']
  gl.getExtension = name => {
    const lname = name.toLowerCase()
    if (wgl2Core.includes(lname)) return orig(name) ?? {}
    if (lname === 'angle_instanced_arrays') {
      return orig(name) ?? {
        vertexAttribDivisorANGLE: gl.vertexAttribDivisor.bind(gl),
        drawArraysInstancedANGLE: gl.drawArraysInstanced.bind(gl),
        drawElementsInstancedANGLE: gl.drawElementsInstanced.bind(gl),
        VERTEX_ATTRIB_ARRAY_DIVISOR_ANGLE: 0x88FE,
      }
    }
    return orig(name)
  }

  const GL_RGBA = 0x1908, GL_FLOAT = 0x1406, GL_RGBA32F = 0x8814
  const origTex = gl.texImage2D.bind(gl)
  gl.texImage2D = function (...args) {
    if (args.length >= 8 && args[2] === GL_RGBA && args[7] === GL_FLOAT) {
      args = [...args]; args[2] = GL_RGBA32F
    }
    return origTex(...args)
  }

  const regl = reglInit({
    gl,
    extensions: ['OES_texture_float', 'EXT_color_buffer_float', 'ANGLE_instanced_arrays'],
    optionalExtensions: ['OES_texture_float_linear'],
  })

  return { regl, canvas }
}

// Wraps regl.texture so every created/destroyed texture is tracked — lets tests
// assert "no render item references a destroyed texture" and "every texture is
// released exactly once at teardown".
function trackTextures(regl) {
  const created = new Set()
  const destroyed = new Set()
  const origTexture = regl.texture.bind(regl)
  const tracking = Object.create(regl)
  tracking.texture = (opts) => {
    const tex = origTexture(opts)
    created.add(tex)
    const origDestroy = tex.destroy.bind(tex)
    tex.destroy = () => { destroyed.add(tex); origDestroy() }
    return tex
  }
  return { regl: tracking, created, destroyed }
}

// ─── View / manager helpers ──────────────────────────────────────────────────

const MERC_MAX = Math.PI * 6378137
const WORLD = 2 * MERC_MAX

// 2×2 tiles at z=2 (keys 2/1/1 … 2/2/2) with a 512px viewport
const VIEW_Z2 = { d: [-WORLD / 4 + 1, WORLD / 4 - 1], vp: { width: 512, height: 512 } }
// 2×2 tiles at z=3 (keys 3/3/3 … 3/4/4) — the next zoom level, same area
const VIEW_Z3 = { d: [-WORLD / 8 + 1, WORLD / 8 - 1], vp: { width: 512, height: 512 } }
// 8×8 = 64 tiles at z=3 (whole world) with a 2048px viewport — exceeds MAX_TILE_CACHE (50)
const VIEW_WORLD = { d: [-MERC_MAX + 1, MERC_MAX - 1], vp: { width: 2048, height: 2048 } }
// Viewport hint for imagery requests: large enough that the inferred sat zoom
// lands exactly on the DTM tile zoom (avoids float-boundary ambiguity in
// optimalZoom's floor() when the viewport term sits exactly on a power of two).
const SAT_VP = { width: 1024, height: 1024 }

function makeTerrain(regl) {
  const fns = {
    xTexFns: [() => null], zTexFns: [() => null], dtmTexFns: [() => null],
    satTexFns: [() => null], satUvXTexFns: [() => null], satUvYTexFns: [() => null],
    dtmUvRangeFns: [() => null],
  }
  const satCacheRef = { cache: null }
  const dataUrl = makeTileDataUrl()
  const manager = new DtmTileManager({
    regl,
    source: { type: 'xyz', url: dataUrl, maxZoom: 15, encoding: 'terrarium', crs: 'EPSG:3857' },
    dtmTileCrs: 'EPSG:3857', plotCrs: 'EPSG:3857', satTileCrs: 'EPSG:3857',
    tessellation: 4,
    ...fns,
    satCacheRef,
    onLoad: () => {},
  })
  const satCache = new SatTileCache({
    regl,
    source: { type: 'xyz', url: dataUrl, maxZoom: 19, crs: 'EPSG:3857' },
    satTileCrs: 'EPSG:3857',
    // Mirror the createLayer wiring: arriving imagery rebuilds the render items.
    onLoad: () => manager._rebuildArrays(),
  })
  satCacheRef.cache = satCache
  return { manager, satCache, fns }
}

async function waitFor(cond, what = 'condition', timeout = 15000) {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > timeout) throw new Error(`waitFor timeout: ${what}`)
    await new Promise(r => setTimeout(r, 10))
  }
}

const allLoaded = (map) => map.size > 0 && [...map.values()].every(t => t.status === 'loaded')

function syncView(manager, view) {
  manager.syncTiles(view.d, view.d, view.vp)
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('terrain tile lifecycle (DtmTileManager + SatTileCache)', function () {
  this.timeout(30000)

  let rawRegl, canvas, regl, created, destroyed

  beforeEach(() => {
    ({ regl: rawRegl, canvas } = createRegl())
    ;({ regl, created, destroyed } = trackTextures(rawRegl))
  })

  afterEach(() => {
    rawRegl.destroy()
    document.body.removeChild(canvas)
  })

  it('loads DTM tiles and drapes imagery aligned to each tile footprint', async () => {
    const { manager, satCache, fns } = makeTerrain(regl)

    syncView(manager, VIEW_Z2)
    await waitFor(() => manager.tiles.size === 4 && allLoaded(manager.tiles), '4 DTM tiles loaded')

    // New elevation tiles trigger imagery requests for their footprints.
    manager.requestSatTiles(SAT_VP)
    await waitFor(() => satCache.tiles.size === 4 && allLoaded(satCache.tiles), '4 sat tiles loaded')
    // Imagery arrival rebuilds the render items (via onLoad → _rebuildArrays).
    await waitFor(() => fns.satTexFns.length === 4 && fns.satTexFns.every(fn => fn() !== null),
      'render items updated after imagery arrival')

    // One render item per needed tile; every texture slot non-null.
    assert.equal(fns.xTexFns.length, 4)
    for (const fn of [fns.xTexFns, fns.zTexFns, fns.dtmTexFns,
                      fns.satTexFns, fns.satUvXTexFns, fns.satUvYTexFns].flat()) {
      assert(fn() !== null, 'render item texture must be non-null')
    }
    // Full tiles → full DTM UV range.
    for (const fn of fns.dtmUvRangeFns) assert.deepEqual(fn(), [0, 0, 1, 1])

    // The imagery tile chosen for each slot fully covers the slot footprint, so
    // the computed sat UVs stay inside [0,1] — no holes, no offset. (Tolerance
    // accounts for the float32 mesh positions the footprint is derived from.)
    assert.equal(manager._activeSlots.length, 4)
    const tol = 8 // metres
    for (const slot of manager._activeSlots) {
      const sat = satCache.tiles.get(slot._lastSatKey)
      assert(sat && sat.status === 'loaded', `sat tile ${slot._lastSatKey} loaded`)
      assert(sat.bounds.minX <= slot.satCrsBbox.minX + tol, 'sat covers west edge')
      assert(sat.bounds.maxX >= slot.satCrsBbox.maxX - tol, 'sat covers east edge')
      assert(sat.bounds.minY <= slot.satCrsBbox.minY + tol, 'sat covers south edge')
      assert(sat.bounds.maxY >= slot.satCrsBbox.maxY - tol, 'sat covers north edge')
      // Same-zoom match: bounds coincide with the footprint (not a parent tile).
      assert.closeTo(sat.bounds.minX, slot.satCrsBbox.minX, tol)
      assert.closeTo(sat.bounds.maxX, slot.satCrsBbox.maxX, tol)
    }

    manager.destroy()
    satCache.destroy()
    assert.equal(destroyed.size, created.size, 'every GPU texture released exactly once')
  })

  it('computes sat UVs inside [0,1] for matching-zoom imagery', async function () {
    const { manager, satCache, fns } = makeTerrain(regl)

    syncView(manager, VIEW_Z2)
    await waitFor(() => manager.tiles.size === 4 && allLoaded(manager.tiles), 'DTM tiles loaded')
    manager.requestSatTiles(SAT_VP)
    await waitFor(() => fns.satUvXTexFns.length === 4 && fns.satUvXTexFns.every(fn => fn() !== null),
      'sat UV textures ready')

    const slot = manager._activeSlots[0]
    for (const tex of [slot.satUvXTex, slot.satUvYTex]) {
      let fbo
      try {
        fbo = rawRegl.framebuffer({ color: tex, depth: false, stencil: false })
      } catch (e) {
        this.skip() // float FBO unsupported in this environment
        return
      }
      let pixels
      rawRegl({ framebuffer: fbo })(() => {
        pixels = rawRegl.read({ data: new Float32Array(tex.width * tex.height * 4) })
      })
      fbo.destroy()
      for (let i = 0; i < slot.satXArr.length; i++) {
        assert(pixels[i] >= -1e-3 && pixels[i] <= 1 + 1e-3,
          `UV out of range at ${i}: ${pixels[i]}`)
      }
    }

    manager.destroy()
    satCache.destroy()
  })

  it('uses ancestor sub-meshes while the new zoom level loads, then re-aligns', async () => {
    const { manager, satCache, fns } = makeTerrain(regl)

    // Establish z=2 view with imagery.
    syncView(manager, VIEW_Z2)
    await waitFor(() => manager.tiles.size === 4 && allLoaded(manager.tiles), 'z=2 DTM tiles loaded')
    manager.requestSatTiles(SAT_VP)
    await waitFor(() => satCache.tiles.size === 4 && allLoaded(satCache.tiles), 'z=2 sat tiles loaded')

    // Zoom in: z=3 tiles start loading; render items must immediately fall back
    // to quarter sub-meshes of the loaded z=2 ancestors (no gap, no stale full tiles).
    syncView(manager, VIEW_Z3)
    assert.equal(fns.dtmUvRangeFns.length, 4)
    for (const fn of fns.dtmUvRangeFns) {
      const r = fn()
      assert(r !== null, 'ancestor fallback render item expected')
      assert.closeTo(r[2] - r[0], 0.5, 1e-9, 'ancestor sub-mesh u width')
      assert.closeTo(r[3] - r[1], 0.5, 1e-9, 'ancestor sub-mesh v height')
      assert(r[0] >= 0 && r[1] >= 0 && r[2] <= 1 && r[3] <= 1, 'sub-range inside [0,1]')
    }
    // Ancestor slots still have imagery from the z=2 sat tiles.
    for (const fn of fns.satTexFns) assert(fn() !== null)

    // Once z=3 tiles arrive, request imagery for the new footprints.
    await waitFor(() => [...manager._neededKeys].every(k => manager.tiles.get(k)?.status === 'loaded'),
      'z=3 DTM tiles loaded')
    manager.requestSatTiles(SAT_VP)
    await waitFor(() =>
      manager._activeSlots.length === 4 &&
      manager._activeSlots.every(s => s._lastSatKey?.startsWith('3/')),
      'render items re-aligned to z=3 imagery')

    // Now each render item is a full z=3 tile draped with its own z=3 sat tile.
    assert.equal(fns.xTexFns.length, 4)
    for (const fn of fns.dtmUvRangeFns) assert.deepEqual(fn(), [0, 0, 1, 1])
    for (const fn of fns.satTexFns) assert(fn() !== null)

    manager.destroy()
    satCache.destroy()
    assert.equal(destroyed.size, created.size, 'every GPU texture released exactly once')
  })

  it('never evicts tiles the current view still needs (DTM and imagery)', async () => {
    const { manager, satCache, fns } = makeTerrain(regl)

    // 64 needed tiles > MAX_TILE_CACHE (50): needed tiles must not be evicted.
    syncView(manager, VIEW_WORLD)
    await waitFor(() => allLoaded(manager.tiles) && manager.tiles.size >= 64,
      '64 DTM tiles loaded')
    assert.equal(manager.tiles.size, 64, 'all needed DTM tiles survive the cache limit')
    for (const key of manager._neededKeys) assert(manager.tiles.has(key), `needed tile ${key} present`)

    manager.requestSatTiles(VIEW_WORLD.vp)
    await waitFor(() => allLoaded(satCache.tiles) && satCache.tiles.size >= 64,
      '64 sat tiles loaded')
    assert.equal(satCache.tiles.size, 64, 'all needed imagery survives the cache limit')

    // Switch to a small view: the 60 stale tiles become evictable and the cache
    // shrinks back to the limit, while the 4 newly needed tiles load and stay.
    syncView(manager, VIEW_Z2)
    await waitFor(() =>
      [...manager.tiles.values()].every(t => t.status === 'loaded') &&
      [...manager._neededKeys].every(k => manager.tiles.has(k)),
      'z=2 DTM tiles loaded after view switch')
    manager.requestSatTiles(SAT_VP)
    await waitFor(() =>
      [...satCache.tiles.values()].every(t => t.status === 'loaded') &&
      manager._activeSlots.length === 4 &&
      manager._activeSlots.every(s => satCache.tiles.get(s._lastSatKey)?.status === 'loaded'),
      'z=2 sat tiles loaded after view switch')

    assert(manager.tiles.size <= 50, `DTM cache shrinks to the limit (got ${manager.tiles.size})`)
    assert(satCache.tiles.size <= 50, `sat cache shrinks to the limit (got ${satCache.tiles.size})`)
    for (const key of manager._neededKeys) assert(manager.tiles.has(key), `needed tile ${key} survives`)

    // Render items complete and aligned after the eviction storm.
    assert.equal(fns.xTexFns.length, 4)
    for (const fn of fns.satTexFns) assert(fn() !== null)

    manager.destroy()
    satCache.destroy()
    assert.equal(destroyed.size, created.size, 'every GPU texture released exactly once')
  })

  it('rapid view switches leave no dangling references to destroyed textures', async () => {
    const { manager, satCache, fns } = makeTerrain(regl)

    // Rapid consecutive switches before any tile finishes loading.
    syncView(manager, VIEW_Z2)
    syncView(manager, VIEW_Z3)
    syncView(manager, VIEW_Z2)

    // Force the supersede race: evict a tile while its load is in flight, then
    // re-request it — the stale in-flight load must not overwrite the new entry.
    const racingKey = [...manager.tiles.keys()][0]
    manager._evictTile(racingKey)
    manager._lastXDomain = null // force re-sync of the same view
    syncView(manager, VIEW_Z2)

    await waitFor(() => manager.tiles.size > 0 && allLoaded(manager.tiles), 'DTM loads settled')
    manager.requestSatTiles(SAT_VP)
    await waitFor(() =>
      satCache.tiles.size > 0 && allLoaded(satCache.tiles) &&
      fns.satTexFns.length > 0 && fns.satTexFns.every(fn => fn() !== null),
      'imagery settled')

    // No render item may reference a destroyed texture.
    for (const fn of [fns.xTexFns, fns.zTexFns, fns.dtmTexFns,
                      fns.satTexFns, fns.satUvXTexFns, fns.satUvYTexFns].flat()) {
      const t = fn()
      assert(t !== null, 'render item texture must be non-null')
      assert(!destroyed.has(t), 'render item references a destroyed texture')
    }

    // Full teardown: every texture created along the way (including the stale
    // race load's, if any) is released exactly once — no leaks, no double-free.
    manager.destroy()
    satCache.destroy()
    assert.equal(destroyed.size, created.size, 'every GPU texture released exactly once')
  })

  it('sat cache eviction spares imagery requested for the current frame', async () => {
    const satCache = new SatTileCache({
      regl,
      source: { type: 'xyz', url: makeTileDataUrl(), crs: 'EPSG:3857' },
      satTileCrs: 'EPSG:3857',
      onLoad: () => {},
    })

    // Frame 1: 128 distinct imagery footprints requested — all needed, none evictable.
    satCache.beginFrame()
    for (let i = 0; i < 128; i++) satCache.requestForBbox(tileToMercBbox(i, 0, 7), SAT_VP)
    await waitFor(() => satCache.tiles.size === 128 && allLoaded(satCache.tiles), '128 sat tiles loaded')
    assert.equal(satCache.tiles.size, 128, 'needed imagery is not evicted')

    // Frame 2: only 7/0/0 is still needed; 10 fresh tiles are requested.
    // Eviction must reclaim the 127 stale tiles but spare the needed one.
    satCache.beginFrame()
    satCache.requestForBbox(tileToMercBbox(0, 0, 7), SAT_VP)
    for (let i = 0; i < 10; i++) satCache.requestForBbox(tileToMercBbox(i, 1, 7), SAT_VP)
    await waitFor(() => [...satCache.tiles.values()].every(t => t.status === 'loaded'),
      'second-frame sat loads settled')

    assert(satCache.tiles.has('7/0/0'), 'imagery needed by the current frame survives eviction')
    assert(satCache.tiles.size <= 50, `sat cache shrinks to the limit (got ${satCache.tiles.size})`)

    satCache.destroy()
    assert.equal(destroyed.size, created.size, 'every GPU texture released exactly once')
  })
})
