# Plan: layer-type pick mapping (`pickInfo`) + extensible `LayerType` constructor

## Overview

`Plot.pick(x, y)` (`src/core/Plot.js:1534`) GPU-hit-tests one pixel and decodes
it into:

```js
{ layerIndex, configLayerIndex, tile, index, layer }
```

`index` is the decoded `a_pickId` minus the tile offset — i.e. a **primitive-space**
index: the *vertex* index for a non-instanced layer, or the *instance* index for an
instanced one. The pickId buffer is built unconditionally in
`LayerType.createDrawCommand` as `[0, 1, … pickCount-1]`, with
`pickCount = instanceCount ?? vertexCount` (`LayerType.js:196-212`).

The problem: **how a primitive maps back to the user's data rows is layer-type
specific**, and nothing in the pick path knows it. Surveying the built-ins:

| Layer type | `pickCount` source | primitive | what `index` is | data row(s) |
|---|---|---|---|---|
| `points` (`PointsLayer.js`) | `vertexCount = N` | vertex | data row | `index` (1:1) |
| `lines` (`LinesLayer.js:167`) | `instanceCount = N-1` | segment | segment `i` | rows `i`, `i+1` |
| `bars` (`BarsLayer.js:156`) | `instanceCount = bins` | bin quad | bin index | row `index` of the (pre-aggregated) x/y columns |
| `colorbar` / `colorbar2d` / `filterbar` | `vertexCount = 4 / 4 / 0` | gradient quad | quad corner | none (decorative) |
| `tile` (`gis/TileLayer.js:493`) | `vertexCount = N*N*6` per tile | mesh vertex | triangle vertex | none (raster mesh) |
| gis terrain (`ImageTerrainImpl`, `QmTerrainImpl`) | `N*N*6` / mesh | mesh vertex | triangle vertex | none (raster/terrain mesh) |
| `gltf` (`GltfLayer.js:353`) | `vertexCount = totalCount` | model vertex | model vertex | none / model-defined |

Today the only documented recovery (`docs/user-api/Plot.md:336-345`) is to index
`layer.attributes` at `index`, which yields GPU-attribute values *in primitive
space* — never the original data index, and meaningless for `bars`/`tile`.

A second, independent problem blocks fixing the first cleanly: the `LayerType`
constructor (`LayerType.js:89-119`) destructures a **fixed** list of fields
(`schema, createLayer, getAxisConfig, createDrawCommand`, plus axis/shader fields)
and silently drops anything else. So `new LayerType({ …, pickInfo: fn })` loses
`pickInfo`; a library user can only add behaviour by subclassing. Any new
overridable method — including the pick mapper — cannot be retrofitted through the
public declarative constructor.

This plan adds:

- **Part A** — an overridable `pickInfo(regl, parameters, data, plot, layer, primitive)`
  method on `LayerType`, **mirroring `createLayer`** (same private-slot + public-wrapper
  pattern, same leading `(regl, parameters, data, plot)` context), called by
  `Plot.pick()` and merged into the result.
- **Part B** — generic function-injection in the `LayerType` constructor, so any
  *other* method can be supplied declaratively without subclassing.
- **Part C** — built-in overrides for every registered layer type, and docs.

## Design decisions (settled)

1. **Mapper return shape: free-form object, merged.** `pickInfo` returns an
   arbitrary object; `Plot.pick()` spreads it into the pick result next to the
   existing `layer/tile/index`. Each layer type names its own keys, so a layer with
   no single source row (`bars`, `tile`) can say so (`dataIndex: null`) while still
   adding whatever it *does* know (`bin`, geo coords). A single mandatory numeric
   `dataIndex` was rejected as lossy.
2. **`pickInfo` mirrors `createLayer` as closely as possible.** Same calling
   convention: a private `_pickInfo` slot assigned from the constructor config
   (exactly like `_createLayer`), a public prototype wrapper that delegates to it via
   `this._pickInfo.call(this, …)` (so `this` is the `LayerType`), and the same leading
   arguments `(regl, parameters, data, plot)` — with the pick-specific `layer` and
   `primitive` appended. The only difference from `createLayer`: the wrapper supplies
   an **identity default** when `_pickInfo` is absent, instead of throwing (every layer
   needs pick-mapping; most want 1:1).
3. **Keep generic function injection too (Part B).** In addition to the explicit
   `pickInfo` slot, the constructor copies any *other* function-valued config property
   onto the instance, so future overridable hooks need no subclass. (Chosen option B
   over mirror-only: `pickInfo` gets its own named slot *and* arbitrary methods stay
   injectable.)
4. **Scope: all built-ins, including tile/gis.** Every registered layer type gets a
   `pickInfo`; those with no data row return `dataIndex: null` (plus cheap extras
   where available).

## Part A — `pickInfo` on `LayerType` (mirrors `createLayer`)

`createLayer` has three defining traits (`LayerType.js:116, 483-487`): the config
function is stored in a private `_createLayer` slot; a public prototype method
`createLayer(regl, parameters, data, plot)` delegates to it via
`this._createLayer.call(this, …)`; and the constructor destructures `createLayer`
with `if (createLayer) this._createLayer = createLayer`. `pickInfo` copies all three.

Add the public wrapper on `LayerType` (prototype), synchronous and pure given the
mirrored context plus the primitive coordinates:

```js
// src/core/LayerType.js
/**
 * Map a pick hit from primitive space (vertex/instance index within a tile) to
 * data space. Mirrors createLayer's calling convention: the leading
 * (regl, parameters, data, plot) are exactly what createLayer received, so a layer
 * type's pickInfo can reference the same parameters/data it built from. The
 * pick-specific `layer` (the created Layer — per-layer state stashed by the factory
 * is reachable via layer.*) and `primitive` (decoded pick coords) are appended.
 * Returns a free-form object that Plot.pick() merges into its result.
 * Default (no _pickInfo supplied): identity (1 vertex = 1 data row).
 * @param {import('regl').Regl} regl
 * @param {object} parameters          the layer's config parameters
 * @param {DataGroup} data             plot.currentData
 * @param {Plot} plot
 * @param {Layer} layer
 * @param {{ tile: number, index: number, globalId: number }} primitive
 * @returns {object}  merged into the pick result (e.g. { dataIndex })
 */
pickInfo(regl, parameters, data, plot, layer, primitive) {
  if (this._pickInfo) return this._pickInfo.call(this, regl, parameters, data, plot, layer, primitive)
  return { dataIndex: primitive.index }
}
```

Because the wrapper receives `layer`, it subsumes the "per-layer pick method" idea:
any per-layer mapping data the factory produced is reachable via `layer.*` — no
second mechanism is introduced. And because it receives the same `(regl, parameters,
data, plot)` as `createLayer`, a layer type can map back to its *source* data (via
`data`/`parameters`) and not only to the GPU attributes on `layer`.

### Return-value contract

- `pickInfo` **must return an object** (never `undefined`/`null`). The default and
  every built-in return a plain object; `Plot.pick()` spreads it unconditionally,
  so a non-object would throw.
- The returned object is **merged into** the pick result after the fixed fields
  (`layerIndex, configLayerIndex, tile, index, layer`). It normally only *adds*
  keys; because `...info` is spread last it *can* override `index`/`tile`, but that
  is not the intent.
- **`dataIndex` is the common convention** for "the source-data row this hit maps
  to." Every built-in returns it (even if `null`), so callers can rely on the key
  existing.

- **`dataIndex` is tile-local — it indexes within the result's `tile`, not
  globally.** The default `dataIndex === index`, and `index` is the primitive index
  *within the hit tile* (`globalId - offsets[tile]`). For a tiled layer the data
  columns are `Float32Array[]` (one per tile), so `dataIndex` alone does **not**
  locate a datum — it must be paired with `tile`:

  ```
  value for column `col` = layer.attributes[col][tile][dataIndex]   // tiled layer (Float32Array[])
                         = layer.attributes[col][dataIndex]          // non-tiled layer (tile === 0)
  ```

  For a non-tiled layer `tile` is always `0` and `globalId === index`, so the
  distinction collapses and `dataIndex` reads as a plain row index. The name
  "dataIndex" is therefore only self-contained for non-tiled layers; the docs
  (Part C) must state loudly that it is relative to `tile`. (A globally-unique id is
  available separately as `globalId` on the `primitive` arg if a layer type wants
  to surface one.)

- **`dataIndex: null`** is the sentinel for "this primitive has no single source
  row" — aggregate layers (`bars` conceptually), raster meshes (`tile`, gis
  terrain), model meshes (`gltf`). Use `null` specifically (not `undefined` or an
  absent key) so `result.dataIndex != null` is a reliable "has a row" test.

### `Plot.pick()` change (`src/core/Plot.js:1576-1585`)

Replace the result assembly so the layer type interprets the hit. The mirrored
signature needs the same `(parameters, data)` `createLayer` saw; both are recovered
with no build-time plumbing — `data` is `this.currentData`, and `parameters` is
read back from the live config via the layer's already-stored `configLayerIndex`:

```js
const layerIndex = pixels[0] - 1
const globalId   = (pixels[1] << 16) | (pixels[2] << 8) | pixels[3]
const layer      = this.layers[layerIndex]
const offsets    = layer._tilePickOffsets ?? [0]
let tile = 0
for (let t = offsets.length - 1; t >= 0; t--) {
  if (offsets[t] <= globalId) { tile = t; break }
}
const index      = globalId - offsets[tile]
const parameters = Object.values(this.currentConfig.layers[layer.configLayerIndex])[0]
const info       = layer.type.pickInfo(this.regl, parameters, this.currentData, this, layer, { tile, index, globalId })
result = { layerIndex, configLayerIndex: layer.configLayerIndex, tile, index, layer, ...info }
```

Notes:
- `parameters` recovery: each `this.currentConfig.layers[i]` is a single-key
  `{ layerTypeName: parameters }` object (`Plot.js:1145-1151`), and `configLayerIndex`
  indexes straight into that array (`Plot.js:1143`), so
  `Object.values(…[configLayerIndex])[0]` *is* the `parameters` the factory received.
  When one config entry expanded into several `Layer`s they share `configLayerIndex`,
  so they all resolve to the same `parameters` — correct, since they came from one spec.
  No `layer.parameters` stash is needed.
- `data` is `this.currentData` — the exact `DataGroup` passed to `createLayer`
  (`Plot.js:547, 1190`).
- The local decoded pickId is renamed `const dataIndex` → `globalId` (it is the raw
  pre-offset id); `dataIndex` is now a key the layer type returns.
- The identity default keeps today's behaviour for `points` (result still has
  `index`, and now also `dataIndex === index`).
- `...info` spread last lets a layer type override `index`/`tile` too if it must,
  though normally it only *adds* keys.
- `globalId` is the raw decoded pickId (pre-offset); passed through on `primitive` for
  layers that reason in global rather than per-tile space.

## Part B — extensible constructor (`src/core/LayerType.js:89-119`)

Two layers, in order.

**1. Explicit named-method handling** — keep the four existing named methods and
their private-name mapping (`schema`→`_schema`, `createLayer`→`_createLayer`,
`getAxisConfig`→`_getAxisConfig`, `createDrawCommand`→`this.createDrawCommand`), and
add `pickInfo`→`_pickInfo` right alongside `createLayer` (the mirror from Part A):

```js
// in the destructure list:
vert, frag, schema, createLayer, createDrawCommand, pickInfo,
suppressWarnings = false
// in the body, next to the other slot assignments:
if (schema) this._schema = schema
if (createLayer) this._createLayer = createLayer
if (getAxisConfig) this._getAxisConfig = getAxisConfig
if (createDrawCommand) this.createDrawCommand = createDrawCommand
if (pickInfo) this._pickInfo = pickInfo        // ← mirrors _createLayer
```

**2. Generic function injection** — after the explicit block, copy any **remaining
function-valued** config property onto the instance, skipping `handled` (names the
explicit block already consumed) and `RESERVED` (internal method names that must
never be clobbered):

```js
const handled = new Set([
  'name', 'suppressWarnings',
  'xAxis','xAxisQuantityKind','yAxis','yAxisQuantityKind','zAxis','zAxisQuantityKind',
  'colorAxisQuantityKinds','colorAxis2dQuantityKinds','filterAxisQuantityKinds',
  'getAxisConfig','vert','frag','schema','createLayer','createDrawCommand','pickInfo',
])
const RESERVED = new Set([
  'resolveAxisConfig', 'createLayer', 'createDrawCommand', 'schema', 'pickInfo',
])
for (const [key, val] of Object.entries(cfg)) {
  if (handled.has(key) || RESERVED.has(key)) continue
  if (typeof val === 'function') this[key] = val
}
```

Bind the destructured config to a named `cfg` const at the top of the constructor so
the generic loop can re-iterate it.

Note the mirror **dissolves the old `pickInfo` injection problem**. An earlier draft
had `pickInfo` as a bare prototype default and worried that a `key in this` guard
(`'pickInfo' in this` is `true`) would block overriding it via config. With the
mirror, config's `pickInfo` goes through the explicit `_pickInfo` slot and so lives
in `handled` — the generic loop never touches it. The generic loop therefore guards
only against `RESERVED` internal names, and never needs `key in this` at all. (This is
why option B — mirror *plus* generic injection — is clean: the two mechanisms don't
collide. `pickInfo` appears in both sets defensively: `handled` because the explicit
block consumed it, `RESERVED` so no arbitrary config function can shadow the public
wrapper.)

## Part C — built-in overrides + docs

Supply a `pickInfo` in the layer type's constructor config (declaratively, via the
new slot) wherever the default identity is wrong or lossy. Each uses the mirrored
signature `pickInfo(regl, parameters, data, plot, layer, primitive)`, destructuring
only what it needs from `primitive`:

- **`points`** — no override needed; identity (`dataIndex = index`) is correct.
- **`lines`** (`LinesLayer.js`) — instance = segment:
  ```js
  pickInfo(regl, parameters, data, plot, layer, { index }) {
    return { dataIndex: index, segment: index, endpoints: [index, index + 1] }
  }
  ```
- **`bars`** (`BarsLayer.js`) — instance = bin; the x/y columns are already
  per-bin, so the bin index *is* the data row of those columns:
  ```js
  pickInfo(regl, parameters, data, plot, layer, { index }) { return { dataIndex: index, bin: index } }
  ```
- **`colorbar` / `colorbar2d` / `filterbar`** — decorative quads, no data:
  ```js
  pickInfo() { return { dataIndex: null } }
  ```
- **`tile`** (`gis/TileLayer.js`) — raster mesh, no data row. Return
  `{ dataIndex: null, tile }`. Optional (confirm during implementation): recover a
  geographic position from the tile's position columns at `index` and add
  `{ lon, lat }` / world coords — cheap if the position `Float32Array`s for the hit
  tile are readable at pick time; skip if it would force a GPU read-back.
- **gis terrain** (`ImageTerrainImpl.js`, `QmTerrainImpl.js`) — same treatment as
  `tile`: `{ dataIndex: null, tile }`, with optional geo coords.
- **`gltf`** (`GltfLayer.js`) — model-vertex space, no source row; return
  `{ dataIndex: null }` (revisit if a per-instance model id is meaningful).

Any built-in that already defines its factory via a subclass can equivalently
override the public `pickInfo` method on its subclass prototype — whichever matches
how that layer already supplies `createLayer`/`createDrawCommand`.

### Two API surfaces (keep them distinct in the docs)

- **Plot user-facing API** — unchanged entry point `plot.pick(x, y)`. There is **no
  user-facing `pickInfo`**; the user only ever sees its return value *merged into* the
  `pick()` result. The sole visible change is the extra keys (`dataIndex`, per-type
  extras) on that result object.
- **Extension (layer-type-author) API** — `pickInfo(regl, parameters, data, plot,
  layer, primitive)`, supplied in the constructor config or overridden on a subclass.
  This is never invoked by an application that merely uses a plot.

### Docs

- `docs/user-api/Plot.md` — rewrite the `pick(x, y)` section (`:304-351`): the
  result now carries layer-type-supplied keys (`dataIndex`, and per-type extras);
  document the identity default and the merge; update the "read the data values"
  example to use `dataIndex` and note `dataIndex: null` for aggregate/raster layers.
  **State that `pick(x, y)` remains the only user-facing call** — `pickInfo` is an
  extension point, not something an app invokes. **State loudly that `dataIndex` is
  relative to `tile`** (within-tile), show the tiled vs non-tiled read
  (`attributes[col][tile][dataIndex]` vs `attributes[col][dataIndex]`), and mention
  `globalId` for a cross-tile id.
- `docs/extension-api/LayerTypes.md` — document (a) the full
  `pickInfo(regl, parameters, data, plot, layer, primitive)` signature, its mirror of
  `createLayer`, and the merge semantics; and (b) the generic function-injection: any
  *other* method can be passed in the constructor config and is attached to the
  instance (except the reserved internal names), so custom hooks need no subclass.

## Scope / out of scope

- **In:** the public `pickInfo` wrapper + `_pickInfo` slot (mirroring `createLayer`)
  with its identity default, the `Plot.pick()` merge (with `parameters`/`data`
  recovery), the generic constructor injection for *other* methods, overrides for all
  registered built-ins, and the two doc updates.
- **Out:** changing the pick encoding (still layer/tile/vertex in the framebuffer),
  async `pickInfo` (kept sync — all mappings here are pure), any per-*layer* (as
  opposed to per-*type*) override mechanism, and any user-facing `pickInfo` entry
  point (the plot user API stays `plot.pick(x, y)`).

## Risks / things to verify during implementation

- **`cfg` binding** (Part B): the destructure must also be bound to a named `cfg`
  const so the generic loop can re-iterate the config; add `pickInfo` to the
  destructure and set `this._pickInfo` next to `_createLayer`.
- **`handled` / `RESERVED` coverage** (Part B): `pickInfo` must be in **both** —
  `handled` (consumed by the explicit slot) and `RESERVED` (so no arbitrary config
  function shadows the public wrapper). Verify the reserved set covers every internal
  method (`resolveAxisConfig`, `createLayer`, `createDrawCommand`, `schema`,
  `pickInfo`) and nothing else. The mirror removes the old `key in this` concern
  entirely — do **not** reintroduce an `in this` guard.
- **Subclass `createDrawCommand`** (`LinesLayerType`, `PointsLayerType`,
  `BarsLayerType`): these define `createDrawCommand` on the subclass prototype and
  do **not** pass it through config, so neither the explicit handling nor the
  generic loop touches them. Confirm no built-in passes an overridable hook named
  the same as an internal method.
- **`parameters` recovery in `Plot.pick()`**: relies on `this.currentConfig.layers`
  being the live config and `layer.configLayerIndex` indexing straight into it. Verify
  `currentConfig` is always set when `pick()` can run (layers exist ⇒ an `update()`
  completed ⇒ `currentConfig` is populated), and that `configLayerIndex` still aligns
  after layers are skipped on clash/error (it is assigned from the config loop index,
  not the surviving-layer position, so it does).
- **tile/gis geo extras**: only add `lon/lat` if recoverable without a GPU
  read-back at pick time; otherwise ship `{ dataIndex: null, tile }` and leave geo
  recovery to a follow-up.
```
