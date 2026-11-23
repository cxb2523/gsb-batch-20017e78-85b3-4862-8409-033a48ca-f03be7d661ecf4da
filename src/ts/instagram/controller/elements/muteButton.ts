import { VideoControllerButton } from './videoControllerButton';
import { Resources } from '../../resources';

export class MuteButton extends VideoControllerButton {
    override updateControl() {
        const isMuted = !!this.videoElement?.muted;
        this.setIcon(
            isMuted
                ? Resources.shared.urls.images.speakerOff
                : Resources.shared.urls.images.speakerOn
        );
        this.setTitle(
            isMuted
                ? Resources.shared.locales.unmuteTooltip
                : Resources.shared.locales.muteTooltip
        );
    }

    override onClick() {
        const videoElement = this.videoElement;
        if (!videoElement) return;

        // A user-triggered mute / unmute must not be swallowed by the ignore window that counteracts Instagram's
        // volume reset on playback start.
        this.videoPlayer?.applyUserVolume(() => {
            videoElement.muted = !videoElement.muted;

            // Fallback when volume is still set to zero
            if (!videoElement.muted && videoElement.volume === 0) {
                videoElement.volume = 0.1;
            }
        });
    }

    override onVolumeChange() {
        this.updateControl();
    }
}
