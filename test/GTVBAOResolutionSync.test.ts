import assert from "node:assert/strict";
import { Color, PerspectiveCamera, Vector2 } from "three";
import { uniform } from "three/tsl";
import { test } from "vitest";
import GTVBAONode from "../src/GTVBAONode.js";

type MipTexture = {
  image: { width: number; height: number };
  addEventListener(type: "dispose", listener: () => void): void;
};
type MipNode = { value: MipTexture };
type RendererCall = { type: string; mipLevel0?: number[] };
type FakeRenderer = ReturnType<typeof createRecordingRenderer>;

function createNode(options: ConstructorParameters<typeof GTVBAONode>[3] = {}) {
  return new GTVBAONode(uniform(1) as never, null, new PerspectiveCamera(), options);
}

function mipNodes(node: GTVBAONode) {
  return node.getDepthMipNodes() as unknown as MipNode[];
}

function mipSizes(node: GTVBAONode) {
  return mipNodes(node).map(({ value }) => [value.image.width, value.image.height]);
}

function aoTargetSize(node: GTVBAONode) {
  const target = (node as unknown as { _aoRenderTarget: { width: number; height: number } })._aoRenderTarget;
  return [target.width, target.height];
}

function upsampleSwitch(node: GTVBAONode) {
  return (node as unknown as { _upsampleEnabled: { value: number } })._upsampleEnabled.value;
}

function prefilterTextureCount(node: GTVBAONode) {
  return (node as unknown as { _depthPrefilter: { _textures: unknown[] } })._depthPrefilter._textures.length;
}

// A renderer stand-in that records the calls GTVBAONode makes each frame, so
// the tests can assert what the node asked for without a GPU. `onCompute` lets
// a test snapshot node state at the moment the depth prefilter dispatches.
function createRecordingRenderer(width: number, height: number) {
  const calls: RendererCall[] = [];
  const fake = {
    autoClear: true,
    outputColorSpace: "",
    toneMapping: 0,
    toneMappingExposure: 1,
    onCompute: null as null | (() => number[]),
    calls,
    compute() {
      calls.push({ type: "compute", mipLevel0: fake.onCompute?.() });
    },
    getActiveCubeFace: () => 0,
    getActiveMipmapLevel: () => 0,
    getClearAlpha: () => 1,
    getClearColor: (target = new Color()) => target.set(0),
    getDrawingBufferSize: (target: Vector2) => target.set(fake.width, fake.height),
    getMRT: () => null,
    getPixelRatio: () => 1,
    getRenderObjectFunction: () => null,
    getRenderTarget: () => null,
    getScissorTest: () => false,
    height,
    render() {
      calls.push({ type: "render" });
    },
    setClearColor() {},
    setMRT() {},
    setPixelRatio() {},
    setRenderObjectFunction() {},
    setRenderTarget(target: unknown) {
      calls.push({ type: "setRenderTarget" });
    },
    setScissorTest() {},
    setViewport(width: number, height: number) {
      fake.width = width;
      fake.height = height;
    },
    width,
  };
  return fake;
}

function frame(node: GTVBAONode, renderer: FakeRenderer, frameId: number) {
  (node as unknown as { updateBefore(frame: unknown): void }).updateBefore({ frameId, renderer });
}

test("GTVBAONode applies prefilter size, AO target size and the upsample switch in the same frame", () => {
  const node = createNode();
  const renderer = createRecordingRenderer(320, 180);
  renderer.onCompute = () => mipSizes(node)[0];

  frame(node, renderer, 0);
  assert.deepEqual(mipSizes(node), [[320, 180], [160, 90], [80, 45], [40, 23], [20, 12]]);
  assert.deepEqual(aoTargetSize(node), [320, 180]);
  assert.equal(upsampleSwitch(node), 0);

  // Switching the resolution scale: the very first frame afterwards must
  // already dispatch the prefilter against the new MIP sizes, never the old.
  node.resolutionScale = 0.5;
  frame(node, renderer, 1);
  const computeCalls = renderer.calls.filter((call) => call.type === "compute");
  assert.equal(computeCalls.length, 2);
  assert.deepEqual(computeCalls[1].mipLevel0, [160, 90]);
  assert.deepEqual(mipSizes(node), [[160, 90], [80, 45], [40, 23], [20, 12], [10, 6]]);
  assert.deepEqual(aoTargetSize(node), [160, 90]);
  assert.equal(upsampleSwitch(node), 1);

  // A drawing-buffer resize follows the same frame's sync as well.
  renderer.setViewport(640, 360);
  frame(node, renderer, 2);
  assert.deepEqual(mipSizes(node)[0], [320, 180]);
  assert.deepEqual(aoTargetSize(node), [320, 180]);
  assert.equal(upsampleSwitch(node), 1);

  node.resolutionScale = 1;
  frame(node, renderer, 3);
  assert.deepEqual(mipSizes(node)[0], [640, 360]);
  assert.deepEqual(aoTargetSize(node), [640, 360]);
  assert.equal(upsampleSwitch(node), 0);

  node.dispose();
});

test("GTVBAONode keeps the upsample switch consistent with isDepthAwareUpsampleActive", () => {
  const node = createNode({ resolutionScale: 0.5 });
  const renderer = createRecordingRenderer(320, 180);
  const assertConsistent = (label: string) => {
    assert.equal(upsampleSwitch(node), node.isDepthAwareUpsampleActive() ? 1 : 0, label);
  };

  const steps: [string, () => void][] = [
    ["initial frame", () => {}],
    ["full resolution", () => { node.resolutionScale = 1; }],
    ["half resolution", () => { node.resolutionScale = 0.5; }],
    ["upsample off", () => { node.useDepthAwareUpsample = false; }],
    ["upsample on", () => { node.useDepthAwareUpsample = true; }],
    ["depth MIPs off", () => { node.useDepthMips.value = false; }],
    ["depth MIPs on", () => { node.useDepthMips.value = true; }],
  ];
  let frameId = 0;
  for (const [label, apply] of steps) {
    apply();
    frame(node, renderer, frameId++);
    assertConsistent(label);
  }

  // A direct setSize (the public resize entry point) syncs the switch too,
  // without waiting for the next updateBefore.
  node.useDepthMips.value = false;
  node.setSize(320, 180);
  assert.equal(upsampleSwitch(node), 0);
  assertConsistent("setSize with depth MIPs off");
  assert.deepEqual(mipSizes(node), [[1, 1], [1, 1], [1, 1], [1, 1], [1, 1]]);

  node.useDepthMips.value = true;
  node.setSize(320, 180);
  assert.equal(upsampleSwitch(node), 1);
  assertConsistent("setSize with depth MIPs on");
  assert.deepEqual(mipSizes(node)[0], [160, 90]);

  node.dispose();
});

test("GTVBAONode releases MIP textures before binding placeholders and rebuilds at the current AO size", () => {
  const node = createNode({ resolutionScale: 0.5 });
  const renderer = createRecordingRenderer(320, 180);
  frame(node, renderer, 0);

  const releasedTextures = mipNodes(node).map(({ value }) => value);
  const disposeEvents: string[] = [];
  releasedTextures.forEach((texture, level) => {
    texture.addEventListener("dispose", () => {
      // Disposal must run before the node is repointed to the placeholder:
      // at event time the mip node still references the released texture.
      const stillBound = mipNodes(node)[level].value === texture;
      disposeEvents.push(stillBound ? `disposed-bound:${level}` : `disposed-unbound:${level}`);
    });
  });

  node.useDepthMips.value = false;
  frame(node, renderer, 1);

  assert.deepEqual(disposeEvents, [0, 1, 2, 3, 4].map((level) => `disposed-bound:${level}`));
  assert.deepEqual(mipSizes(node), [[1, 1], [1, 1], [1, 1], [1, 1], [1, 1]]);
  assert.equal(upsampleSwitch(node), 0);
  assert.equal(prefilterTextureCount(node), 0);

  // Re-enabling reallocates at the current AO size, not a stale one.
  node.resolutionScale = 0.25;
  node.useDepthMips.value = true;
  frame(node, renderer, 2);

  assert.deepEqual(mipSizes(node), [[80, 45], [40, 23], [20, 12], [10, 6], [5, 3]]);
  for (const { value } of mipNodes(node)) {
    assert.ok(!releasedTextures.includes(value), "re-enabled MIPs must be fresh textures");
  }
  assert.equal(upsampleSwitch(node), 1);

  node.dispose();
});

test("GTVBAONode allocates nothing and keeps the upsample off after dispose", () => {
  const node = createNode({ resolutionScale: 0.5 });
  const renderer = createRecordingRenderer(320, 180);
  frame(node, renderer, 0);
  assert.equal(upsampleSwitch(node), 1);

  const disposedTextures = new Set<MipTexture>();
  for (const { value } of mipNodes(node)) {
    value.addEventListener("dispose", () => disposedTextures.add(value));
  }
  const mipValuesAtDispose = mipNodes(node).map(({ value }) => value);

  node.dispose();

  // Disposal releases the MIP textures and forces the upsample off; the public
  // activity query agrees with the uniform.
  assert.equal(disposedTextures.size, 5);
  assert.equal(upsampleSwitch(node), 0);
  assert.equal(node.isDepthAwareUpsampleActive(), false);
  assert.equal(prefilterTextureCount(node), 0);

  // Neither setSize nor updateBefore may allocate or render after dispose.
  const callsBefore = renderer.calls.length;
  node.setSize(640, 360);
  frame(node, renderer, 1);
  assert.equal(renderer.calls.length, callsBefore);
  assert.deepEqual(mipNodes(node).map(({ value }) => value), mipValuesAtDispose);
  assert.deepEqual(aoTargetSize(node), [160, 90]);
  assert.equal(upsampleSwitch(node), 0);
  assert.equal(prefilterTextureCount(node), 0);

  // Disposal is idempotent.
  node.dispose();
  assert.equal(prefilterTextureCount(node), 0);
});
