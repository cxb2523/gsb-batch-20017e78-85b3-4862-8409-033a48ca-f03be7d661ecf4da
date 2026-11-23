import { extend, useApplication, useTick } from "@pixi/react";
import { FiberProvider } from "its-fine";
import {
  CanvasSource,
  Container,
  Point,
  Rectangle,
  RenderTarget,
} from "pixi.js";
import {
  type PointerEvent as ReactPointerEvent,
  type PropsWithChildren,
  type ReactNode,
  type Ref,
  type RefObject,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

import {
  mapClientToViewport,
  mapViewportToClient as mapViewportToClientUtil,
} from "./bijections";
import { CanvasTreeContext, useCanvasTree } from "./canvas-tree-context";
import { CanvasViewContext as CanvasViewContentContext } from "./canvas-view-context";
import { useRenderContext } from "./render-context-hooks";
import { usePixiEventDispatch } from "./use-pixi-event-dispatch";
import { useRenderSchedule } from "./use-render-schedule";

extend({ Container });

/**
 * See {@link CanvasView}.
 *
 * @category component
 * @expand
 */
export interface CanvasViewProps
  extends
    PropsWithChildren,
    Omit<
      React.CanvasHTMLAttributes<HTMLCanvasElement>,
      "className" | "style" | "ref" | "children"
    > {
  /** Wrapper div class name, default "h-full w-full" */
  className?: string;
  /** Canvas fallback content */
  fallback?: ReactNode;
  /** Frameloop, default "always" */
  frameloop?: "always" | "demand";
  /** Alpha transparency, default false */
  alpha?: boolean;
  /** Antialiasing, default true */
  antialias?: boolean;
  /** Canvas resolution, default window.devicePixelRatio */
  resolution?: number;
  /** FPS limit */
  fpsLimit?: number;
  /** Called after each rendered frame, e.g. to drive recording */
  onRender?: () => void;
  /** Canvas element ref, e.g. for recording */
  canvasRef?: RefObject<HTMLCanvasElement | null>;
  /**
   * {@link https://r3f.docs.pmnd.rs/api/events | React Three Fiber}-style handler for pointer clicks that miss all interactive Pixi children
   */
  onPointerMissed?: (event: PointerEvent) => void;
}

/**
 * A canvas DOM element containing React Pixi children.
 * Must be inside a {@link RenderContext}.
 *
 * An urgent suspend inside shows the canvas for one commit before the
 * Suspense fallback.
 *
 * @category component
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
export function CanvasView({
  className = "h-full w-full",
  fallback,
  children,
  frameloop = "always",
  alpha = false,
  antialias = true,
  resolution = window.devicePixelRatio,
  fpsLimit,
  onRender,
  canvasRef: canvasRefProp,
  onPointerMissed,
  // Merged with internal handlers
  onPointerDown,
  onPointerUp,
  onPointerMove,
  onPointerOver,
  onPointerOut,
  onPointerLeave,
  onPointerCancel,
  onWheel,
  ...canvasProps
}: CanvasViewProps) {
  const { tunnel } = useRenderContext();
  const canvasRef = useRef<HTMLCanvasElement>(null!);
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  useImperativeHandle(canvasRefProp, () => canvasRef.current);
  const containerRef = useRef<Container>(null!);
  const renderTargetRef = useRef<RenderTarget>(null!);

  const dispatchEvent = usePixiEventDispatch({
    containerRef,
    canvasRef,
  });

  const computeEventPoint = (event: ReactPointerEvent | React.WheelEvent) => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return null;

    const viewRect = container.hitArea as Rectangle;
    if (!viewRect) return null;

    const rect = canvas.isConnected
      ? canvas.getBoundingClientRect()
      : {
          left: 0,
          top: 0,
          width: canvas.width,
          height: canvas.height,
        };

    return mapClientToViewport(event, rect, viewRect, new Point());
  };

  const handleEvent = (event: ReactPointerEvent | React.WheelEvent) => {
    const point = computeEventPoint(event);
    dispatchEvent(event.nativeEvent, point, onPointerMissed);
  };

  const mergeHandler =
    <E extends ReactPointerEvent | React.WheelEvent>(
      userHandler: React.EventHandler<E> | undefined,
    ) =>
    (event: E) => {
      userHandler?.(event);
      // eslint-disable-next-line react-hooks/refs -- runs in event handlers only
      handleEvent(event);
    };

  return (
    <>
      <div className={className} style={{ position: "relative" }}>
        <canvas
          ref={(ref) => {
            if (!ref) {
              return;
            }
            canvasRef.current = ref;
            setCanvas(ref);
            renderTargetRef.current = new RenderTarget({
              width: ref.clientWidth,
              height: ref.clientHeight,
              resolution: resolution,
              antialias: antialias,
              colorTextures: [
                {
                  source: new CanvasSource({
                    resource: ref,
                    resolution: resolution,
                    transparent: alpha,
                    autoGarbageCollect: false,
                  }),
                },
              ],
            });
          }}
          {...canvasProps}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            userSelect: "none",
            WebkitUserSelect: "none",
            WebkitTouchCallout: "none",
          }}
          onPointerDown={mergeHandler(onPointerDown)}
          onPointerUp={mergeHandler(onPointerUp)}
          onPointerMove={mergeHandler(onPointerMove)}
          onPointerOver={mergeHandler(onPointerOver)}
          onPointerOut={mergeHandler(onPointerOut)}
          onPointerLeave={mergeHandler(onPointerLeave)}
          onPointerCancel={mergeHandler(onPointerCancel)}
          onWheel={mergeHandler(onWheel)}
        >
          {fallback}
        </canvas>
      </div>
      <tunnel.In>
        <FiberProvider>
          <CanvasViewContent
            canvasRef={canvasRef}
            canvas={canvas}
            containerRef={containerRef}
            renderTargetRef={renderTargetRef}
            frameloop={frameloop}
            fpsLimit={fpsLimit}
            onRender={onRender}
          >
            {children}
          </CanvasViewContent>
        </FiberProvider>
      </tunnel.In>
    </>
  );
}

interface CanvasViewContentProps extends PropsWithChildren {
  canvasRef: RefObject<HTMLCanvasElement>;
  /** null until mounted */
  canvas: HTMLCanvasElement | null;
  containerRef: Ref<Container>;
  renderTargetRef: RefObject<RenderTarget>;
  frameloop: "always" | "demand";
  fpsLimit?: number;
  onRender?: () => void;
}

function CanvasViewContent({
  canvasRef,
  canvas,
  containerRef: containerRefProp,
  renderTargetRef,
  frameloop,
  fpsLimit,
  onRender,
  children,
}: CanvasViewContentProps) {
  const app = useApplication();
  const containerRef = useRef<Container>(null!);
  useImperativeHandle(containerRefProp, () => containerRef.current);

  const [isVisible, setIsVisible] = useState(true);

  const { isFrameRequested, invalidate, signalFrame } = useRenderSchedule({
    fpsLimit,
  });

  const canvasTree = useCanvasTree(invalidate);
  const { subscribe, updateSnapshot, notifySubscribers } = canvasTree.store;

  const pendingSizeRef = useRef<{ width: number; height: number }>({
    width: 1,
    height: 1,
  });
  const appliedSizeRef = useRef<{ width: number; height: number }>({
    width: 1,
    height: 1,
  });

  // Destroyed here, alongside the tick that renders into it
  useEffect(
    () => () => {
      renderTargetRef.current.colorTextures[0].destroy();
      renderTargetRef.current.destroy();
    },
    [renderTargetRef],
  );

  useEffect(
    () =>
      subscribe((size) => {
        if (!renderTargetRef.current.colorTextures[0]?.source?.resource) {
          return;
        }
        (containerRef.current.hitArea as Rectangle).set(
          0,
          0,
          size.width,
          size.height,
        );
        renderTargetRef.current.resize(
          size.width,
          size.height,
          size.resolution,
        );
        invalidate();
      }),
    [subscribe, renderTargetRef, invalidate],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    const width = Math.round(canvas.clientWidth);
    const height = Math.round(canvas.clientHeight);
    pendingSizeRef.current = { width, height };

    const resizeObserver = new ResizeObserver(([entry]) => {
      const width = Math.round(entry.contentRect.width);
      const height = Math.round(entry.contentRect.height);
      pendingSizeRef.current = { width, height };
      invalidate();
    });
    resizeObserver.observe(canvas);

    return () => {
      resizeObserver.disconnect();
    };
  }, [canvasRef, invalidate]);

  useEffect(() => {
    let removeListener: (() => void) | null = null;
    const updatePixelRatio = () => {
      removeListener?.();
      const media = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      media.addEventListener("change", updatePixelRatio);
      removeListener = () => {
        media.removeEventListener("change", updatePixelRatio);
      };
      updateSnapshot({ resolution: window.devicePixelRatio });
      notifySubscribers();
    };
    updatePixelRatio();
    return () => {
      removeListener?.();
    };
  }, [canvasRef, notifySubscribers, updateSnapshot]);

  useEffect(() => {
    const canvas = canvasRef.current;

    const intersectionObserver = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        setIsVisible(entry.isIntersecting);
      },
      { threshold: 0 },
    );

    intersectionObserver.observe(canvas);

    return () => {
      intersectionObserver.disconnect();
    };
  }, [canvasRef]);

  function render() {
    app.app.renderer.render({
      container: containerRef.current,
      target: renderTargetRef.current,
      label: "canvas-view",
    });
  }

  useTick({
    callback: () => {
      if (frameloop === "always" || isFrameRequested()) {
        const pendingSize = pendingSizeRef.current;
        const appliedSize = appliedSizeRef.current;
        if (
          pendingSize.width !== appliedSize.width ||
          pendingSize.height !== appliedSize.height
        ) {
          appliedSizeRef.current = pendingSize;
          updateSnapshot(pendingSize);
          notifySubscribers();
        }

        render();
        onRender?.();
        signalFrame();
      }
    },
    isEnabled: isVisible,
  });

  return (
    <CanvasViewContentContext
      value={{
        canvasRef,
        canvas,
        containerRef,
        mapViewportToClient: (viewportPoint, out?) => {
          const canvas = canvasRef.current;
          const rect = canvas?.isConnected
            ? canvas.getBoundingClientRect()
            : {
                left: 0,
                top: 0,
                width: canvas?.width ?? 1,
                height: canvas?.height ?? 1,
              };
          const viewport = (containerRef.current?.hitArea as Rectangle) ?? {
            width: 1,
            height: 1,
          };
          return mapViewportToClientUtil(viewportPoint, viewport, rect, out);
        },
        mapClientToViewport: (client, out?) => {
          const canvas = canvasRef.current;
          const rect = canvas?.isConnected
            ? canvas.getBoundingClientRect()
            : {
                left: 0,
                top: 0,
                width: canvas?.width ?? 1,
                height: canvas?.height ?? 1,
              };
          const viewport = (containerRef.current?.hitArea as Rectangle) ?? {
            width: 1,
            height: 1,
          };
          return mapClientToViewport(client, rect, viewport, out);
        },
      }}
    >
      <CanvasTreeContext value={canvasTree}>
        <pixiContainer
          ref={(ref) => {
            if (!ref) {
              return;
            }
            containerRef.current = ref;
            const width = Math.round(canvasRef.current.clientWidth);
            const height = Math.round(canvasRef.current.clientHeight);
            const resolution = window.devicePixelRatio;
            if (width > 0 && height > 0) {
              updateSnapshot({
                width: width,
                height: height,
                resolution: resolution,
              });
              containerRef.current.hitArea = new Rectangle(0, 0, width, height);
              renderTargetRef.current.resize(width, height, resolution);
            }
          }}
        >
          {children}
        </pixiContainer>
      </CanvasTreeContext>
    </CanvasViewContentContext>
  );
}
