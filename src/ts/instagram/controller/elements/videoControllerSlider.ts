import { VideoControllerElementBase } from './videoControllerElement';

// State of a slider that has to survive a control bar rebuild.
export interface SliderState {
    // The value (0..1) the slider showed when it was saved.
    value: number;

    // True while the user is dragging the slider.
    dragging: boolean;

    // True if the slider was collapsed when it was saved. A volume bar is expanded on hover, so an ongoing drag must
    // not end up on a newly collapsed (hidden and zero-width) bar.
    collapsed: boolean;
}

export abstract class VideoControllerSlider extends VideoControllerElementBase<HTMLDivElement> {
    // The background element of the slider
    protected backgroundElement?: HTMLDivElement;

    // The progress element of the slider
    protected progressElement?: HTMLDivElement;

    // The exact value shown by the bar (0..1). Kept as a number, since the CSS width is rounded.
    private currentValue = 0;

    override onCreate(parentElement: HTMLElement): void {
        this.element = document.createElement('div');
        this.element.classList.add('ivc-control-element', 'ivc-control-bar');
        parentElement.appendChild(this.element);

        this.backgroundElement = document.createElement('div');
        this.backgroundElement.classList.add('ivc-control-bar-background');
        this.element.appendChild(this.backgroundElement);

        this.progressElement = document.createElement('div');
        this.progressElement.classList.add('ivc-control-bar-progress');
        this.backgroundElement.appendChild(this.progressElement);

        const options = this.listenerOptions;

        // Handle click event

        this.element.addEventListener(
            'click',
            (ev) => {
                // Prevent a-tag event of post
                ev.preventDefault();
                // Prevent React event
                ev.stopPropagation();
                this.handleClick(ev, true);
            },
            options
        );

        // Handle drag event. The start is bound to the element; the movement and the end are bound to the document
        // while dragging, so the gesture is not lost when the pointer leaves the bar or the bar is rebuilt.
        this.element.addEventListener(
            'mousedown',
            (ev) => this.onDragStart(ev),
            options
        );
        this.element.addEventListener(
            'touchstart',
            (ev) => this.onDragStart(ev),
            options
        );

        // Init the collapsed state (if set before creation)
        this.element.classList.toggle('hidden', this.collapsed);
    }

    private collapsed: boolean = false;

    // Sets if the slider is currently collapsed.
    public setCollapsed(collapsed: boolean) {
        this.collapsed = collapsed;
        if (!this.element) return;
        this.element.classList.toggle('hidden', this.collapsed);
    }

    // Sets the value of the bar.
    protected setValue(value: number) {
        this.currentValue = Math.max(Math.min(value, 1), 0);
        if (!this.progressElement) return;
        this.progressElement.style.width = `${Math.round(this.currentValue * 100)}%`;
    }

    // Is called when the value of the bar is changed by the user.
    abstract onValueChange(value: number): void;

    // Sub function to submit the current bar value
    private handleClick(event: MouseEvent | TouchEvent, invoke: boolean) {
        if (!this.backgroundElement || !this.progressElement) return;
        const rect = this.backgroundElement.getBoundingClientRect();
        // While collapsed the bar has no width and the position cannot be calculated.
        if (rect.width <= 0) return;

        const clientX =
            event instanceof MouseEvent
                ? event.clientX
                : (event.changedTouches[0] ?? event.touches[0])?.clientX;
        if (clientX === undefined) return;

        const relativeX = clientX - rect.left;
        const value = Math.max(Math.min(relativeX / rect.width, 1), 0);

        this.setValue(value);

        if (invoke) this.onValueChange(value);
    }

    // The user is dragging the slider
    protected isDragging = false;

    // Is set onValueChange will be called on every drag event
    protected invokeOnDrag = false;

    // Aborts the document listeners of the current drag gesture.
    private dragListeners?: AbortController;

    private onDragStart(ev: MouseEvent | TouchEvent) {
        // Only react to the primary mouse button. Right and middle clicks should not start a drag.
        if (ev instanceof MouseEvent && ev.button !== 0) return;

        ev.stopPropagation();
        this.startDrag();
    }

    private startDrag() {
        this.isDragging = true;

        // (Re-)bind the document listeners. This is also called after a rebuild, so an ongoing drag gesture continues
        // on the recreated slider.
        this.dragListeners?.abort();
        const listeners = new AbortController();
        this.dragListeners = listeners;
        const options: AddEventListenerOptions = { signal: listeners.signal };

        document.addEventListener(
            'mousemove',
            (ev) => this.onDrag(ev),
            options
        );
        document.addEventListener(
            'mouseup',
            (ev) => this.onDragEnd(ev),
            options
        );
        document.addEventListener(
            'touchmove',
            (ev) => this.onDrag(ev),
            options
        );
        document.addEventListener(
            'touchend',
            (ev) => this.onDragEnd(ev),
            options
        );
        document.addEventListener(
            'touchcancel',
            (ev) => this.onDragEnd(ev),
            options
        );
    }

    private endDrag() {
        this.isDragging = false;
        this.dragListeners?.abort();
        this.dragListeners = undefined;
    }

    private onDragEnd(ev: MouseEvent | TouchEvent) {
        if (!this.isDragging) return;
        ev.stopPropagation();
        this.endDrag();
        this.handleClick(ev, true);
    }

    private onDrag(ev: MouseEvent | TouchEvent) {
        if (!this.isDragging) return;
        ev.stopPropagation();
        this.handleClick(ev, this.invokeOnDrag);
    }

    // #region State

    public override saveState(): SliderState {
        const dragging = this.isDragging;

        // A pending drag value is committed before the control is removed. Without this, the value the user selected
        // would only live in the removed DOM element and the rebuilt bar would jump back to the old video state.
        // Applying it also means the video element and the rebuilt bar show the same value.
        if (dragging) {
            this.commitDragValue();
        }

        return {
            value: this.currentValue,
            dragging,
            collapsed: this.collapsed,
        };
    }

    // Applies a value that was selected during a drag but not yet handed to the video element.
    public override commitPendingChange() {
        if (!this.isDragging) return;
        this.commitDragValue();
    }

    private commitDragValue() {
        // Bars that call `onValueChange` on every drag step already applied the value to the video element.
        if (this.invokeOnDrag) return;
        this.onValueChange(this.currentValue);
    }

    public override restoreState(state: unknown): void {
        const sliderState = state as SliderState | undefined;
        if (!sliderState) return;

        // Restore the shown position. The regular update from the video element uses the same value, since a pending
        // drag value was committed in `saveState`.
        this.setValue(sliderState.value);

        // Restore the collapsed state, so a volume bar that was expanded for the drag stays expanded.
        this.setCollapsed(sliderState.collapsed);

        // Continue the gesture on the rebuilt element, so the next movement and the release still reach the slider.
        this.endDrag();
        if (sliderState.dragging) {
            this.startDrag();
        }
    }

    // #endregion State

    public override remove(): void {
        // Make sure no document listener of this slider survives the rebuild.
        this.endDrag();

        // Drop the references to the removed DOM, so a stale element cannot be reached through this instance.
        this.backgroundElement = undefined;
        this.progressElement = undefined;

        super.remove();
    }
}
