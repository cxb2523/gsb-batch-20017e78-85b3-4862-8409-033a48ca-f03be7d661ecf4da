import { VideoPlayer } from '../../src/ts/instagram/videoPlayer';
import { PlaybackManager } from '../../src/ts/instagram/playbackManager';

// A playback manager that does nothing. Used when the test only cares about the UI.
export const noopPlaybackManager: PlaybackManager = {
    notifyVideoPlay: () => {},
    notifyVideoVolumeChange: () => {},
    notifyVideoPlaybackSpeedChange: () => {},
};

// Creates a video element and attaches a video player to it, like the content script does on Instagram.
export function attachVideoPlayer(
    playbackManager: PlaybackManager = noopPlaybackManager
) {
    const videoRoot = document.createElement('div');
    document.body.appendChild(videoRoot);

    const video = document.createElement('video');

    // jsdom does not implement media playback, so the read-only properties are stubbed.
    Object.defineProperty(video, 'duration', {
        value: 100,
        writable: true,
        configurable: true,
    });
    Object.defineProperty(video, 'paused', {
        value: true,
        writable: true,
        configurable: true,
    });

    videoRoot.appendChild(video);

    const player = new VideoPlayer(playbackManager);
    player.videoRootElementRef = new WeakRef(videoRoot);
    player.videoElementRef = new WeakRef(video);
    player.attach();

    return { player, video, videoRoot };
}

// Replaces the client rect of an element, since jsdom has no layout.
export function stubRect(element: HTMLElement, width: number = 200) {
    element.getBoundingClientRect = () =>
        ({
            left: 0,
            top: 0,
            right: width,
            bottom: 10,
            width,
            height: 10,
            x: 0,
            y: 0,
            toJSON: () => ({}),
        }) as DOMRect;
}

export function mouseEvent(type: string, clientX: number): MouseEvent {
    return new MouseEvent(type, {
        clientX,
        bubbles: true,
        cancelable: true,
        button: 0,
    });
}

// Returns the currently displayed value of a slider (0..1).
export function sliderValue(slider: Element): number {
    const progress = slider.querySelector(
        '.ivc-control-bar-progress'
    ) as HTMLElement | null;
    if (!progress) throw new Error('Slider has no progress element');
    return parseFloat(progress.style.width) / 100;
}
