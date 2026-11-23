import { VideoControllerSlider } from './videoControllerSlider';

export class SeekBar extends VideoControllerSlider {
    override onCreate(parentElement: HTMLElement) {
        super.onCreate(parentElement);

        if (!this.element) return;
        this.element.classList.add('ivc-seek-bar');
    }

    override updateControl() {
        if (!this.videoElement) return;

        // Ignore updates if the user is dragging the bar
        if (this.isDragging) return;

        const duration = this.videoElement.duration;
        // The duration is NaN until the metadata is loaded.
        if (!isFinite(duration) || duration <= 0) {
            this.setValue(0);
            return;
        }

        const progress = this.videoElement.currentTime / duration;
        this.setValue(progress);
    }

    override onValueChange(value: number): void {
        if (!this.videoElement) return;

        const duration = this.videoElement.duration;
        if (!isFinite(duration)) return;

        this.videoElement.currentTime = value * duration;
    }

    override onTimeUpdate() {
        this.updateControl();
    }
}
