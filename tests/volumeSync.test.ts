import {
    afterEach,
    beforeEach,
    describe,
    expect,
    jest,
    test,
} from '@jest/globals';
import { Settings } from '../src/ts/shared/settings';
import { VideoControlMode } from '../src/ts/shared/videoControlMode';
import { VideoDetector } from '../src/ts/instagram/videoDetector';
import { VideoPlayer } from '../src/ts/instagram/videoPlayer';
import { Resources } from '../src/ts/instagram/resources';
import {
    attachVideoPlayer,
    mouseEvent,
    stubRect,
} from './helpers/playerTestUtils';

// Registers an existing player with the detector, as `tryAttachPolarisVideo` would after detecting a video.
function register(detector: VideoDetector, player: VideoPlayer) {
    (detector as unknown as { videoPlayers: VideoPlayer[] }).videoPlayers.push(
        player
    );
}

// The stored volume is private. The test controls it directly to have a defined starting point.
function setStoredVolume(
    detector: VideoDetector,
    volume: number,
    muted: boolean
) {
    Settings.shared.lastPlaybackVolume = volume;
    (detector as unknown as { lastPlaybackMuted: boolean }).lastPlaybackMuted =
        muted;
}

function createDetector() {
    return new VideoDetector();
}

describe('VideoDetector volume synchronization', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        Settings.shared.videoControlMode = VideoControlMode.custom;
        Settings.shared.showTimeCodeText = false;
        Settings.shared.showPlaybackSpeedOption = false;
        Settings.shared.showFullscreenButton = false;
        Settings.shared.showDownloadButton = false;
        Resources.shared.urls.images.speakerOn = 'speaker-on.svg';
        Resources.shared.urls.images.speakerOff = 'speaker-off.svg';
        jest.useFakeTimers();
    });

    afterEach(() => {
        document.body.innerHTML = '';
        jest.useRealTimers();
    });

    test('reverts a volume change caused by Instagram during the play ignore window', () => {
        const detector = createDetector();
        setStoredVolume(detector, 0.4, false);

        const player = new VideoPlayer(detector);
        const videoRoot = document.createElement('div');
        const video = document.createElement('video');
        Object.defineProperty(video, 'duration', {
            value: 100,
            configurable: true,
        });
        videoRoot.appendChild(video);
        document.body.appendChild(videoRoot);
        player.videoRootElementRef = new WeakRef(videoRoot);
        player.videoElementRef = new WeakRef(video);
        player.attach();
        register(detector, player);

        // Playback starts. Instagram mutes Reels right after the play event.
        player.playbackManager.notifyVideoPlay(player);
        expect(video.volume).toBeCloseTo(0.4, 5);
        expect(video.muted).toBe(false);

        video.muted = true;
        video.dispatchEvent(new Event('volumechange'));

        // The change is undone and must not be written to the settings.
        expect(video.muted).toBe(false);
        expect(video.volume).toBeCloseTo(0.4, 5);
        expect(Settings.shared.lastPlaybackVolume).toBeCloseTo(0.4, 5);
    });

    test('a user volume change after the ignore window is synchronized to other videos', () => {
        const detector = createDetector();
        setStoredVolume(detector, 0.4, false);

        const first = attachVideoPlayer(detector);
        const second = attachVideoPlayer(detector);
        register(detector, first.player);
        register(detector, second.player);

        // Playback starts and the ignore window opens.
        first.player.playbackManager.notifyVideoPlay(first.player);
        jest.advanceTimersByTime(100);

        // The user changes the volume of the first video.
        first.player.applyUserVolume(() => {
            first.video.volume = 0.8;
        });

        expect(Settings.shared.lastPlaybackVolume).toBeCloseTo(0.8, 5);
        expect(second.video.volume).toBeCloseTo(0.8, 5);
    });

    test('a user volume change during the ignore window is not swallowed', () => {
        const detector = createDetector();
        setStoredVolume(detector, 0.4, false);

        const first = attachVideoPlayer(detector);
        const second = attachVideoPlayer(detector);
        register(detector, first.player);
        register(detector, second.player);

        first.player.playbackManager.notifyVideoPlay(first.player);

        // The user moves the volume bar while the ignore window is still open.
        first.player.applyUserVolume(() => {
            first.video.volume = 0.25;
        });

        expect(first.video.volume).toBeCloseTo(0.25, 5);
        expect(Settings.shared.lastPlaybackVolume).toBeCloseTo(0.25, 5);
        expect(second.video.volume).toBeCloseTo(0.25, 5);
    });

    test('the ignore window only covers the playback that opened it', () => {
        const detector = createDetector();
        setStoredVolume(detector, 0.4, false);

        const first = attachVideoPlayer(detector);
        const second = attachVideoPlayer(detector);
        register(detector, first.player);
        register(detector, second.player);

        first.player.playbackManager.notifyVideoPlay(first.player);

        // Another video changes its volume while the window of the first video is open.
        second.player.applyUserVolume(() => {
            second.video.volume = 0.7;
        });

        expect(Settings.shared.lastPlaybackVolume).toBeCloseTo(0.7, 5);
        expect(first.video.volume).toBeCloseTo(0.7, 5);
    });

    test('an asynchronous user volume event is still treated as user-initiated', () => {
        const detector = createDetector();
        setStoredVolume(detector, 0.4, false);

        const first = attachVideoPlayer(detector);
        const second = attachVideoPlayer(detector);
        register(detector, first.player);
        register(detector, second.player);

        first.player.playbackManager.notifyVideoPlay(first.player);

        // The user acts during the ignore window, but the browser dispatches the event later.
        first.player.applyUserVolume(() => {
            first.video.volume = 0.3;
        });
        first.video.dispatchEvent(new Event('volumechange'));

        expect(first.video.volume).toBeCloseTo(0.3, 5);
        expect(Settings.shared.lastPlaybackVolume).toBeCloseTo(0.3, 5);
        expect(second.video.volume).toBeCloseTo(0.3, 5);
    });

    test('an Instagram volume change during the ignore window is not mistaken for the user change', () => {
        const detector = createDetector();
        setStoredVolume(detector, 0.4, false);

        const first = attachVideoPlayer(detector);
        register(detector, first.player);

        first.player.playbackManager.notifyVideoPlay(first.player);

        // The user changes the volume, then Instagram mutes the video before the asynchronous event arrives.
        first.player.applyUserVolume(() => {
            first.video.volume = 0.6;
        });
        first.video.muted = true;
        first.video.dispatchEvent(new Event('volumechange'));

        // The page change is reverted to the stored, user-selected state.
        expect(first.video.muted).toBe(false);
        expect(first.video.volume).toBeCloseTo(0.6, 5);
        expect(Settings.shared.lastPlaybackVolume).toBeCloseTo(0.6, 5);
    });
});

describe('Mute button and volume bar after a rebuild', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        Settings.shared.videoControlMode = VideoControlMode.custom;
        Settings.shared.lastPlaybackVolume = 0.4;
        Settings.shared.showTimeCodeText = false;
        Settings.shared.showPlaybackSpeedOption = false;
        Settings.shared.showFullscreenButton = false;
        Settings.shared.showDownloadButton = false;
        Resources.shared.urls.images.speakerOn = 'speaker-on.svg';
        Resources.shared.urls.images.speakerOff = 'speaker-off.svg';
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    test('a mute button click during the ignore window is not reverted', () => {
        const detector = createDetector();
        setStoredVolume(detector, 0.4, true);

        const first = attachVideoPlayer(detector);
        const second = attachVideoPlayer(detector);
        register(detector, first.player);
        register(detector, second.player);

        first.player.playbackManager.notifyVideoPlay(first.player);
        expect(first.video.muted).toBe(true);

        // Click the mute button of the first player while the ignore window is open. It is the button whose icon is
        // the speaker icon (the play button is the first control of every player).
        const muteButton = [
            ...document.querySelectorAll('.ivc-icon-button'),
        ].find((element) =>
            /speaker/.test(element.querySelector('img')?.src ?? '')
        ) as HTMLElement;
        expect(muteButton).toBeDefined();
        muteButton.click();

        expect(first.video.muted).toBe(false);
        // The mute state is synchronized to the other video.
        expect(second.video.muted).toBe(false);
    });

    test('rebuilding the bar restores the volume from the video element', () => {
        const detector = createDetector();
        setStoredVolume(detector, 0.4, false);

        const { player, video } = attachVideoPlayer(detector);
        video.volume = 0.65;

        player.updateControlSetting();

        const progress = document.querySelector(
            '.ivc-volume-bar .ivc-control-bar-progress'
        ) as HTMLElement;
        expect(parseFloat(progress.style.width)).toBe(65);
        expect(video.volume).toBeCloseTo(0.65, 5);
    });
});
