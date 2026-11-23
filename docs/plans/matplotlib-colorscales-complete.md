# Plan: Complete the matplotlib colorscale set (incl. native qualitative mode)

## Overview

Gladly currently registers 73 of matplotlib's named colormaps in
`src/colorscales/MatplotlibColorscales.js`. This plan adds the remaining ones and,
to do the categorical group correctly, adds a **native discrete (qualitative)
colorscale mode** to the engine.

The missing maps, grouped:

- **Trivial / exact** — `binary`, `gist_yarg`, `gist_gray`
- **Smooth, approximable** — `berlin`, `managua`, `vanimo` (diverging, mpl ≥3.10);
  `gist_stern`, `gist_ncar` (miscellaneous)
- **Qualitative (discrete)** — `Pastel1`, `Pastel2`, `Paired`, `Accent`, `Dark2`,
  `Set1`, `Set2`, `Set3`, `tab10`, `tab20`, `tab20b`, `tab20c`
- **High-frequency repeating** — `flag`, `prism` (see Open Decisions)

## What exists

Read against `master` (`550a194`).

- **`src/colorscales/ColorscaleRegistry.js`** — the whole engine.
  - `registerColorscale(name, stops, nanColor, unselectedStops, unselectedNanColor)`
    stores `stops` (`[[t,r,g,b],…]`) in a `colorscales` Map plus parallel NaN/
    unselected Maps; bumps `colorscalesVersion`.
  - `buildColorscaleTexture()` collects **every unique `t`** across **all** 1D
    colorscales into one sorted `gridT` (length `N`), then pre-evaluates each
    colorscale at each grid point with linear interpolation (`fillRow`). Returns a
    float texture: `width = N + 1` (last column = NaN color), `height = numCs * 2`
    (row `cs*2` = selected, `cs*2+1` = unselected/dimmed).
  - `buildColorGlsl()` emits `const float CS_T[N]`, `const int CS_NAN_COL`, and
    `map_color(int cs, vec2 range, float value)`. `map_color` normalises `value` to
    `t ∈ [0,1]`, finds the grid segment `i` via an `N-2`-deep nested ternary
    (`chain`), and `mix()`es the two adjacent texels. Dynamic indexing of the
    `const` array `CS_T[i]` is already relied upon.
  - `getColorscaleIndex(name)` returns the colorscale's **insertion-order index**
    into `colorscales` (negative indices for 2D maps).
- **Consumers (all automatic — no changes needed):**
  - `src/core/Plot.js:149,171` — schema `enum`s spread `getRegisteredColorscales().keys()`.
  - `src/floats/AxisMenu.js:208` — menu list spreads the same keys.
  - `src/layers/ColorbarLayer.js:29` — colorbar fragment shader calls
    `map_color(colorscale, range, v)`. Any branch added inside `map_color` is used
    by the colorbar automatically — it is the live smoke test for discreteness.
  - `src/axes/AxisRegistry.js:245` / `Plot.js:929` — resolve a colorscale name to
    its index and pass it as the `colorscale` uniform.

### The core wrinkle

Because the `t`-grid is **global and shared**, a colorscale's stops are not local:
every stop adds a grid column and a ternary level for *all* colorscales. Hard
categorical bands can only be faked with epsilon-offset stop pairs
(`0.0999`/`0.1000`), which would push `N` from ~30 to ~180 and deepen the shared
ternary for all 70+ maps. Native discrete mode avoids this entirely by keeping
categorical maps **out of the shared grid**.

## Design

### Part A — native discrete mode (engine change, `ColorscaleRegistry.js` only)

A discrete colorscale stores `K` band colors and renders as `K` flat bands with no
interpolation: band `k` covers `t ∈ [k/K, (k+1)/K)`.

**1. Registration (~5 lines).** New parallel map and registrar:

```js
const colorscaleDiscrete = new Map()  // name → K (band count); absent ⇒ continuous

export function registerDiscreteColorscale(name, colors, nanColor = [0.5,0.5,0.5],
                                           unselectedColors = null, unselectedNanColor = null) {
  // colors: [[r,g,b], …] length K
  // Store a representative stops entry so the map keeps its slot in the shared
  // index/enum space and continuous fallbacks still work (band centres):
  const stops = colors.map((c, k) => [(k + 0.5) / colors.length, ...c])
  registerColorscale(name, stops, nanColor,
    unselectedColors ? unselectedColors.map((c,k)=>[(k+0.5)/unselectedColors.length, ...c]) : null,
    unselectedNanColor)
  colorscaleDiscrete.set(name, colors.length)
}
```

**2. `buildColorscaleTexture()` (~20 lines).**
- When building `tSet`, **skip** names in `colorscaleDiscrete` → zero shared-grid
  growth from categorical maps.
- Lay out a tail block after the NaN column: for each discrete map in insertion
  order, assign `CS_DISCRETE_OFF[csIdx] = N + 1 + runningOffset`, advance by `K`.
  `totalDiscrete = Σ K`. `width = N + 1 + totalDiscrete`.
- In the per-row fill, after the grid + NaN columns, if the map is discrete write
  its `K` band colors into its tail columns, applying the same dim logic for the
  unselected row that `fillRow` already uses (`r*0.4+0.48`, `a=0.4`).

**3. `buildColorGlsl()` (~10 lines).** Emit two constant arrays and an early branch:

```glsl
const int CS_DISCRETE_K[NUMCS]   = int[NUMCS](…);   // 0 ⇒ continuous
const int CS_DISCRETE_OFF[NUMCS] = int[NUMCS](…);   // tail column base
// inside map_color, after the NaN check and t computation:
if (CS_DISCRETE_K[cs] > 0) {
  int K = CS_DISCRETE_K[cs];
  int k = clamp(int(floor(t * float(K))), 0, K - 1);
  return texelFetch(u_colorscale_tex, ivec2(CS_DISCRETE_OFF[cs] + k, row), 0);
}
// …existing continuous ternary path unchanged…
```

The branch is additive; the continuous path is untouched. Dynamic indexing of
`CS_DISCRETE_K[cs]` matches the existing `CS_T[i]` pattern, so no new driver
requirement. `map_color_s` (log/alpha) and `map_color_s_2d` (2D blend) call
`map_color`/`gladly_map_color_raw` and inherit the branch for free; a discrete map
used on a log axis simply bands in log space, which is correct.

**Memory:** `+totalDiscrete` columns (~144 for the 12 maps) × height ≈ ~2 MB. Negligible.

### Part B — data (the colorscale definitions)

Append `reg(...)` / `registerDiscreteColorscale(...)` blocks to
`MatplotlibColorscales.js`, grouped under existing section comments:

- **Trivial** — `binary`/`gist_yarg` = 2-stop white→black; `gist_gray` = 2-stop
  black→white (alias of `gray`). Hand-written, exact.
- **Smooth** — `berlin`, `managua`, `vanimo`, `gist_stern`, `gist_ncar`: 8–12
  stops. `gist_stern` needs an extra low-end stop for its kink; `gist_ncar` a few
  more for its wiggles. Sampled, not hand-typed (see Open Decision 2).
- **Qualitative** — `registerDiscreteColorscale(name, [[r,g,b],…])` with the exact
  N listed colors (sizes: Pastel1 9, Pastel2 8, Paired 12, Accent 8, Dark2 8,
  Set1 9, Set2 8, Set3 12, tab10 10, tab20 20, tab20b 20, tab20c 20).

### Part C — verification

1. Example page loads with no shader-compile error (the whole generated GLSL
   either compiles or the plot fails loudly).
2. Each new name renders in a colorbar float: discrete maps show crisp bands,
   smooth maps show gradients. Spot-check a discrete map on a `log` axis.
3. Log `getRegisteredColorscales().size` and the texture `width`/`N` before/after
   to confirm `N` (shared grid) is unchanged by the qualitative additions.

## Open Decisions (confirm before implementation)

1. **`flag` / `prism`** — high-frequency repeating patterns with no faithful stop
   representation and no 1D procedural path today. **Recommendation: skip them**
   (niche in a geophysics app; a faithful version would need a new 1D-GLSL-formula
   mechanism — out of scope). Alternative: add that procedural path later as its
   own plan.
2. **Data sourcing** — **Recommendation: a small generator** (`tools/gen_colorscales.py`)
   that samples matplotlib and prints the `reg`/`registerDiscreteColorscale`
   blocks, so values are faithful and reproducible. Prerequisite: matplotlib is
   currently broken in this environment (NumPy 2.x ABI mismatch) — fix via a venv
   with `numpy<2`, or read mpl's `_cm.py`/`_cm_listed.py`/`_cm_bivar` data tables
   directly without importing the broken C extension. Alternative: hand-curate
   from published values (faster start, error-prone, not reproducible).

## Files touched

- `src/colorscales/ColorscaleRegistry.js` — discrete mode (Part A).
- `src/colorscales/MatplotlibColorscales.js` — new definitions (Part B).
- `tools/gen_colorscales.py` — new, if Decision 2 = generator.

No other files change: schema enums, axis menu, indices, and colorbar all derive
from the registry and `map_color`.
