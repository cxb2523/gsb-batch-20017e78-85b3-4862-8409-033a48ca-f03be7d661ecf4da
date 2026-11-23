import {
  type Container,
  EventBoundary,
  EventsTicker,
  EventSystem,
  type FederatedMouseEvent,
  FederatedPointerEvent,
  FederatedWheelEvent,
  type PixiTouch,
  type Point,
  type Renderer,
} from "pixi.js";

const MOUSE_POINTER_ID = 1;

const TOUCH_TO_POINTER: Record<string, string> = {
  touchstart: "pointerdown",
  touchend: "pointerup",
  touchendoutside: "pointerupoutside",
  touchmove: "pointermove",
  touchcancel: "pointercancel",
};

const MOUSE_EVENTS = ["click", "contextmenu", "dblclick"];

interface PixiPointerEvent extends PointerEvent {
  isPrimary: boolean;
  width: number;
  height: number;
  tiltX: number;
  tiltY: number;
  pointerType: string;
  pointerId: number;
  pressure: number;
  twist: number;
  tangentialPressure: number;
  isNormalized: boolean;
  type: string;
}

/** Root federated events reused across dispatches. @internal */
export interface PixiRootEvents {
  pointerEvent: FederatedPointerEvent;
  wheelEvent: FederatedWheelEvent;
}

/**
 * {@link https://pixijs.download/release/docs/events.EventSystem.html | Pixi EventSystem}
 * that dispatches caller-supplied events and points to arbitrary containers.
 * @internal
 */
export class PixiSyntheticEventSystem extends EventSystem {
  constructor(renderer: Renderer) {
    super(renderer);

    this.domElement = renderer.events.domElement;
    Object.assign(this.features, { move: true, click: true, wheel: true });
  }

  /**
   * Dispatches `event` to `container` at `point`.
   *
   * @param point - Pixi texture space; null signals pointer out
   * @param domElement - Pointerups targeting other elements map to `*outside`
   * @param onPointerMissed - Called when a pointerup hits no interactive child
   */
  public dispatch(
    event: Event,
    point: Point | null,
    container: Container,
    eventBoundary: EventBoundary,
    rootEvents: PixiRootEvents,
    domElement: HTMLElement,
    onPointerMissed?: (event: PointerEvent) => void,
  ): void {
    this.domElement = domElement;
    eventBoundary.rootTarget = container;

    const type = event.type;

    if (point === null) {
      if (
        type === "pointermove" ||
        type === "mousemove" ||
        type === "touchmove"
      ) {
        this.handlePointerOut(event, eventBoundary, rootEvents.pointerEvent);
      }
      return;
    }

    if (
      type === "pointerdown" ||
      type === "mousedown" ||
      type === "touchstart"
    ) {
      this.handlePointerDown(
        event,
        eventBoundary,
        rootEvents.pointerEvent,
        point,
      );
    } else if (
      type === "pointermove" ||
      type === "mousemove" ||
      type === "touchmove"
    ) {
      this.handlePointerMove(
        event,
        eventBoundary,
        rootEvents.pointerEvent,
        point,
      );
    } else if (
      type === "pointerup" ||
      type === "mouseup" ||
      type === "touchend"
    ) {
      this.handlePointerUp(
        event,
        eventBoundary,
        rootEvents.pointerEvent,
        point,
        onPointerMissed,
      );
    } else if (
      type === "pointerover" ||
      type === "pointerout" ||
      type === "pointerenter" ||
      type === "pointerleave"
    ) {
      this.handlePointerOverOut(
        event,
        eventBoundary,
        rootEvents.pointerEvent,
        point,
      );
    } else if (type === "wheel") {
      this.handleWheel(event, eventBoundary, rootEvents.wheelEvent, point);
    }
  }

  /** Fills pointer fields on touch/mouse events; one entry per changed touch. */
  protected normalizeToPointerData<
    T extends TouchEvent | MouseEvent | PointerEvent,
  >(event: T): PointerEvent[] {
    const normalizedEvents: PointerEvent[] = [];

    if (this.supportsTouchEvents && event.type.startsWith("touch")) {
      for (const touch of (event as TouchEvent)
        .changedTouches as Iterable<PixiTouch>) {
        if (typeof touch.button === "undefined") touch.button = 0;
        if (typeof touch.buttons === "undefined") touch.buttons = 1;
        if (typeof touch.isPrimary === "undefined") {
          touch.isPrimary =
            (event as TouchEvent).touches.length === 1 &&
            event.type === "touchstart";
        }
        if (typeof touch.width === "undefined")
          touch.width = touch.radiusX || 1;
        if (typeof touch.height === "undefined")
          touch.height = touch.radiusY || 1;
        if (typeof touch.tiltX === "undefined") touch.tiltX = 0;
        if (typeof touch.tiltY === "undefined") touch.tiltY = 0;
        if (typeof touch.pointerType === "undefined")
          touch.pointerType = "touch";
        if (typeof touch.pointerId === "undefined")
          touch.pointerId = touch.identifier || 0;
        if (typeof touch.pressure === "undefined")
          touch.pressure = touch.force || 0.5;
        if (typeof touch.twist === "undefined") touch.twist = 0;
        if (typeof touch.tangentialPressure === "undefined")
          touch.tangentialPressure = 0;
        // From pixi.js EventSystem: layerX/Y is deprecated; these fill-ins approximate it
        if (typeof touch.layerX === "undefined")
          touch.layerX = touch.offsetX = touch.clientX;
        if (typeof touch.layerY === "undefined")
          touch.layerY = touch.offsetY = touch.clientY;

        touch.isNormalized = true;
        touch.type = event.type;

        normalizedEvents.push({
          ...(event as PointerEvent),
          ...touch,
        });
      }
    } else if (
      !globalThis.MouseEvent ||
      (!this.supportsPointerEvents && MOUSE_EVENTS.includes(event.type))
    ) {
      const tempEvent = event as unknown as PixiPointerEvent;

      if (typeof tempEvent.isPrimary === "undefined")
        tempEvent.isPrimary = true;
      if (typeof tempEvent.width === "undefined") tempEvent.width = 1;
      if (typeof tempEvent.height === "undefined") tempEvent.height = 1;
      if (typeof tempEvent.tiltX === "undefined") tempEvent.tiltX = 0;
      if (typeof tempEvent.tiltY === "undefined") tempEvent.tiltY = 0;
      if (typeof tempEvent.pointerType === "undefined")
        tempEvent.pointerType = "mouse";
      if (typeof tempEvent.pointerId === "undefined")
        tempEvent.pointerId = MOUSE_POINTER_ID;
      if (typeof tempEvent.pressure === "undefined") tempEvent.pressure = 0.5;
      if (typeof tempEvent.twist === "undefined") tempEvent.twist = 0;
      if (typeof tempEvent.tangentialPressure === "undefined")
        tempEvent.tangentialPressure = 0;

      tempEvent.isNormalized = true;

      normalizedEvents.push(event as PointerEvent);
    } else {
      normalizedEvents.push(event as PointerEvent);
    }

    return normalizedEvents;
  }

  /** Copies mouse fields from `sourceEvent` onto `federatedEvent`. */
  protected transferMouseData<T extends MouseEvent>(
    federatedEvent: FederatedMouseEvent,
    sourceEvent: T,
  ): void {
    federatedEvent.isTrusted = sourceEvent.isTrusted;
    federatedEvent.srcElement = sourceEvent.srcElement!;
    federatedEvent.timeStamp = performance.now();
    federatedEvent.type = sourceEvent.type;

    federatedEvent.altKey = sourceEvent.altKey;
    federatedEvent.button = sourceEvent.button;
    federatedEvent.buttons = sourceEvent.buttons;
    federatedEvent.client.x = sourceEvent.clientX;
    federatedEvent.client.y = sourceEvent.clientY;
    federatedEvent.ctrlKey = sourceEvent.ctrlKey;
    federatedEvent.metaKey = sourceEvent.metaKey;
    federatedEvent.movement.x = sourceEvent.movementX;
    federatedEvent.movement.y = sourceEvent.movementY;
    federatedEvent.page.x = sourceEvent.pageX;
    federatedEvent.page.y = sourceEvent.pageY;
    federatedEvent.relatedTarget = null as unknown as EventTarget;
    federatedEvent.shiftKey = sourceEvent.shiftKey;
  }

  /** Populates `federatedEvent` from `sourceEvent` at `eventPoint`; maps the type to `pointer*`. */
  protected bootstrapPointerEvent<T extends PointerEvent>(
    federatedEvent: FederatedPointerEvent,
    sourceEvent: T,
    eventPoint: Point,
  ): void {
    federatedEvent.originalEvent = null!;
    federatedEvent.nativeEvent = sourceEvent;

    federatedEvent.pointerId = sourceEvent.pointerId;
    federatedEvent.width = sourceEvent.width;
    federatedEvent.height = sourceEvent.height;
    federatedEvent.isPrimary = sourceEvent.isPrimary;
    federatedEvent.pointerType = sourceEvent.pointerType;
    federatedEvent.pressure = sourceEvent.pressure;
    federatedEvent.tangentialPressure = sourceEvent.tangentialPressure;
    federatedEvent.tiltX = sourceEvent.tiltX;
    federatedEvent.tiltY = sourceEvent.tiltY;
    federatedEvent.twist = sourceEvent.twist;

    this.transferMouseData(federatedEvent, sourceEvent);

    federatedEvent.screen.copyFrom(eventPoint);
    federatedEvent.global.copyFrom(eventPoint);
    federatedEvent.offset.copyFrom(eventPoint);

    federatedEvent.isTrusted = sourceEvent.isTrusted;
    if (federatedEvent.type === "pointerleave") {
      federatedEvent.type = "pointerout";
    }
    if (federatedEvent.type.startsWith("mouse")) {
      federatedEvent.type = federatedEvent.type.replace("mouse", "pointer");
    }
    if (federatedEvent.type.startsWith("touch")) {
      federatedEvent.type =
        TOUCH_TO_POINTER[federatedEvent.type] || federatedEvent.type;
    }
  }

  /** Maps pointerdown through `eventBoundary`. */
  protected handlePointerDown<T = TouchEvent | MouseEvent | PointerEvent>(
    sourceEvent: T,
    eventBoundary: EventBoundary,
    rootEvent: FederatedPointerEvent,
    eventPoint: Point,
  ): void {
    const events = this.normalizeToPointerData(
      sourceEvent as TouchEvent | MouseEvent | PointerEvent,
    );

    for (let i = 0, j = events.length; i < j; i++) {
      const nativeEvent = events[i];
      this.bootstrapPointerEvent(rootEvent, nativeEvent, eventPoint);
      eventBoundary.mapEvent(rootEvent);
    }

    this.setCursor(eventBoundary.cursor);
  }

  /** Maps pointermove through `eventBoundary`. */
  protected handlePointerMove<T = TouchEvent | MouseEvent | PointerEvent>(
    sourceEvent: T,
    eventBoundary: EventBoundary,
    rootEvent: FederatedPointerEvent,
    eventPoint: Point,
  ): void {
    if (!this.features.move) return;

    EventsTicker.pointerMoved();

    const normalizedEvents = this.normalizeToPointerData(
      sourceEvent as TouchEvent | MouseEvent | PointerEvent,
    );

    for (let i = 0, j = normalizedEvents.length; i < j; i++) {
      this.bootstrapPointerEvent(rootEvent, normalizedEvents[i], eventPoint);
      eventBoundary.mapEvent(rootEvent);
    }

    this.setCursor(eventBoundary.cursor);
  }

  /** Maps pointerup through `eventBoundary`; calls `onPointerMissed` when no interactive child is hit. */
  protected handlePointerUp<T = TouchEvent | MouseEvent | PointerEvent>(
    sourceEvent: T,
    eventBoundary: EventBoundary,
    rootEvent: FederatedPointerEvent,
    eventPoint: Point,
    onPointerMissed?: (event: PointerEvent) => void,
  ): void {
    if (!this.features.click) return;

    const target = (sourceEvent as Event).target;

    const outside = target !== this.domElement ? "outside" : "";
    const normalizedEvents = this.normalizeToPointerData(
      sourceEvent as TouchEvent | MouseEvent | PointerEvent,
    );

    for (let i = 0, j = normalizedEvents.length; i < j; i++) {
      this.bootstrapPointerEvent(rootEvent, normalizedEvents[i], eventPoint);
      rootEvent.type += outside;
      eventBoundary.mapEvent(rootEvent);
    }

    this.setCursor(eventBoundary.cursor);

    if (onPointerMissed) {
      const hitTarget = eventBoundary.hitTest(eventPoint.x, eventPoint.y);
      if (!hitTarget || hitTarget === eventBoundary.rootTarget) {
        onPointerMissed(sourceEvent as PointerEvent);
      }
    }
  }

  /** Maps pointerout for a departed pointer; EventBoundary.mapPointerOut reads tracked targets in place of a hit test. */
  protected handlePointerOut<T = TouchEvent | MouseEvent | PointerEvent>(
    sourceEvent: T,
    eventBoundary: EventBoundary,
    rootEvent: FederatedPointerEvent,
  ): void {
    const normalizedEvents = this.normalizeToPointerData(
      sourceEvent as TouchEvent | MouseEvent | PointerEvent,
    );

    for (let i = 0, j = normalizedEvents.length; i < j; i++) {
      this.transferMouseData(rootEvent, normalizedEvents[i]);
      rootEvent.type = "pointerout";
      eventBoundary.mapEvent(rootEvent);
    }

    this.setCursor("default");
  }

  /** Maps pointerover/out/enter/leave through `eventBoundary`. */
  protected handlePointerOverOut<T = TouchEvent | MouseEvent | PointerEvent>(
    sourceEvent: T,
    eventBoundary: EventBoundary,
    rootEvent: FederatedPointerEvent,
    eventPoint: Point,
  ): void {
    if (!this.features.click) return;

    const normalizedEvents = this.normalizeToPointerData(
      sourceEvent as TouchEvent | MouseEvent | PointerEvent,
    );

    for (let i = 0, j = normalizedEvents.length; i < j; i++) {
      this.bootstrapPointerEvent(rootEvent, normalizedEvents[i], eventPoint);
      eventBoundary.mapEvent(rootEvent);
    }

    this.setCursor(eventBoundary.cursor);
  }

  /** Maps wheel through `eventBoundary`. */
  protected handleWheel<T = WheelEvent>(
    sourceEvent: T,
    eventBoundary: EventBoundary,
    rootEvent: FederatedWheelEvent,
    eventPoint: Point,
  ): void {
    if (!this.features.wheel) return;

    const wheelEvent = sourceEvent as WheelEvent;
    this.transferMouseData(rootEvent, wheelEvent);

    // Firefox: read deltaMode after deltaX/Y/Z (pixijs/pixijs#8970)
    rootEvent.deltaX = wheelEvent.deltaX;
    rootEvent.deltaY = wheelEvent.deltaY;
    rootEvent.deltaZ = wheelEvent.deltaZ;
    rootEvent.deltaMode = wheelEvent.deltaMode;

    rootEvent.screen.copyFrom(eventPoint);
    rootEvent.global.copyFrom(eventPoint);
    rootEvent.offset.copyFrom(eventPoint);

    rootEvent.nativeEvent = wheelEvent;
    rootEvent.type = wheelEvent.type;

    eventBoundary.mapEvent(rootEvent);
  }
}
