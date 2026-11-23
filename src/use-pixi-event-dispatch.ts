import {
  type Container,
  EventBoundary,
  FederatedPointerEvent,
  FederatedWheelEvent,
  Point,
} from "pixi.js";
import { createContext, type RefObject, useContext, useState } from "react";

import {
  type PixiRootEvents,
  type PixiSyntheticEventSystem,
} from "./pixi-synthetic-event-system";
import { useRenderContext } from "./render-context-hooks";

/**
 * Event system for PixiTexture content; overrides RenderContext's.
 * @internal
 */
export const PixiEventsContext = createContext<PixiSyntheticEventSystem | null>(
  null,
);

/** @internal */
export interface UsePixiEventDispatchOptions {
  containerRef: RefObject<Container>;
  canvasRef: RefObject<HTMLCanvasElement | HTMLElement>;
}

/** @internal */
export type UsePixiEventDispatchResult = (
  event: Event,
  point: Point | null,
  onPointerMissed?: (event: PointerEvent) => void,
) => void;

/**
 * Owns an EventBoundary and root events for `containerRef`; returns its dispatcher.
 * @internal
 */
export function usePixiEventDispatch({
  containerRef,
  canvasRef,
}: UsePixiEventDispatchOptions): UsePixiEventDispatchResult {
  const pixiEventsFromContext = useContext(PixiEventsContext);
  const { pixiEvents: pixiEventsFromRenderContext } = useRenderContext();
  const pixiEvents = pixiEventsFromContext ?? pixiEventsFromRenderContext;

  const [eventBoundary] = useState(() => new EventBoundary());
  const [rootEvents] = useState<PixiRootEvents>(() => ({
    pointerEvent: new FederatedPointerEvent(eventBoundary),
    wheelEvent: new FederatedWheelEvent(eventBoundary),
  }));

  function dispatchEvent(
    event: Event,
    point: Point | null,
    onPointerMissed?: (event: PointerEvent) => void,
  ) {
    if (!pixiEvents || !containerRef.current || !canvasRef.current) return;
    pixiEvents.dispatch(
      event,
      point,
      containerRef.current,
      eventBoundary,
      rootEvents,
      canvasRef.current as HTMLElement,
      onPointerMissed,
    );
  }

  return dispatchEvent;
}
