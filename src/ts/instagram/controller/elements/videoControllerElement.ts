// Base class for video controller elements like buttons and bars
import { CustomVideoController } from '../customVideoController';
import { VideoPlayer } from '../../videoPlayer';

export abstract class VideoControllerElement {
    // The parent video controller
    private videoController?: CustomVideoController;

    // Shortcut to the video player
    protected get videoPlayer(): VideoPlayer | undefined {
        return this.videoController?.videoPlayer;
    }

    // Shortcut to the video element
    protected get videoElement(): HTMLVideoElement | undefined {
        return this.videoController?.videoElement;
    }

    public constructor(videoController: CustomVideoController) {
        this.videoController = videoController;
    }

    // Creates the controller element
    public create(parentElement: HTMLElement) {
        this.onCreate(parentElement);
        this.onAfterCreate();
        this.updateControl();
    }

    // Abstract creation method
    protected abstract onCreate(parentElement: HTMLElement): void;

    // Abstract method for after creation
    protected abstract onAfterCreate(): void;

    // Removes the created element again
    public abstract remove(): void;

    // Updates the control element
    protected abstract updateControl(): void;

    // Updates the control from the current video element state.
    // Used after a rebuild restored the interactive state of all controls.
    public refresh() {
        this.updateControl();
    }

    // Changes the visibility of the control
    public abstract setVisibility(visible: boolean): void;

    // #region State

    // Returns the state that has to be restored on the rebuilt control.
    // Called before the control is removed.
    public saveState(): unknown {
        return undefined;
    }

    // Commits a user interaction that is still in progress. Called before the control is removed for good, so the
    // user's last input is not lost when the control bar disappears (e.g. on a control mode change).
    public commitPendingChange(): void {
        // Nothing pending by default.
    }

    // Restores the state returned by `saveState` on the rebuilt control.
    public restoreState(state: unknown): void {
        // Nothing to restore by default.
        void state;
    }

    // #endregion State

    // #region Events

    public onPlay() {}
    public onPause() {}
    public onTimeUpdate() {}
    public onVolumeChange() {}
    public onPlaybackSpeedChange() {}
    public onFullscreenChange() {}
    public onPictureInPictureChange() {}

    // #endregion Events
}

export abstract class VideoControllerElementBase<
    TElement extends HTMLElement,
> extends VideoControllerElement {
    protected element?: TElement;

    // Aborts every DOM listener registered by this element instance. Elements are recreated on every control bar
    // rebuild, so aborting here makes sure no listener survives the rebuild.
    protected elementListeners = new AbortController();

    // Options for `addEventListener` that tie the listener to this element instance.
    protected get listenerOptions(): AddEventListenerOptions {
        return { signal: this.elementListeners.signal };
    }

    // Called right after onCreate.
    override onAfterCreate(): void {
        if (!this.element) return;
        this.registerHooks(this.element);
    }

    // Removes the created element again
    public override remove() {
        // Remove all listeners first, so no handler keeps the removed element alive or reacts to later events.
        this.elementListeners.abort();

        if (!this.element) return;
        this.element.remove();
        this.element = undefined;
    }

    // Changes the visibility of the text.
    public override setVisibility(visible: boolean) {
        if (!this.element) return;
        this.element.style.display = visible ? 'block' : 'none';
    }

    // #region Hooks

    // Hooks must be defined before creation
    public pointerenter?: (ev: PointerEvent) => void;
    public pointerleave?: (ev: PointerEvent) => void;

    private registerHooks(element: TElement) {
        const options = this.listenerOptions;

        if (this.pointerenter) {
            element.addEventListener(
                'pointerenter',
                (ev) => this.pointerenter?.(ev),
                options
            );
        }

        if (this.pointerleave) {
            element.addEventListener(
                'pointerleave',
                (ev) => this.pointerleave?.(ev),
                options
            );
        }
    }

    // #endregion Hooks
}
