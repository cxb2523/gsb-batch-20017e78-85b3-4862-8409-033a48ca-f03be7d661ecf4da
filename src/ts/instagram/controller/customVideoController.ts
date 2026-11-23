import { VideoController } from './videoController';
import { VideoControllerElement } from './elements/videoControllerElement';
import { PlayButton } from './elements/playButton';
import { MuteButton } from './elements/muteButton';
import { PictureInPictureButton } from './elements/pictureInPictureButton';
import { FullscreenButton } from './elements/fullscreenButton';
import { PositionText } from './elements/positionText';
import { PlaybackSpeedButton } from './elements/playbackSpeedButton';
import { VolumeBar } from './elements/volumeBar';
import { SeekBar } from './elements/seekBar';
import { Settings } from '../../shared/settings';
import { DownloadButton } from './elements/downloadButton';

// The custom video controller.
export class CustomVideoController extends VideoController {
    //#region Control

    // The parent element for the control items.
    private controlElement: HTMLElement | undefined;

    // The control elements.
    private controls: VideoControllerElement[] = [];

    /**
     * Create the video controls.
     */
    public create() {
        const videoElement = this.videoElement;
        if (!videoElement) return;

        const controlHeight = 32;

        this.createVideoControlBackground();
        this.adjustVideoControlHeight(controlHeight);

        // Creating the actual player...
        if (!this.videoControlElement) return;

        this.controlElement = document.createElement('div');
        this.controlElement.classList.add('ivc-controls-content');
        this.videoControlElement.appendChild(this.controlElement);

        this.rebuildControlElements();

        // Init update
        this.updateControlBarVisibility();
    }

    /**
     * Recreates the control elements.
     * State of interactive controls (sliders) is carried over, so a rebuild triggered by a setting change does not
     * interrupt an ongoing drag.
     */
    private rebuildControlElements() {
        if (!this.controlElement) return;

        // Collect the state of the existing controls before they are replaced.
        const states = new Map<unknown, unknown>();
        for (const control of this.controls) {
            // Only controls that can hold an interactive state implement `saveState`.
            const state = control.saveState();
            if (state !== undefined) {
                states.set(control.constructor, state);
            }
        }

        // Remove previous controls. This also removes all their event listeners.
        for (const control of this.controls) {
            control.remove();
        }

        this.controls = this.getActiveControlElements();

        // Create the control elements
        for (const control of this.controls) {
            control.create(this.controlElement);

            // Restore the state of the previous control of the same type.
            const state = states.get(control.constructor);
            if (state !== undefined) {
                control.restoreState(state);
            }

            // Let the control pull the actual video element state. This runs after the restore, so only controls
            // without an interactive state (or sliders that are not being dragged) are overwritten.
            control.refresh();
        }
    }

    /**
     * Build the list of controls to spawn in the UI from the settings.
     */
    private getActiveControlElements(): VideoControllerElement[] {
        const settings = Settings.shared;
        const controls = [];

        controls.push(new PlayButton(this));

        // Create a mute and volume bar and make the volume bar collapse when not hovered.
        const mudeButton = new MuteButton(this);
        const volumeBar = new VolumeBar(this);
        volumeBar.setCollapsed(true);
        // Handle hover events
        mudeButton.pointerenter = volumeBar.pointerenter = () =>
            volumeBar.setCollapsed(false);
        mudeButton.pointerleave = volumeBar.pointerleave = () =>
            volumeBar.setCollapsed(true);

        controls.push(mudeButton);
        controls.push(volumeBar);

        if (settings.showTimeCodeText) {
            controls.push(new PositionText(this));
        }
        controls.push(new SeekBar(this));
        if (settings.showPlaybackSpeedOption) {
            controls.push(new PlaybackSpeedButton(this));
        }
        if (
            document.pictureInPictureEnabled &&
            settings.showPictureInPictureButton
        ) {
            controls.push(new PictureInPictureButton(this));
        }
        if (settings.showDownloadButton) {
            controls.push(new DownloadButton(this));
        }
        if (document.fullscreenEnabled && settings.showFullscreenButton) {
            controls.push(new FullscreenButton(this));
        }

        return controls;
    }

    public override remove() {
        // Remove all control elements and their listeners before the container goes away. An ongoing drag is
        // committed first, so the user's last input is not lost when the control bar disappears.
        for (const control of this.controls) {
            control.commitPendingChange();
            control.remove();
        }
        this.controls = [];

        if (this.controlElement) {
            this.controlElement.remove();
            this.controlElement = undefined;
        }

        super.remove();
    }

    //#endregion Control

    //#region Events

    public override onPlay() {
        for (const control of this.controls) {
            control.onPlay();
        }
    }
    public override onPause() {
        for (const control of this.controls) {
            control.onPause();
        }
    }
    public override onTimeUpdate() {
        for (const control of this.controls) {
            control.onTimeUpdate();
        }
    }
    public override onVolumeChange() {
        for (const control of this.controls) {
            control.onVolumeChange();
        }
    }
    public override onPlaybackSpeedChange() {
        for (const control of this.controls) {
            control.onPlaybackSpeedChange();
        }
    }
    public override onFullscreenChange() {
        for (const control of this.controls) {
            control.onFullscreenChange();
        }
    }
    public override onPictureInPictureChange() {
        for (const control of this.controls) {
            control.onPictureInPictureChange();
        }
    }
    public onUpdateSettings() {
        this.rebuildControlElements();
        this.updateControlBarVisibility();
    }

    //#endregion Events

    //#region Update

    protected setVisibility(visibility: boolean) {
        if (!this.videoControlElement) return;
        this.videoControlElement.classList.toggle('hidden', !visibility);
    }

    //#endregion Update
}
