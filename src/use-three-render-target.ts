import { useEffect, useLayoutEffect } from "react";
import {
  DepthTexture,
  FloatType,
  RenderTarget,
  type RenderTargetOptions,
} from "three";

import { useLazyRef } from "./use-lazy-ref";

/**
 * @internal
 *
 * Ref to a {@link https://threejs.org/docs/#RenderTarget | Three.js RenderTarget}
 * sized in physical pixels; disposed on unmount.
 *
 * @category hook
 */
export function useRenderTargetSized(
  pixelWidth: number,
  pixelHeight: number,
  options?: RenderTargetOptions,
) {
  const renderTargetRef = useLazyRef(() => {
    const val = new RenderTarget(pixelWidth, pixelHeight, options);
    if (options?.depthBuffer) {
      val.depthTexture = new DepthTexture(pixelWidth, pixelHeight, FloatType);
    }
    return val;
  });

  useLayoutEffect(() => {
    renderTargetRef.current.setSize(pixelWidth, pixelHeight);
    // setSize skips the depth texture; recreate it on dimension changes only
    const depthTexture = renderTargetRef.current.depthTexture;
    if (
      depthTexture &&
      (depthTexture.image.width !== pixelWidth ||
        depthTexture.image.height !== pixelHeight)
    ) {
      depthTexture.dispose();
      renderTargetRef.current.depthTexture = new DepthTexture(
        pixelWidth,
        pixelHeight,
        FloatType,
      );
    }
    if (options?.samples !== undefined) {
      renderTargetRef.current.samples = options.samples;
    }
  }, [pixelWidth, pixelHeight, options?.samples, renderTargetRef]);

  useEffect(() => {
    const val = renderTargetRef.current;
    return () => val.dispose();
  }, [renderTargetRef]);

  return renderTargetRef;
}
