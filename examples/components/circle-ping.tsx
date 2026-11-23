import { useTick } from "@pixi/react";
import { type ColorSource, Graphics, type Point } from "pixi.js";
import { useEffect, useRef, useState } from "react";

export interface CirclePingProps {
  /** Center */
  position: Point;
  color: ColorSource;
  startRadius?: number;
  endRadius?: number;
  /** Milliseconds */
  duration?: number;
  strokeWidth?: number;
  onComplete?: () => void;
}

interface AnimState {
  position: Point;
  elapsed: number;
  progress: number;
  complete: boolean;
}

export function CirclePing({
  position,
  color,
  startRadius = 5,
  endRadius = 50,
  duration = 500,
  strokeWidth = 3,
  onComplete,
}: CirclePingProps) {
  const [anim, setAnim] = useState<AnimState>({
    position,
    elapsed: 0,
    progress: 0,
    complete: false,
  });

  if (position.x !== anim.position.x || position.y !== anim.position.y) {
    setAnim({ position, elapsed: 0, progress: 0, complete: false });
  }

  const onCompleteRef = useRef(onComplete);
  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  useTick((ticker) => {
    if (anim.complete) return;

    const elapsed = anim.elapsed + ticker.deltaMS;
    const progress = Math.min(elapsed / duration, 1);
    const complete = progress >= 1;

    setAnim({ position: anim.position, elapsed, progress, complete });

    if (complete) {
      onCompleteRef.current?.();
    }
  });

  // Ease-out quad
  const eased = 1 - (1 - anim.progress) * (1 - anim.progress);
  const currentRadius = startRadius + (endRadius - startRadius) * eased;
  const alpha = 1 - eased;

  function draw(graphics: Graphics) {
    graphics.clear();
    graphics.circle(anim.position.x, anim.position.y, currentRadius).stroke({
      width: strokeWidth,
      color,
      alpha,
    });
  }

  if (anim.complete) return null;

  return <pixiGraphics draw={draw} />;
}
