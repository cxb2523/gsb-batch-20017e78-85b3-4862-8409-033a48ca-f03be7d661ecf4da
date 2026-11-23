import { type RootState, useFrame, useThree } from "@react-three/fiber";
import {
  type ReactNode,
  type Ref,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
} from "react";
import {
  type PerspectiveCamera,
  type RenderTarget,
  type RenderTargetOptions,
  type Texture,
} from "three";
import type WebGPUBackend from "three/src/renderers/webgpu/WebGPUBackend.js";
import { type PostProcessing, type WebGPURenderer } from "three/webgpu";

import { useRenderTargetSized } from "./use-three-render-target";

/** @internal */
export interface PortalContentProps {
  ref?: Ref<RenderTarget>;
  width: number;
  height: number;
  resolution: number;
  renderTargetOptions?: RenderTargetOptions;
  children: ReactNode;
  onTextureUpdate?: (x: GPUTexture) => unknown;
  postProcessing?: (x: RootState) => PostProcessing;
  /** "always" renders every frame; "demand" renders when `isFrameRequested()` */
  frameloop?: "always" | "demand";
  isFrameRequested?: () => boolean;
  /** Called after each render; clears the frame request */
  signalFrame?: () => void;
}

/** Renders the portal scene into a render target; passes its GPUTexture to `onTextureUpdate`. @internal */
export function PortalContent({
  ref,
  width,
  height,
  resolution,
  renderTargetOptions,
  children,
  onTextureUpdate,
  postProcessing,
  frameloop = "always",
  isFrameRequested,
  signalFrame,
}: PortalContentProps) {
  const state = useThree();
  const backendData = (
    (state.renderer as unknown as WebGPURenderer).backend as WebGPUBackend & {
      data: WeakMap<Texture, { texture: GPUTexture }>;
    }
  ).data;
  const { camera, setSize, setDpr } = state;

  // Explicit pixel size: setDpr runs in an effect, so store dpr lags one render
  const renderTargetRef = useRenderTargetSized(
    width * resolution,
    height * resolution,
    renderTargetOptions,
  );

  useImperativeHandle(ref, () => renderTargetRef.current, [renderTargetRef]);

  const onResize = useEffectEvent(
    (width: number, height: number, resolution: number) => {
      // eslint-disable-next-line react-hooks/immutability
      (camera as PerspectiveCamera).aspect = width / height;
      camera.updateProjectionMatrix();
      setSize(width, height);
      setDpr(resolution);
    },
  );

  useEffect(() => {
    onResize(width, height, resolution);
  }, [width, height, resolution]);

  const postProcessor = postProcessing ? postProcessing(state) : null;
  useFrame(
    // eslint-disable-next-line react-hooks/immutability
    () => {
      if (frameloop === "always" || isFrameRequested?.()) {
        const renderer = state.renderer as unknown as WebGPURenderer;
        // readonly in @types/three; plain field at runtime
        const xr = renderer.xr as { isPresenting: boolean };
        const oldAutoClear = renderer.autoClear;
        const oldXrEnabled = renderer.xr.enabled;
        const oldIsPresenting = xr.isPresenting;
        const oldRenderTarget = renderer.getRenderTarget();
        // eslint-disable-next-line react-hooks/immutability
        renderer.autoClear = true;
        renderer.xr.enabled = false;
        xr.isPresenting = false;
        renderer.setRenderTarget(renderTargetRef.current);
        if (postProcessor) {
          postProcessor.render();
        } else {
          renderer.render(state.scene, state.camera);
        }
        if (onTextureUpdate) {
          const textureData = backendData.get(renderTargetRef.current.texture)!;
          onTextureUpdate(textureData.texture);
        }
        renderer.setRenderTarget(oldRenderTarget);
        renderer.autoClear = oldAutoClear;
        renderer.xr.enabled = oldXrEnabled;
        xr.isPresenting = oldIsPresenting;
        signalFrame?.();
      }
    },
    { phase: "render" },
  );
  return <>{children}</>;
}
