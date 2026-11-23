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
import { VideoPlayer } from '../src/ts/instagram/videoPlayer';
import { Resources } from '../src/ts/instagram/resources';
import {
    attachVideoPlayer,
    mouseEvent,
    sliderValue,
    stubRect,
} from './helpers/playerTestUtils';

function volumeBar(): HTMLElement {
    const element = document.querySelector('.ivc-volume-bar');
    if (!(element instanceof HTMLElement)) {
        throw new Error('No volume bar in the DOM');
    }
    stubRect(
        element.querySelector('.ivc-control-bar-background') as HTMLElement,
        100
    );
    // The volume bar is collapsed until the mute button or the bar is hovered.
    element.classList.remove('hidden');
    return element;
}

function muteButton(): HTMLElement {
    // The mute button is the control button that shows a speaker icon.
    const button = [...document.querySelectorAll('.ivc-icon-button')].find(
        (element) => {
            const img = element.querySelector('img');
            return !!img && /speaker/.test(img.src);
        }
    );
    if (!(button instanceof HTMLElement)) {
        throw new Error('No mute button in the DOM');
    }
    return button;
}

function rebuild(player: VideoPlayer) {
    player.updateControlSetting();
}

describe('CustomVideoController rebuild while dragging the volume bar', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        Settings.shared.videoControlMode = VideoControlMode.custom;
        Settings.shared.lastPlaybackVolume = 0;
        Settings.shared.showTimeCodeText = true;
        Settings.shared.showPlaybackSpeedOption = false;
        Settings.shared.showFullscreenButton = false;
        Settings.shared.showDownloadButton = false;

        // Distinct resource urls, so the test can tell the button icons apart.
        Resources.shared.urls.images.speakerOn = 'speaker-on.svg';
        Resources.shared.urls.images.speakerOff = 'speaker-off.svg';
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    test('keeps the volume and the drag gesture when the settings change mid-drag', () => {
        const { video, player } = attachVideoPlayer();

        const bar = volumeBar();
        bar.dispatchEvent(mouseEvent('mousedown', 0));
        bar.dispatchEvent(mouseEvent('mousemove', 30));
        expect(video.volume).toBeCloseTo(0.3, 5);

        rebuild(player);

        const rebuiltBar = volumeBar();
        expect(rebuiltBar).not.toBe(bar);

        // The rebuilt bar shows the volume of the video element.
        expect(sliderValue(rebuiltBar)).toBeCloseTo(video.volume, 2);

        // The drag continues on the rebuilt bar.
        rebuiltBar.dispatchEvent(mouseEvent('mousemove', 70));
        expect(video.volume).toBeCloseTo(0.7, 5);
        rebuiltBar.dispatchEvent(mouseEvent('mouseup', 70));
        expect(video.volume).toBeCloseTo(0.7, 5);

        // The rebuilt bar follows the video element after the drag ended.
        video.volume = 0.5;
        video.dispatchEvent(new Event('volumechange'));
        expect(sliderValue(rebuiltBar)).toBeCloseTo(0.5, 2);
    });

    test('the mute button shows the correct state after a rebuild', () => {
        const { video, player } = attachVideoPlayer();

        video.volume = 0;
        video.muted = false;
        rebuild(player);

        // Dragging the volume to zero mutes the video.
        const bar = volumeBar();
        bar.dispatchEvent(mouseEvent('mousedown', 0));
        bar.dispatchEvent(mouseEvent('mousemove', 0));
        expect(video.volume).toBe(0);
        expect(video.muted).toBe(true);

        rebuild(player);

        // The rebuilt bar shows zero and the mute button is in the muted state.
        expect(sliderValue(volumeBar())).toBe(0);
        const icon = muteButton().querySelector('img') as HTMLImageElement;
        expect(icon.src).toContain('speaker-off');
    });

    test('a rebuild does not reset the volume', () => {
        const { video, player } = attachVideoPlayer();
        video.volume = 0.42;
        video.muted = false;

        rebuild(player);

        expect(video.volume).toBeCloseTo(0.42, 5);
        expect(video.muted).toBe(false);
        expect(sliderValue(volumeBar())).toBeCloseTo(0.42, 2);
    });

    test('continues a collapsed volume bar in its expanded state during a drag', () => {
        const { player } = attachVideoPlayer();

        // Start the drag on the collapsed (zero width) bar. The pointer handling keeps it collapsed until a hover
        // event expands it.
        const bar = volumeBar();
        bar.classList.add('hidden');
        bar.dispatchEvent(mouseEvent('mousedown', 0));
        bar.classList.remove('hidden');

        rebuild(player);

        // The rebuilt bar must be expanded, otherwise the ongoing drag would end on a zero-width element.
        const rebuiltBar = volumeBar();
        expect(rebuiltBar.classList.contains('hidden')).toBe(false);
    });
});
