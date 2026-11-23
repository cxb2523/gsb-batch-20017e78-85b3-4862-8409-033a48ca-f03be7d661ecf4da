import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";

import { useLazyRef } from "./use-lazy-ref";

/**
 * Viewport size of a canvas tree node.
 * @category hook
 * @expand
 */
export interface CanvasViewSize {
  width: number;
  height: number;
  resolution: number;
}

interface CanvasTreeStore {
  subscribe: (callback: (size: CanvasViewSize) => void) => () => void;
  getSnapshot: () => CanvasViewSize;
  updateSnapshot: (update: Partial<CanvasViewSize>) => void;
  notifySubscribers: () => void;
}

/** @internal */
export interface CanvasTreeContextValue {
  store: CanvasTreeStore;
  invalidate: () => void;
}

/** @internal */
export const CanvasTreeContext = createContext<CanvasTreeContextValue | null>(
  null,
);

/**
 * Context value for a canvas tree node, stable while `invalidate` is.
 * @internal
 */
export function useCanvasTree(invalidate: () => void): CanvasTreeContextValue {
  const store = useCanvasTreeStore();
  return useMemo(() => ({ store, invalidate }), [store, invalidate]);
}

/**
 * Publishes a canvas tree node's size and requests a frame on change.
 * @internal
 */
export function useCanvasTreeSize(
  { store, invalidate }: CanvasTreeContextValue,
  { width, height, resolution }: CanvasViewSize,
) {
  useEffect(() => {
    store.updateSnapshot({ width, height, resolution });
    store.notifySubscribers();
    invalidate();
  }, [store, invalidate, width, height, resolution]);
}

function useCanvasTreeStore(): CanvasTreeStore {
  const storeRef = useLazyRef((): CanvasTreeStore => {
    const subscribers = new Set<(size: CanvasViewSize) => void>();
    let snapshot: CanvasViewSize = {
      width: 1,
      height: 1,
      resolution: window.devicePixelRatio,
    };
    return {
      subscribe(callback) {
        subscribers.add(callback);
        return () => {
          subscribers.delete(callback);
        };
      },
      getSnapshot() {
        return snapshot;
      },
      updateSnapshot(update) {
        snapshot = { ...snapshot, ...update };
      },
      notifySubscribers() {
        subscribers.forEach((callback) => {
          callback(snapshot);
        });
      },
    };
  });

  // Lazily-created singleton; stable for the component's lifetime
  // eslint-disable-next-line react-hooks/refs
  return storeRef.current;
}

/**
 * Viewport size of the nearest {@link CanvasView}, {@link ThreeScene},
 * {@link ThreeRenderTexture}, or {@link PixiTexture}.
 *
 * @category hook
 * @throws If called outside of a {@link CanvasView}
 */
export function useViewport(): CanvasViewSize {
  const context = useContext(CanvasTreeContext);
  if (context === null) {
    throw Error("useViewport() must be called within a <CanvasView />");
  }
  const size = useSyncExternalStore(
    context.store.subscribe,
    context.store.getSnapshot,
  );
  return size;
}

/**
 * Frame request function of the nearest canvas tree node; noop outside one.
 *
 * @category hook
 */
export function useInvalidate(): () => void {
  const context = useContext(CanvasTreeContext);
  return context?.invalidate ?? (() => {});
}

/**
 * Requests a frame after every render of the calling component.
 *
 * @category hook
 */
export function useEffectInvalidate() {
  const invalidate = useInvalidate();
  useEffect(invalidate);
}
