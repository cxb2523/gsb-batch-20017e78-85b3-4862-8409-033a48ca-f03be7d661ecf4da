import { VideoControllerSlider } from './videoControllerSlider';

export class VolumeBar extends VideoControllerSlider {
    override onCreate(parentElement: HTMLElement) {
        super.onCreate(parentElement);

        this.invokeOnDrag = true;

        if (!this.element) return;
        this.element.classList.add('ivc-volume-bar');
    }

    override updateControl() {
        if (!this.videoElement) return;
        // Every drag step is applied to the video element, so the video state is authoritative even while dragging.
        this.setValue(this.videoElement.volume);
    }

    override onValueChange(value: number): void {
        const videoElement = this.videoElement;
        if (!videoElement) return;

        // The user is changing the volume. Report the change as user-initiated, so the ignore window that counteracts
        // a volume reset caused by Instagram on playback start can never revert it.
        this.videoPlayer?.applyUserVolume(() => {
            videoElement.volume = value;
            videoElement.muted = videoElement.volume <= 0;
        });
    }

    override onVolumeChange() {
        this.updateControl();
    }
}
