import { Application } from "@pixi/react";
import { FiberAnchor, fiberTunnel } from "fiber-tunnel";
import { FiberProvider } from "its-fine";
import type { Application as ApplicationType } from "pixi.js";
import { type ReactNode, useRef, useState } from "react";

import { PixiSyntheticEventSystem } from "./pixi-synthetic-event-system";
import { PixiTextureRenderer } from "./pixi-texture";
import { RenderContextValue } from "./render-context-hooks";
import { ThreeRoot, type ThreeRootBaseProps } from "./three-root";
import { ThreeSceneRenderer } from "./three-scene";

/**
 * See {@link RenderContext}.
 *
 * @category component
 * @expand
 */
export interface RenderContextProps extends ThreeRootBaseProps {
  children?: ReactNode;
}

/**
 * Root for all {@link CanvasView} components, which share its GPU resources.
 * Hosts the {@link https://react.pixijs.io/components/application | React Pixi Application}
 * and {@link https://r3f.docs.pmnd.rs | React Three Fiber root}; renders DOM children.
 *
 * @category component
 * @expandType RenderContextProps
 * @example
 * ```tsx
 * <RenderContext>
 *   <CanvasView>
 *     <ThreeScene>
 *       <SpinnyCube /> // Three.js Object
 *     </ThreeScene>
 *     <SpinnyStar /> // Pixi.js Graphic
 *   </CanvasView>
 * </RenderContext>
 * ```
 */
export function RenderContext({
  children,
  eventSource,
  threeRendererParameters,
  onCreated,
  onPointerMissed,
}: RenderContextProps) {
  const eventContainer = useRef<HTMLDivElement>(null!);

  const [pixiEvents, setPixiEvents] = useState<PixiSyntheticEventSystem | null>(
    null,
  );

  function setPixiApplication(app: ApplicationType | null) {
    if (!app) {
      setPixiEvents(null);
    } else {
      setPixiEvents(new PixiSyntheticEventSystem(app.renderer));
    }
  }

  const [canvasViewTunnel] = useState(() => fiberTunnel());
  const [threeSceneTunnel] = useState(() => fiberTunnel());
  const [pixiTextureTunnel] = useState(() => fiberTunnel());

  return (
    <FiberProvider>
      <div ref={eventContainer} className="contents">
        <RenderContextValue
          value={{
            tunnel: canvasViewTunnel,
            eventContainer,
            pixiEvents,
            threeSceneTunnel,
            pixiTextureTunnel,
          }}
        >
          <Application
            className="hidden"
            width={1}
            height={1}
            preference="webgpu"
            resolution={2}
            onInit={(app) => {
              setPixiApplication(app);
            }}
          >
            <pixiContainer renderable={false}>
              <canvasViewTunnel.Out />
            </pixiContainer>
            <FiberAnchor>
              {(bridge) => (
                <ThreeRoot
                  bridge={bridge}
                  eventSource={eventSource ?? eventContainer}
                  threeRendererParameters={threeRendererParameters}
                  onCreated={onCreated}
                  onPointerMissed={onPointerMissed}
                >
                  <ThreeSceneRenderer />
                </ThreeRoot>
              )}
            </FiberAnchor>
            <PixiTextureRenderer />
          </Application>
          {children}
        </RenderContextValue>
      </div>
    </FiberProvider>
  );
}
