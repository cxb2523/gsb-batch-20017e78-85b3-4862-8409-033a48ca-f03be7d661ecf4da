// Relief (three.js, WebGL2): a surface whose height is a probability.
// Loaded with import() after the rest of the page, so three.js stays in a
// chunk of its own.
//
//              y: height = probability (0..1 → 0..H)
//              ▲
//              │      ▲ crest: the model is sure
//              │   ▁▂█▂▁        ▂▃▂▂ plateau: it hesitates
//   z: rows    └──────────────────────────► x: position of the viewed path,
//   (back = -z)                               the same axis as the Timeline
//
// Rows, along z (the camera starts on the +z side, so -z is the back):
//   Alternatives: candidate 0 (the most likely) at the back, the less likely
//                 ones in front of it, so the crest does not hide the plateau.
//   Layers:       the first lens layer in front, the last at the back.
//
// Geometry: a grid of `capacity × rows` vertices per surface, written in grid
// units (x = column + 0.5, y = height 0..1, z = row) and mapped to the world by
// the transform of one group, so the axis can compress as the path grows
// without touching the buffers. Index buffers are fixed for the capacity and
// `setDrawRange` shows the columns in use. Only the y of the changed columns
// and their tones are uploaded — and after the context is lost and comes back,
// every column in use once (relief-upload.ts), since the GPU lost them all.
//
// Look: almost black by default, lit only where there is something to see.
// Heights are sqrt(p) (relief-data.ts). Each vertex carries its model's
// colour, the doubt and the divergence of its column (0..1) and the height
// of the column's crest; the surface shader paints, from the height h:
//
//   ground    near black; the model's hue grows on the slopes (h^2.2, up
//             to about half of it on the crests),
//             shaded by a fixed light from the screen-space normal (no
//             normal buffer to keep up to date)
//   isolines  thin topographic lines every 0.1 of height, in the hue, fading
//             where the slope is too steep for them
//   doubt     the crest of a hesitant column turns near white, over 1, so
//             the bloom picks it up; a sure column's crest stays in its hue
//   magenta   a column where the models parted: a faint magenta trench and a
//             magenta crest, over 1 where they picked different tokens
//
// The other model's surface (Alternatives, two models) is only its isolines
// over a faint fill, so the front one shows through. The bloom's threshold
// is high: only white and magenta crests, the cut of the selected column and
// the light plane's edges glow. The floor is one quad whose shader draws a
// fine grid that fades away from the relief; the background is a faint radial
// glow over the panel colour, and a light fog dims what lies far from the
// camera.
//
//        background: COLOR.bg at the edges, a little lighter behind the relief
//      ┌───────────────────────────────────────────────┐
//      │            ░░▒▒▓▓ surface ▓▓▒▒░░              │
//      │   ·  ·  · ─┴──────────────────────┴─ ·  ·  ·  │  floor grid, fading
//      └───────────────────────────────────────────────┘
//
// Paints only when something changes (data, selection, size, the camera,
// animation 4) and only while the panel is visible. Nothing is allocated per
// frame, except the label styles.
//
// Framing (relief-data.ts reliefShape, fitDistance): the box's depth, height
// and the camera's elevation follow the panel's aspect; the camera looks at
// the box's centre from the distance where all its corners fit, at the front
// and at both ends of the automatic swing. It is fitted again on resize, on
// a change of source and on resetView(). Until the user takes the camera, a
// new fit also restores the default elevation and zoom of the new shape. The
// mouse can turn it up to ±60°, tilt it between almost top-down and almost
// level, and zoom within a range around the fitted distance.

import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  EdgesGeometry,
  Fog,
  Group,
  HalfFloatType,
  Line,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  SRGBColorSpace,
  UniformsLib,
  UniformsUtils,
  Vector2,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { Store } from '../store/store';
import { showWhitespace, tokenLabel } from '../store/text';
import type { View } from '../store/view';
import { ICONS } from './icons';
import {
  axisRows,
  fillProfile,
  fitDistance,
  growDuration,
  growFactor,
  RELIEF_W,
  ReliefData,
  reliefShape,
  type ReliefSource,
} from './relief-data';
import { ReliefUpload, planWrite } from './relief-upload';
import { Pace } from './pace';
import { COLOR, FONT, FONT_UI, MODEL_COLOR, rgba } from './theme';
import { axisSpan } from './timeline';

// World size of the relief: x across the positions, z across the rows, y up.
// The width is fixed; depth and height follow the shape of the panel (see
// reshape), so a long strip gets a low relief and the full screen a tall one.
const W = RELIEF_W;
// Horizontal field of view, degrees. The vertical one follows from the shape
// of the panel: fixing it instead would make a long strip a fisheye. Narrow
// enough that the far edge is not much shorter than the near one, so the
// relief fills a wide dock instead of shrinking to a trapezoid.
const FOV_X = 36;
// The fitted box takes this much of the view: less in height, so the axis
// labels under the front edge stay inside the panel.
const MARGIN_X = 0.94;
const MARGIN_Y = 0.86;
// The camera orbits by itself, slowly, swinging around the front between
// -sway and sway: seen from its end the relief is a sliver. The swing is
// short on a wide strip and wide on a tall panel (reliefShape).
// The swing eases out towards each end and back, like a pendulum; its
// speed follows its width, so a short swing is not a jitter.
const ORBIT_MIN = 0.008; // rad/s at the middle of the swing
const ORBIT_MAX = 0.026;
const ORBIT_EASE = 0.8; // how much slower at the ends
// What the mouse may do, so the view never gets lost.
const AZIMUTH_LIMIT = Math.PI / 3; // ±60° around the front
const POLAR_MIN = 0.22; // almost top-down
const POLAR_MAX = Math.PI / 2 - 0.05; // almost level, never under the floor
const ZOOM_IN = 0.4; // distance limits, times the fitted distance
const ZOOM_OUT = 1.8;
const RESET_MS = 520;
const LABEL_CHARS = 14;
const LABEL_GAP = 21; // CSS px between the centres of two layer labels
const LEADER = 8; // CSS px of the line from a layer label towards the plane
const PLANE_RISE = 1.08; // the light plane stands this much above height 1

// The surface's colours, in linear light, from the height h (0..1):
// hue × (GROUND + (TOP - GROUND)·h^RAMP), so the low ground stays near black
// but its shape still reads, and the slopes carry the hue without the sure
// crests (most of them) becoming a bright wall.
const GROUND = 0.03;
const TOP = 0.55;
const RAMP = 2.2;
// Shading: an ambient floor plus a light from up, front and left.
const AMBIENT = 0.5;
const LIGHT = new Vector3(-0.35, 0.85, 0.45).normalize();
// Doubt: from WHITE_FROM of the column's crest up, mixed towards WHITE (over
// 1, for the bloom) by up to WHITE_MIX times the column's doubt.
const WHITE_FROM = 0.78;
const WHITE = 1.35;
const WHITE_MIX = 0.8;
// Isolines: ISO_STEPS per unit of height, added as ISO_GAIN of the hue (under
// the bloom). Lines that would be wider than ISO_FADE of their spacing per
// pixel (a cliff) fade out; none on the flat ground under ISO_MIN.
const ISO_STEPS = 10;
const ISO_GAIN = 0.22;
const ISO_FADE = [0.12, 0.3] as const;
const ISO_MIN = 0.02;
// Cliffs: where the surface stands steep (its normal's y under STEEP[1]) it
// faces the camera as a wall; there it is dimmed to CLIFF_DIM except near
// the column's crest (from RIM of it), so the sure crests read as a thin
// skyline and not as a lit wall.
const STEEP = [0.2, 0.6] as const;
const CLIFF_DIM = 0.12;
const RIM = 0.9;
// Divergence d: the colour moves towards magenta by DIS_MIX·d, to DIS_LOW
// of it in the trench and DIS_LOW + DIS_GAIN·d at the crest, so that only a
// full divergence (different picks) goes over the bloom's threshold.
const DIS = new Color(COLOR.dis);
const DIS_LOW = 0.12;
const DIS_GAIN = 2.9;
const DIS_MIX = 0.85;
// The other model's surface: its isolines, over a fill this opaque.
const BACK_FILL = 0.06;
const BACK_LINE = 0.7;
// Bloom: strength, radius, luminance threshold. Over the threshold: white
// and magenta crests, the cut of the selected column and the plane's edges.
const BLOOM = [0.48, 0.35, 0.9] as const;

// The axis labels, in the floor's corners.
type AxisLabel = 'position' | 'back' | 'front';
const AXIS_LABELS: readonly AxisLabel[] = ['position', 'back', 'front'];

// ------------------------------------------------------------- shaders

// GLSL float literal.
const f = (v: number): string => (Number.isInteger(v) ? v.toFixed(1) : String(v));

// Attributes, per vertex but equal along a column: tone (rgb: the model's
// colour, linear; a: the column's doubt) and mark (x: the column's
// divergence; y: the height of its crest). LINES_ONLY: the other model's
// surface, isolines over a faint fill, without doubt or magenta.
const SURFACE_VERT = /* glsl */ `
attribute vec4 tone;
attribute vec2 mark;
varying vec4 vTone;
varying vec2 vMark;
varying float vH;
varying vec3 vWorld;
#include <common>
#include <fog_pars_vertex>
void main() {
  vTone = tone;
  vMark = mark;
  vH = position.y; // grid units: the height, growth included
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  vec4 mvPosition = viewMatrix * world;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const SURFACE_FRAG = /* glsl */ `
varying vec4 vTone;
varying vec2 vMark;
varying float vH;
varying vec3 vWorld;
#include <common>
#include <fog_pars_fragment>
// Thin lines every 1 / ISO_STEPS of height, about a pixel wide.
float isolines(float h) {
  float v = h * ${f(ISO_STEPS)};
  float w = fwidth(v);
  float d = abs(fract(v - 0.5) - 0.5) / max(w, 1e-5);
  return (1.0 - smoothstep(0.0, 1.0, d)) * (1.0 - smoothstep(${f(ISO_FADE[0])}, ${f(ISO_FADE[1])}, w)) * step(${f(ISO_MIN)}, h);
}
void main() {
  float h = clamp(vH, 0.0, 1.0);
  vec3 hue = vTone.rgb;
  float iso = isolines(h);
#ifdef LINES_ONLY
  vec3 c = hue * (0.35 + 0.65 * iso);
  float a = ${f(BACK_FILL)} + ${f(BACK_LINE)} * iso;
#else
  // Normal from the screen-space slope; a height field faces up.
  vec3 cr = cross(dFdx(vWorld), dFdy(vWorld));
  float len = length(cr);
  vec3 n = len > 1e-12 ? cr / len : vec3(0.0, 1.0, 0.0);
  if (n.y < 0.0) n = -n;
  float diffuse = max(dot(n, vec3(${f(LIGHT.x)}, ${f(LIGHT.y)}, ${f(LIGHT.z)})), 0.0);
  float shade = ${f(AMBIENT)} + ${f(1 - AMBIENT)} * diffuse;
  // Height relative to the column's crest: 1 on the crest.
  float top = vMark.y > 1e-3 ? clamp(h / vMark.y, 0.0, 1.0) : 0.0;
  float level = smoothstep(${f(STEEP[0])}, ${f(STEEP[1])}, n.y);
  float cliff = mix(mix(${f(CLIFF_DIM)}, 1.0, smoothstep(${f(RIM)}, 1.0, top)), 1.0, level);
  vec3 c = hue * (${f(GROUND)} + ${f(TOP - GROUND)} * pow(h, ${f(RAMP)})) * shade * cliff;
  float white = smoothstep(${f(WHITE_FROM)}, 1.0, top) * vTone.a;
  c = mix(c, vec3(${f(WHITE)}), white * ${f(WHITE_MIX)});
  c += hue * ${f(ISO_GAIN)} * iso * level; // on a cliff they would read as a fence
  vec3 dis = vec3(${f(DIS.r)}, ${f(DIS.g)}, ${f(DIS.b)}) * (${f(DIS_LOW)} + ${f(DIS_GAIN)} * vMark.x * top) * cliff;
  c = mix(c, dis, vMark.x * ${f(DIS_MIX)});
  float a = 1.0;
#endif
  gl_FragColor = vec4(c, a);
  #include <fog_fragment>
}
`;

// Floor: a fine grid, square cells of `cell` world units with a stronger line
// every fourth, aligned on the relief's front-left corner. Lines that crowd
// together in the distance fade out instead of shimmering, and the whole grid
// fades with the distance from the relief's outline.
const FLOOR_VERT = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const FLOOR_FRAG = /* glsl */ `
uniform vec2 halfSize;
uniform float cell;
uniform float fade;
uniform vec3 minor;
uniform vec3 major;
uniform vec3 glow;
varying vec3 vWorld;
float lines(vec2 q) {
  vec2 w = max(fwidth(q), vec2(1e-5));
  vec2 g = abs(fract(q - 0.5) - 0.5) / w; // px to the nearest line
  vec2 keep = 1.0 - smoothstep(0.12, 0.3, w);
  vec2 v = (1.0 - min(g, 1.0)) * keep;
  return max(v.x, v.y);
}
void main() {
  vec2 p = vWorld.xz;
  vec2 q = vec2(p.x + halfSize.x, p.y - halfSize.y) / cell;
  float mi = lines(q);
  float ma = lines(q * 0.25);
  vec2 o = max(abs(p) - halfSize, 0.0);
  float away = 1.0 - smoothstep(0.0, fade, length(o));
  float la = max(mi * 0.32, ma * 0.6) * away;
  vec3 lc = mix(minor, major, step(mi * 0.32, ma * 0.6));
  // A faint pool of light under the relief.
  vec2 r = p / (halfSize + vec2(fade * 0.5));
  float pa = 0.07 * exp(-2.2 * dot(r, r));
  float a = la + pa * (1.0 - la);
  vec3 c = (lc * la + glow * pa * (1.0 - la)) / max(a, 1e-4);
  gl_FragColor = vec4(c, a);
}
`;

// Light plane: a veil, brighter near the floor; its edges are lines.
const PLANE_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const PLANE_FRAG = /* glsl */ `
uniform vec3 color;
uniform float fill;
varying vec2 vUv;
void main() {
  float up = 1.0 - vUv.y;
  gl_FragColor = vec4(color, fill * (0.15 + 0.85 * up * up));
}
`;

function surfaceMaterial(linesOnly: boolean, offset: number): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: UniformsUtils.merge([UniformsLib.fog]),
    vertexShader: SURFACE_VERT,
    fragmentShader: SURFACE_FRAG,
    defines: linesOnly ? { LINES_ONLY: '' } : {},
    fog: true,
    side: DoubleSide,
    transparent: linesOnly,
    depthWrite: !linesOnly,
    // Pushed back so the lines on it never flicker; the other model's
    // further back still: where both coincide the front one shows, and the
    // other model shows where it stands above.
    polygonOffset: true,
    polygonOffsetFactor: offset,
    polygonOffsetUnits: offset,
  });
}

// A faint radial glow behind the relief, over the panel's colour: the edges
// are exactly COLOR.bg, so the canvas melts into the panel.
function backdrop(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const ctx = c.getContext('2d');
  if (ctx) {
    ctx.fillStyle = COLOR.bg;
    ctx.fillRect(0, 0, 256, 128);
    const g = ctx.createRadialGradient(128, 52, 0, 128, 52, 132);
    g.addColorStop(0, '#0d1730');
    g.addColorStop(0.45, '#0a1124');
    g.addColorStop(1, COLOR.bg);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 128);
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

export class Relief {
  private readonly renderer: WebGLRenderer;
  private readonly composer: EffectComposer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(FOV_X, 1, 0.5, 400);
  private readonly controls: OrbitControls;
  private readonly observer: ResizeObserver;
  private readonly reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  private readonly data = new ReliefData();
  private readonly fog = new Fog(COLOR.bg, 30, 60);

  // Grid units → world: x by the axis span, y by the height, z by the rows.
  private readonly grid = new Group();
  private readonly frontMat: ShaderMaterial;
  private readonly backMat: ShaderMaterial;
  private readonly lineMat: LineBasicMaterial;
  private readonly front: Mesh;
  private readonly back: Mesh;
  private readonly lines: LineSegments;
  private readonly profile: Line; // the selected column's cut, on the front surface
  private readonly outline: LineSegments;
  private readonly floor: Mesh;
  private readonly floorMat: ShaderMaterial;
  private readonly plane: Mesh; // the light plane at the selected position
  private readonly planeMat: ShaderMaterial;
  private readonly edgeMat: LineBasicMaterial;
  private readonly statics: { dispose(): void }[] = []; // geometries, materials, textures and passes

  // Buffers of the current layout (capacity × rows).
  private cap = 0;
  private rows = 0;
  private posF = new Float32Array(0);
  private toneF = new Float32Array(0);
  private posB = new Float32Array(0);
  private toneB = new Float32Array(0);
  private mark = new Float32Array(0); // shared by both surfaces
  private prof = new Float32Array(0);
  private readonly upload = new ReliefUpload(); // which columns still owe the GPU a write
  private attrs: BufferAttribute[] = []; // posF, toneF, posB, toneB, mark
  // The context came back: every column in use must reach the GPU again, on
  // the next sync (see onRestored).
  private reupload = false;

  private readonly tones = MODEL_COLOR.map((c) => new Color(c));
  private backTone = 1;
  private span = 1;
  private d = 4; // world depth (z) and height (y) of the relief
  private hh = 3;
  private elevation = 0.4; // default camera angle above the floor
  private sway = 0.1; // half the swing of the automatic orbit, radians
  private orbitSpeed = 0.1; // its speed at the middle, OrbitControls units
  private orbitDir = 1; // 1: towards -sway, -1: towards +sway
  private fitDist = 30; // fitted camera distance (0 until the first fit)
  private fitted = false;
  private user = false; // the user has moved the camera since the last default view
  private backFirst = true; // row 0 at the back (Alternatives)
  private shownSource: ReliefSource | null = null;

  // resetView(): the camera moving back to the fitted default.
  private resetT0 = -1; // -1: not moving
  private readonly from = { r: 0, phi: 0, theta: 0 };

  private key = '';
  private sel = -2;
  private pinned = false;
  private needs = true;
  private lost = false;
  private w = 0;
  private h = 0;
  private lastNow = 0;

  // Animation 4: the column growing from zero, or -1.
  private growCol = -1;
  private growK = 1;
  private growT0 = 0;
  private growDur = 0;
  private readonly pace = new Pace();

  // Layers: one chip per layer at the selected position.
  private readonly labels: HTMLElement[] = [];
  private readonly labelParts: HTMLElement[][] = []; // [layer, token, p] per chip
  private labelRows = 0;
  private readonly labelX: number[] = [];
  private readonly labelY: number[] = [];
  private readonly labelOrder: number[] = [];
  private readonly v = new Vector3();
  // Axis labels: what x and z mean, at the floor's corners.
  private readonly axis: HTMLElement[] = [];
  private readonly axisText: HTMLElement[] = [];
  private readonly axisW: number[] = []; // width of each axis label, read when its text changes

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly labelBox: HTMLElement,
    private readonly store: Store,
    private readonly view: View,
    private readonly source: () => ReliefSource,
  ) {
    // Throws without WebGL2; the caller leaves the panel empty then.
    this.renderer = new WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    const pr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(pr);
    const bg = backdrop();
    this.scene.background = bg;
    this.scene.fog = this.fog;
    this.statics.push(bg);

    // Bloom: only the bright crests glow. The render target keeps
    // multisampling, which the composer would otherwise lose.
    const target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(this.renderer, target);
    this.composer.setPixelRatio(pr);
    const passes = [
      new RenderPass(this.scene, this.camera),
      new UnrealBloomPass(new Vector2(1, 1), BLOOM[0], BLOOM[1], BLOOM[2]),
      new OutputPass(),
    ];
    for (const pass of passes) this.composer.addPass(pass);
    this.statics.push(...passes);

    this.frontMat = surfaceMaterial(false, 1);
    this.backMat = surfaceMaterial(true, 2);
    // Row lines on the front surface: a faint mesh that shows the rows.
    this.lineMat = new LineBasicMaterial({ color: COLOR.high, transparent: true, opacity: 0.06, depthWrite: false });
    this.front = new Mesh(new BufferGeometry(), this.frontMat);
    this.back = new Mesh(new BufferGeometry(), this.backMat);
    this.lines = new LineSegments(new BufferGeometry(), this.lineMat);
    // The cut of the selected column: a bright line over the surface, well
    // over 1 so the bloom makes it glow.
    const profMat = new LineBasicMaterial({ color: new Color(COLOR.high).multiplyScalar(2), transparent: true, depthWrite: false });
    this.profile = new Line(new BufferGeometry(), profMat);
    this.statics.push(profMat);
    this.back.renderOrder = 1;
    this.profile.renderOrder = 3;
    for (const o of [this.front, this.back, this.lines, this.profile]) {
      o.frustumCulled = false; // bounds change with every step
      o.visible = false; // until there is data (refresh)
      this.grid.add(o);
    }
    this.scene.add(this.grid);

    // The floor: a quad under the relief and well beyond it, a little under
    // y = 0 so the flat ground of the surface never fights it. Scaled by
    // reshape; drawn before everything else.
    const floorGeo = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.floorMat = new ShaderMaterial({
      uniforms: {
        halfSize: { value: new Vector2(W / 2, 2) },
        cell: { value: W / 40 },
        fade: { value: W * 0.22 },
        minor: { value: new Color(COLOR.lineStrong) },
        major: { value: new Color(COLOR.lineStrong).lerp(new Color(COLOR.muted), 0.35) },
        glow: { value: new Color(COLOR.a).lerp(new Color(COLOR.surface3), 0.6) },
      },
      vertexShader: FLOOR_VERT,
      fragmentShader: FLOOR_FRAG,
      transparent: true,
      depthWrite: false,
    });
    this.floor = new Mesh(floorGeo, this.floorMat);
    this.floor.position.y = -0.02;
    this.floor.renderOrder = -1;
    this.scene.add(this.floor);

    // The outline of the whole axis, as wide as the Timeline's: discreet.
    const outGeo = new BufferGeometry();
    const fx = 0.5; // a unit square, scaled by reshape
    const fz = 0.5;
    outGeo.setAttribute(
      'position',
      new BufferAttribute(
        new Float32Array([-fx, 0, -fz, fx, 0, -fz, fx, 0, -fz, fx, 0, fz, fx, 0, fz, -fx, 0, fz, -fx, 0, fz, -fx, 0, -fz]),
        3,
      ),
    );
    const outMat = new LineBasicMaterial({
      color: new Color(COLOR.lineStrong).lerp(new Color(COLOR.muted), 0.25),
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
    });
    this.outline = new LineSegments(outGeo, outMat);
    this.scene.add(this.outline);

    // The light plane: vertical, across the rows, a veil with glowing edges.
    const planeGeo = new PlaneGeometry(1, 1);
    const edgeGeo = new EdgesGeometry(planeGeo);
    this.planeMat = new ShaderMaterial({
      uniforms: {
        color: { value: new Color(COLOR.high) },
        fill: { value: 0.02 },
      },
      vertexShader: PLANE_VERT,
      fragmentShader: PLANE_FRAG,
      transparent: true,
      side: DoubleSide,
      depthWrite: false,
    });
    this.edgeMat = new LineBasicMaterial({
      // Over 1, so the bloom gives the edges a halo.
      color: new Color(COLOR.high).multiplyScalar(1.5),
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
    });
    this.plane = new Mesh(planeGeo, this.planeMat);
    this.plane.add(new LineSegments(edgeGeo, this.edgeMat));
    this.plane.rotation.y = Math.PI / 2; // its local x runs along z
    this.plane.renderOrder = 2;
    this.plane.visible = false;
    this.scene.add(this.plane);
    this.statics.push(floorGeo, this.floorMat, outGeo, outMat, planeGeo, edgeGeo, this.edgeMat);

    // Axis labels: small caps in the UI face; the position one carries an
    // arrow drawn as an icon. Styled here: the box is shared with the Layers
    // chips, and the panel's CSS only knows plain spans.
    for (let k = 0; k < AXIS_LABELS.length; k++) {
      const el = document.createElement('div');
      const st = el.style;
      st.position = 'absolute';
      st.left = '0';
      st.top = '0';
      st.display = 'flex';
      st.alignItems = 'center';
      st.gap = '6px';
      st.color = COLOR.muted;
      st.fontFamily = FONT_UI;
      st.fontSize = '11px';
      st.fontWeight = '500';
      st.whiteSpace = 'nowrap';
      st.lineHeight = '1';
      st.opacity = '0.8';
      st.visibility = 'hidden';
      const text = document.createElement('b');
      text.style.fontWeight = 'inherit';
      el.append(text);
      if (AXIS_LABELS[k] === 'position') el.append(arrowIcon());
      labelBox.append(el);
      this.axis.push(el);
      this.axisText.push(text);
    }

    // Camera: slow auto-orbit, turned and zoomed with the mouse, within
    // limits (see the header).
    this.camera.position.setFromSphericalCoords(30, Math.PI / 2 - this.elevation, 0);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = false;
    this.controls.minAzimuthAngle = -AZIMUTH_LIMIT;
    this.controls.maxAzimuthAngle = AZIMUTH_LIMIT;
    this.controls.minPolarAngle = POLAR_MIN;
    this.controls.maxPolarAngle = POLAR_MAX;
    this.controls.autoRotate = !this.reduced.matches;
    this.controls.addEventListener('change', this.onChange);
    this.controls.addEventListener('start', this.onStart);
    this.reduced.addEventListener('change', this.onReduced);

    canvas.addEventListener('webglcontextlost', this.onLost);
    canvas.addEventListener('webglcontextrestored', this.onRestored);

    this.observer = new ResizeObserver((entries) => {
      const r = entries[entries.length - 1].contentRect;
      this.resize(r.width, r.height);
    });
    this.observer.observe(canvas);
  }

  // The token at `index` has just been appended to the viewed path
  // (animation 4). Never queued: a new token ends the previous growth.
  born(now: number): void {
    const interval = this.pace.next(now);
    this.endGrowth();
    if (this.reduced.matches) return;
    const dur = growDuration(interval);
    if (dur <= 0) return;
    this.growCol = this.store.path.length - 1;
    this.growK = 0;
    this.growT0 = now;
    this.growDur = dur;
  }

  // The path was replaced: no growth.
  cancel(): void {
    this.endGrowth();
  }

  // Called every animation frame; `dirty` is store.dirty.relief.
  paint(now: number, dirty: boolean): void {
    const dt = this.lastNow > 0 ? Math.min(now - this.lastNow, 250) : 16;
    this.lastNow = now;
    if (dirty || this.reupload) this.sync(); // CPU side only: safe while the context is lost
    if (this.growCol >= 0) this.stepGrowth(now);
    if (this.lost || this.w < 1 || this.h < 1) return;
    // Hidden (the other tab of the dock): nothing moves and nothing is
    // drawn; the first visible frame renders.
    if (!this.visible()) {
      this.needs = true;
      return;
    }
    const c = this.controls;
    if (this.resetT0 >= 0) this.stepReset(now);
    // The automatic orbit turns back at each end of its swing, slowing
    // down near them. Far outside it (the user turned the camera) it only
    // drifts back.
    const az = c.getAzimuthalAngle();
    if (az > this.sway) this.orbitDir = 1;
    else if (az < -this.sway) this.orbitDir = -1;
    const u = Math.min(1, Math.abs(az) / this.sway);
    c.autoRotateSpeed = this.orbitDir * this.orbitSpeed * (1 - ORBIT_EASE * u * u);
    if (c.update(dt / 1000)) this.needs = true;
    if (!this.needs) return;
    this.needs = false;
    this.composer.render();
    if (this.labelRows > 0) this.placeLabels();
    this.placeAxis();
  }

  // Back to the fitted default view, then the automatic orbit again: a
  // short glide, or at once with prefers-reduced-motion.
  resetView(): void {
    if (!this.fitted || this.w < 1 || this.h < 1) {
      this.fitted = false; // the next resize starts from the default
      this.user = false;
      return;
    }
    const c = this.controls;
    this.from.r = this.camera.position.distanceTo(c.target);
    this.from.phi = c.getPolarAngle();
    this.from.theta = c.getAzimuthalAngle();
    if (this.reduced.matches) {
      this.lookFrom(this.fitDist, Math.PI / 2 - this.elevation, 0);
      this.endReset();
      return;
    }
    c.autoRotate = false;
    this.resetT0 = this.lastNow > 0 ? this.lastNow : performance.now();
    this.needs = true;
  }

  dispose(): void {
    this.observer.disconnect();
    this.controls.removeEventListener('change', this.onChange);
    this.controls.removeEventListener('start', this.onStart);
    this.controls.dispose();
    this.reduced.removeEventListener('change', this.onReduced);
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored);
    for (const o of [this.front, this.back, this.lines, this.profile]) o.geometry.dispose();
    for (const m of [this.frontMat, this.backMat, this.lineMat, this.planeMat]) m.dispose();
    for (const s of this.statics) s.dispose();
    this.composer.dispose();
    this.renderer.dispose();
    for (const l of this.labels) l.remove();
    this.labels.length = 0;
    this.labelParts.length = 0;
    for (const l of this.axis) l.remove();
    this.axis.length = 0;
    this.axisText.length = 0;
  }

  // ----------------------------------------------------------- internal

  private readonly onChange = (): void => {
    this.needs = true;
  };

  // The user takes the camera: a reset in course stops where it is, and
  // later fits keep the user's angles and zoom.
  private readonly onStart = (): void => {
    this.user = true;
    if (this.resetT0 >= 0) this.endReset();
  };

  private readonly onReduced = (): void => {
    this.controls.autoRotate = !this.reduced.matches && this.resetT0 < 0;
    if (this.reduced.matches) this.endGrowth();
    this.needs = true;
  };

  private readonly onLost = (): void => {
    this.lost = true;
    console.warn('Relief: the WebGL context was lost; the panel stays empty until it comes back.');
  };

  // The GPU lost every buffer with the context: three.js creates them again
  // from their arrays, but only for the attributes it is told are dirty. So
  // every column in use is written and marked again, once, whatever the
  // incremental writes before the loss — which is why the data cache is
  // invalidated too: the columns that did not change since would keep their
  // old values silently.
  private readonly onRestored = (): void => {
    this.lost = false;
    this.reupload = true;
    this.data.invalidate();
    this.needs = true;
  };

  private resize(w: number, h: number): void {
    this.w = w;
    this.h = h;
    if (w < 1 || h < 1) return;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.fov = (2 * Math.atan(Math.tan((FOV_X * Math.PI) / 360) / this.camera.aspect) * 180) / Math.PI;
    this.reshape();
    this.fit();
    this.needs = true;
  }

  // Depth, height, default elevation and swing for the shape of the panel
  // (reliefShape): a wide strip gets a shallow relief seen from higher up,
  // the full screen a deep and tall one.
  private reshape(): void {
    const shape = reliefShape(this.camera.aspect);
    this.d = shape.depth;
    this.hh = shape.height;
    this.elevation = shape.elevation;
    this.sway = shape.sway;
    const omega = Math.min(Math.max(shape.sway / 5, ORBIT_MIN), ORBIT_MAX); // rad/s
    this.orbitSpeed = (omega * 60) / (2 * Math.PI); // OrbitControls: turns per minute
    this.outline.scale.set(W, 1, this.d);
    // The floor reaches `fade` beyond the outline on every side.
    const fade = this.floorMat.uniforms.fade.value as number;
    this.floor.scale.set(W + 2 * fade, 1, this.d + 2 * fade);
    (this.floorMat.uniforms.halfSize.value as Vector2).set(W / 2, this.d / 2);
    this.plane.scale.set(this.d + 0.6, this.hh * PLANE_RISE, 1);
    this.plane.position.y = (this.hh * PLANE_RISE) / 2;
    this.place();
  }

  // Grid units → world. Column c is centred at (c + 0.5) / span of the width,
  // as on the Timeline.
  private place(): void {
    const g = this.grid;
    const dz = this.d / Math.max(this.rows - 1, 1);
    g.scale.set(W / this.span, this.hh, this.backFirst ? dz : -dz);
    g.position.set(-W / 2, 0, this.backFirst ? -this.d / 2 : this.d / 2);
  }

  // The fitted distance: the whole box (light plane included) in view from
  // the default elevation, at the front and at both ends of the swing. The
  // camera looks at the box's centre. Until the user moves the camera, a fit
  // puts it at the default elevation and distance (keeping where the
  // automatic orbit is); after that, it keeps the user's angles and zoom
  // relative to the fitted distance.
  private fit(): void {
    const c = this.controls;
    const tan = Math.tan((FOV_X * Math.PI) / 360);
    const tx = tan * MARGIN_X;
    const ty = (tan * MARGIN_Y) / this.camera.aspect;
    const hy = (this.hh * PLANE_RISE) / 2;
    const hz = this.d / 2 + 0.3;
    const phi = Math.PI / 2 - this.elevation;
    let dist = 0;
    for (const theta of [-this.sway, 0, this.sway]) {
      dist = Math.max(dist, fitDistance(W / 2, hy, hz, theta, phi, tx, ty));
    }
    const prev = this.fitDist;
    const keep = this.fitted && this.user;
    const zoom = keep ? this.camera.position.distanceTo(c.target) / prev : 1;
    const polar = keep ? c.getPolarAngle() : phi;
    const az = this.fitted ? c.getAzimuthalAngle() : 0;
    const azimuth = keep ? az : Math.min(Math.max(az, -this.sway), this.sway);
    this.fitDist = dist;
    c.target.set(0, hy, 0);
    c.minDistance = dist * ZOOM_IN;
    c.maxDistance = dist * ZOOM_OUT;
    this.camera.near = Math.max(0.1, dist * 0.01);
    this.camera.far = dist * ZOOM_OUT + 4 * W;
    this.camera.updateProjectionMatrix();
    // Fog: nothing at the relief's front, a little at its back, and the far
    // floor fades into the background.
    this.fog.near = dist * 0.92;
    this.fog.far = dist * 2.4;
    this.lookFrom(dist * Math.min(Math.max(zoom, ZOOM_IN), ZOOM_OUT), polar, azimuth);
    this.fitted = true;
  }

  // Puts the camera at distance `r`, polar angle `phi` and azimuth `theta`
  // around the target.
  private lookFrom(r: number, phi: number, theta: number): void {
    const c = this.controls;
    this.camera.position.setFromSphericalCoords(r, phi, theta).add(c.target);
    this.camera.lookAt(c.target);
    c.update();
    this.needs = true;
  }

  // One frame of resetView(): eased from where the camera was to the
  // default view.
  private stepReset(now: number): void {
    const k = Math.min(1, Math.max(0, (now - this.resetT0) / RESET_MS));
    const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2; // ease in-out cubic
    const fr = this.from;
    const phi = Math.PI / 2 - this.elevation;
    this.lookFrom(fr.r + (this.fitDist - fr.r) * e, fr.phi + (phi - fr.phi) * e, fr.theta * (1 - e));
    if (k >= 1) this.endReset();
  }

  private endReset(): void {
    this.resetT0 = -1;
    this.user = false;
    this.controls.autoRotate = !this.reduced.matches;
    this.needs = true;
  }

  // Whether the canvas can be seen: not under visibility: hidden (the other
  // tab of the dock). Browsers without checkVisibility always draw.
  private visible(): boolean {
    const c = this.canvas;
    return typeof c.checkVisibility !== 'function' || c.checkVisibility({ visibilityProperty: true });
  }

  // Data and selection, after dirty.relief.
  private sync(): void {
    const s = this.store;
    const source = this.source();
    const key = `${s.pathEpoch}:${s.path.length}:${s.framesApplied}:${s.front}:${s.twoModels}:${source}`;
    let moved = false;
    // After a restore the key is unchanged but every column must be sent
    // again, so refresh runs for that too.
    if (key !== this.key || this.reupload) {
      this.key = key;
      this.refresh(source);
      moved = true;
      // A new source is a new view: frame it again.
      if (this.shownSource !== null && this.data.source !== this.shownSource) this.resetView();
      this.shownSource = this.data.source;
    }
    const sel = this.view.selected();
    const pinned = this.view.pinnedIndex() !== null;
    if (moved || sel !== this.sel || pinned !== this.pinned) {
      this.sel = sel;
      this.pinned = pinned;
      this.placePlane();
      this.writeLabels();
      this.needs = true;
    }
  }

  // Heights from the store; uploads only the columns that changed, except
  // for a new layout or a context restore, which send every column.
  private refresh(source: ReliefSource): void {
    const s = this.store;
    const d = this.data;
    d.update(s, source);
    this.span = axisSpan(s.path.length, s.branches());
    this.backTone = s.other;
    this.backFirst = d.source === 'alternatives';
    const relaid = d.capacity !== this.cap || d.rows !== this.rows;
    const restored = this.reupload;
    this.reupload = false;
    if (relaid) {
      // A new layout, for a new source, row count or model in front: every
      // column is written for it. The arrays are new, so three.js creates
      // their buffers whole on this frame's draw — no range is needed.
      this.layout(d.capacity, d.rows);
    }
    // A layout or a restore writes every column in use; otherwise only those
    // the data marked. (A restore that arrives with a new layout is satisfied
    // by the new arrays' whole upload.)
    const w = planWrite(relaid, restored, d.from, d.to, d.cols);
    this.write(w.from, w.to, w.send);

    const cols = d.cols;
    const rows = d.rows;
    const quads = cols > 1 && rows > 1 ? (cols - 1) * (rows - 1) * 6 : 0;
    this.front.geometry.setDrawRange(0, quads);
    this.back.geometry.setDrawRange(0, quads);
    this.lines.geometry.setDrawRange(0, cols > 1 ? (cols - 1) * rows * 2 : 0);
    // Fewer than two rows or columns make no surface.
    this.front.visible = this.lines.visible = quads > 0;
    this.back.visible = quads > 0 && s.twoModels && d.source === 'alternatives';

    this.place();
    this.needs = true;
  }

  // New buffers for `cap` columns of `rows` rows. x and z never change.
  private layout(cap: number, rows: number): void {
    this.cap = cap;
    this.rows = rows;
    const n = cap * rows;
    this.posF = new Float32Array(n * 3);
    this.posB = new Float32Array(n * 3);
    this.toneF = new Float32Array(n * 4);
    this.toneB = new Float32Array(n * 4);
    this.mark = new Float32Array(n * 2);
    for (let c = 0; c < cap; c++) {
      for (let r = 0; r < rows; r++) {
        const v = (c * rows + r) * 3;
        this.posF[v] = this.posB[v] = c + 0.5;
        this.posF[v + 2] = this.posB[v + 2] = r;
      }
    }

    // Two triangles per cell, and a line along each row between columns,
    // both column by column so that the first columns are a prefix.
    const cells = Math.max(cap - 1, 0) * Math.max(rows - 1, 0);
    const tri = new Uint32Array(cells * 6);
    let k = 0;
    for (let c = 0; c + 1 < cap; c++) {
      for (let r = 0; r + 1 < rows; r++) {
        const a = c * rows + r;
        const b = a + rows; // same row, next column
        tri[k++] = a;
        tri[k++] = b;
        tri[k++] = a + 1;
        tri[k++] = a + 1;
        tri[k++] = b;
        tri[k++] = b + 1;
      }
    }
    const seg = new Uint32Array(Math.max(cap - 1, 0) * rows * 2);
    k = 0;
    for (let c = 0; c + 1 < cap; c++) {
      for (let r = 0; r < rows; r++) {
        seg[k++] = c * rows + r;
        seg[k++] = (c + 1) * rows + r;
      }
    }

    const dyn = (a: Float32Array, size: number): BufferAttribute => new BufferAttribute(a, size).setUsage(DynamicDrawUsage);
    const pf = dyn(this.posF, 3);
    const tf = dyn(this.toneF, 4);
    const pb = dyn(this.posB, 3);
    const tb = dyn(this.toneB, 4);
    const mk = dyn(this.mark, 2);
    const triIndex = new BufferAttribute(tri, 1);
    this.attrs = [pf, tf, pb, tb, mk];
    // New arrays: three.js makes each buffer whole on the next draw. The
    // upload ranges start from an empty slate too, so nothing of the old
    // layout can shrink a write of the new one.
    this.upload.layout(this.attrs, cap, rows);

    const front = new BufferGeometry();
    front.setAttribute('position', pf);
    front.setAttribute('tone', tf);
    front.setAttribute('mark', mk);
    front.setIndex(triIndex);
    const back = new BufferGeometry();
    back.setAttribute('position', pb);
    back.setAttribute('tone', tb);
    back.setAttribute('mark', mk); // unused by its shader; shared, no upload of its own
    back.setIndex(triIndex);
    const lines = new BufferGeometry();
    lines.setAttribute('position', pf); // on the front surface
    lines.setIndex(new BufferAttribute(seg, 1));
    this.prof = new Float32Array(rows * 3);
    const profile = new BufferGeometry();
    profile.setAttribute('position', new BufferAttribute(this.prof, 3).setUsage(DynamicDrawUsage));

    this.front.geometry.dispose();
    this.back.geometry.dispose();
    this.lines.geometry.dispose();
    this.profile.geometry.dispose();
    this.front.geometry = front;
    this.back.geometry = back;
    this.lines.geometry = lines;
    this.profile.geometry = profile;
  }

  // Writes heights, tones and marks of columns [from, to) into the buffers.
  // `send` says what of them must reach the GPU: nothing (the arrays of a new
  // layout are uploaded whole on their first draw), their own range, or every
  // column in use (a context restore).
  private write(from: number, to: number, send: 'none' | 'columns' | 'all' = 'columns'): void {
    const d = this.data;
    const rows = this.rows;
    to = Math.min(to, d.cols, this.cap);
    if (rows === 0) return;
    if (send === 'all') {
      // A restore: the whole grid, even when this frame writes no column
      // (a path of zero length has nothing to draw, but its buffers must not
      // keep the ranges of the lost frames).
      this.upload.restore(d.cols);
    }
    if (to <= from) {
      this.needs = true;
      return;
    }
    const bt = this.tones[this.backTone];
    for (let c = from; c < to; c++) {
      const k = c === this.growCol ? this.growK : 1;
      const ft = this.tones[d.tone[c]];
      const doubt = d.doubt[c];
      const div = d.div[c];
      let crest = 0;
      for (let r = 0; r < rows; r++) crest = Math.max(crest, d.front[c * rows + r]);
      crest *= k;
      for (let r = 0; r < rows; r++) {
        const i = c * rows + r;
        const v = i * 3;
        this.posF[v + 1] = d.front[i] * k;
        this.posB[v + 1] = d.back[i] * k;
        tint(this.toneF, i * 4, ft, doubt);
        tint(this.toneB, i * 4, bt, 0);
        this.mark[i * 2] = div;
        this.mark[i * 2 + 1] = crest;
      }
    }
    if (send === 'columns') this.upload.mark(from, to, d.cols);
    if (this.sel >= from && this.sel < to) this.writeProfile();
    this.needs = true;
  }

  private stepGrowth(now: number): void {
    const c = this.growCol;
    this.growK = growFactor(now - this.growT0, this.growDur);
    this.write(c, c + 1);
    if (this.growK >= 1) this.growCol = -1;
    this.needs = true;
  }

  // Ends the growth at once, with the column at its full height.
  private endGrowth(): void {
    const c = this.growCol;
    if (c < 0) return;
    this.growCol = -1;
    this.growK = 1;
    this.write(c, c + 1);
  }

  // World x of the centre of position `i`.
  private xOf(i: number): number {
    return -W / 2 + ((i + 0.5) * W) / this.span;
  }

  // World z of row `r`.
  private zOf(r: number): number {
    const dz = this.d / Math.max(this.rows - 1, 1);
    return this.backFirst ? -this.d / 2 + r * dz : this.d / 2 - r * dz;
  }

  // The light plane: moved in the same frame as the selection of the Stream
  // (animation 5), with the cut of the surface at that position.
  private placePlane(): void {
    const sel = this.sel;
    this.plane.visible = sel >= 0 && sel < this.data.cols;
    this.profile.visible = this.plane.visible && this.front.visible;
    if (!this.plane.visible) return;
    this.plane.position.x = this.xOf(sel);
    const u = this.planeMat.uniforms;
    u.fill.value = this.pinned ? 0.035 : 0.015;
    this.edgeMat.opacity = this.pinned ? 0.7 : 0.35;
    this.writeProfile();
  }

  // The front surface's heights at the selected column, in grid units. A
  // column that cannot be drawn leaves no point behind: the range is emptied,
  // so no point of an older layout (another row count) survives the switch.
  private writeProfile(): void {
    const sel = this.sel;
    const d = this.data;
    const rows = this.rows;
    const attr = this.profile.geometry.getAttribute('position') as BufferAttribute | undefined;
    if (!attr) return; // no layout yet
    if (sel < 0 || sel >= d.cols || this.prof.length < rows * 3) {
      // A column that cannot be drawn leaves no point behind: no point of an
      // older layout (another row count) survives the switch.
      this.profile.geometry.setDrawRange(0, 0);
      attr.needsUpdate = true;
      return;
    }
    const k = sel === this.growCol ? this.growK : 1;
    const n = fillProfile(this.prof, d.front, rows, sel, d.cols, k);
    this.profile.geometry.setDrawRange(0, n);
    attr.needsUpdate = true;
  }

  // The axis labels at the floor's corners: "position" and an arrow under
  // the front edge, and what the rows mean at the back and front of the
  // left edge.
  private placeAxis(): void {
    const show = this.front.visible;
    for (let k = 0; k < this.axis.length; k++) {
      const el = this.axis[k];
      if (!show) {
        el.style.visibility = 'hidden';
        continue;
      }
      const which = AXIS_LABELS[k];
      const rows = axisRows(this.data.source);
      // Back of the box is -z. Alternatives: the most likely row at the
      // back; Layers: the first layer in front, the last at the back.
      const text = which === 'position' ? 'position' : which === 'back' ? rows.back : rows.front;
      const t = this.axisText[k];
      if (t.textContent !== text) {
        t.textContent = text;
        this.axisW[k] = el.offsetWidth;
      }
      if (which === 'position') this.v.set(-W / 2 + W * 0.04, 0, this.d / 2);
      else this.v.set(-W / 2, 0, which === 'back' ? -this.d / 2 : this.d / 2);
      this.v.project(this.camera);
      if (this.v.z > 1 || Math.abs(this.v.x) > 1.1 || Math.abs(this.v.y) > 1.1) {
        el.style.visibility = 'hidden';
        continue;
      }
      el.style.visibility = '';
      const px = Math.round(((this.v.x + 1) / 2) * this.w);
      const py = Math.round(((1 - this.v.y) / 2) * this.h);
      // The row labels go left of the corner; on a narrow panel the box
      // reaches the edge, so they are kept inside it, over the floor. The
      // position label stays inside the bottom edge.
      el.style.transform =
        which === 'position'
          ? `translate(${px}px, ${Math.min(py + 8, this.h - 16)}px)`
          : `translate(${Math.max(6, px - 10 - (this.axisW[k] ?? 0))}px, ${py}px) translateY(-50%)`;
    }
  }

  // Layers: a chip "L<layer> <token> <top_p>" per layer at the selected
  // position. Texts change here; positions follow the camera in placeLabels().
  private writeLabels(): void {
    const s = this.store;
    const d = this.data;
    const sel = this.sel;
    const lens = d.source === 'layers' && sel >= 0 && sel < d.cols ? (s.decision(sel)?.lens ?? null) : null;
    const layers = s.hello?.lens.layers ?? [];
    const n = lens ? Math.min(lens.topId.length, d.rows) : 0;
    while (this.labels.length < n) this.addChip();
    const tone = sel >= 0 && sel < d.cols ? MODEL_COLOR[d.tone[sel]] : COLOR.a;
    for (let r = 0; r < this.labels.length; r++) {
      const el = this.labels[r];
      if (!lens || r >= n) {
        el.style.display = 'none';
        continue;
      }
      const v = s.vocab.get(lens.topId[r]);
      const text = v ? showWhitespace(tokenLabel(v.bytes)) : `#${lens.topId[r]}`;
      const short = text.length > LABEL_CHARS ? text.slice(0, LABEL_CHARS - 1) + '…' : text;
      const [layer, token, p] = this.labelParts[r];
      layer.textContent = `L${layers[r] ?? r}`;
      token.textContent = short;
      p.textContent = `${Math.round(lens.topP[r] * 100)}%`;
      p.style.color = tone;
      el.style.display = 'flex';
    }
    this.labelRows = n;
    this.needs = true;
  }

  // A rounded chip, almost opaque so the surface does not show through its
  // text: the layer in the UI face, the token in the monospaced one, the
  // probability in the model's colour. A short line on its left points to
  // the plane, so the chip reads as a label of that point.
  private addChip(): void {
    const el = document.createElement('div');
    const st = el.style;
    st.position = 'absolute';
    st.left = '0';
    st.top = '0';
    st.display = 'none';
    st.alignItems = 'center';
    st.gap = '6px';
    st.height = '18px';
    st.padding = '0 8px 0 7px';
    st.boxSizing = 'border-box';
    st.borderRadius = '8px';
    st.border = `1px solid ${rgba(COLOR.lineStrong, 0.9)}`;
    st.background = rgba(COLOR.surface, 0.94);
    st.boxShadow = `0 2px 10px ${rgba(COLOR.bg, 0.5)}`;
    st.whiteSpace = 'pre';
    st.lineHeight = '16px';
    const leader = document.createElement('span');
    const ls = leader.style;
    ls.position = 'absolute';
    ls.left = `${-LEADER - 1}px`; // outside the 1px border
    ls.top = '50%';
    ls.width = `${LEADER}px`;
    ls.height = '1px';
    ls.background = rgba(COLOR.muted, 0.55);
    el.append(leader);
    const part = (font: string, size: string, weight: string, color: string): HTMLElement => {
      const b = document.createElement('b');
      const bs = b.style;
      bs.fontFamily = font;
      bs.fontSize = size;
      bs.fontWeight = weight;
      bs.color = color;
      bs.fontVariantNumeric = 'tabular-nums';
      el.append(b);
      return b;
    };
    const parts = [part(FONT_UI, '10.5px', '600', COLOR.muted), part(FONT, '12px', '400', COLOR.high), part(FONT_UI, '10.5px', '600', COLOR.a)];
    this.labelBox.append(el);
    this.labels.push(el);
    this.labelParts.push(parts);
  }

  // Each chip next to the plane, at its layer's height. Where the layers lie
  // close on the screen the chips are spread, top to bottom, so that none
  // covers another; when they cannot all fit in the panel's height, only
  // every k-th layer keeps its chip (the last layer always does).
  private placeLabels(): void {
    const d = this.data;
    const sel = this.sel;
    const x = this.xOf(sel);
    const k = sel === this.growCol ? this.growK : 1;
    const n = this.labelRows;
    const fit = Math.max(1, Math.floor((this.h - 8) / LABEL_GAP));
    const stride = Math.ceil(n / fit);
    const ys = this.labelY;
    const order = this.labelOrder;
    order.length = 0;
    for (let r = 0; r < n; r++) {
      const el = this.labels[r];
      this.v.set(x, d.front[sel * d.rows + r] * k * this.hh, this.zOf(r)).project(this.camera);
      if (this.v.z > 1 || (n - 1 - r) % stride !== 0) {
        el.style.visibility = 'hidden';
        continue;
      }
      el.style.visibility = '';
      this.labelX[r] = ((this.v.x + 1) / 2) * this.w;
      ys[r] = ((1 - this.v.y) / 2) * this.h;
      order.push(r);
    }
    order.sort((a, b) => ys[a] - ys[b]);
    for (let i = 1; i < order.length; i++) {
      ys[order[i]] = Math.max(ys[order[i]], ys[order[i - 1]] + LABEL_GAP);
    }
    // Pushed past the bottom: the whole column moves up, but not past the top.
    const last = order.length > 0 ? ys[order[order.length - 1]] - (this.h - LABEL_GAP / 2) : 0;
    const over = order.length > 0 ? Math.min(last, ys[order[0]] - LABEL_GAP / 2) : 0;
    for (const r of order) {
      const py = over > 0 ? ys[r] - over : ys[r];
      this.labels[r].style.transform = `translate(${Math.round(this.labelX[r] + LEADER + 2)}px, ${Math.round(py)}px) translateY(-50%)`;
    }
  }
}

// Writes the tone of a vertex at offset `v` (4 floats): the model's colour,
// in linear light, and the column's doubt.
function tint(out: Float32Array, v: number, tone: Color, doubt: number): void {
  out[v] = tone.r;
  out[v + 1] = tone.g;
  out[v + 2] = tone.b;
  out[v + 3] = doubt;
}

// The arrow of the position axis: the icon set's arrowRight, small.
function arrowIcon(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', ICONS.arrowRight);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.5');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}
