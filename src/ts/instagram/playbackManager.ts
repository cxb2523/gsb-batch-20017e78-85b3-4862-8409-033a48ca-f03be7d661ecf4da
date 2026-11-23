// The playback manager handles the volume states of the different videos and synchronizes it across all players.
import { VideoPlayer } from './videoPlayer';

export interface PlaybackManager {
    // Must be called whenever a video playback was started.
    notifyVideoPlay(videoPlayer: VideoPlayer): void;

    // Must be called whenever a video volume was changed.
    // `userInitiated` is set when the change was caused by an explicit user interaction with our controls. Such
    // changes must never be swallowed by the ignore window that counteracts Instagram's volume reset on playback.
    notifyVideoVolumeChange(
        videoPlayer: VideoPlayer,
        userInitiated?: boolean
    ): void;
    // Must be called whenever a video playback speed was changed.
    notifyVideoPlaybackSpeedChange(videoPlayer: VideoPlayer): void;
}
