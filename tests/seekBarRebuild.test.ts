import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { Settings } from '../src/ts/shared/settings';
import { VideoControlMode } from '../src/ts/shared/videoControlMode';
import { VideoPlayer } from '../src/ts/instagram/videoPlayer';
import {
    attachVideoPlayer,
    mouseEvent,
    sliderValue,
    stubRect,
} from './helpers/playerTestUtils';

// Reads the seek bar that is currently in the DOM.
function seekBar(): HTMLElement {
    const element = document.querySelector('.ivc-seek-bar');
    if (!(element instanceof HTMLElement)) {
        throw new Error('No seek bar in the DOM');
    }
    stubRect(
        element.querySelector('.ivc-control-bar-background') as HTMLElement
    );
    return element;
}

// Simulates a settings change that rebuilds the control bar.
function rebuild(player: VideoPlayer) {
    player.updateControlSetting();
}

describe('CustomVideoController rebuild while dragging the seek bar', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        Settings.shared.videoControlMode = VideoControlMode.custom;
        Settings.shared.showTimeCodeText = true;
        Settings.shared.showPlaybackSpeedOption = true;
        Settings.shared.showFullscreenButton = true;
        Settings.shared.showDownloadButton = false;
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    test('keeps the position and the drag gesture when the settings change mid-drag', () => {
        const { video, player } = attachVideoPlayer();

        const bar = seekBar();
        video.currentTime = 20;

        // Start dragging and move to 60%. The seek bar only previews the position while the user drags.
        bar.dispatchEvent(mouseEvent('mousedown', 0));
        bar.dispatchEvent(mouseEvent('mousemove', 120));
        expect(sliderValue(bar)).toBeCloseTo(0.6, 2);
        expect(video.currentTime).toBe(20);

        // A setting change rebuilds the control bar while the user is still dragging. The pending drag position is
        // committed to the video element, so the rebuilt bar and the video state agree.
        rebuild(player);
        expect(video.currentTime).toBe(60);

        const rebuiltBar = seekBar();
        expect(rebuiltBar).not.toBe(bar);
        expect(sliderValue(rebuiltBar)).toBeCloseTo(video.currentTime / 100, 2);

        // The drag continues: moving the mouse over the new bar and releasing it jumps to the release position.
        rebuiltBar.dispatchEvent(mouseEvent('mousemove', 80));
        rebuiltBar.dispatchEvent(mouseEvent('mouseup', 80));
        expect(video.currentTime).toBe(40);

        // The rebuilt bar follows the video element again after the drag ended.
        video.currentTime = 10;
        video.dispatchEvent(new Event('timeupdate'));
        expect(sliderValue(rebuiltBar)).toBeCloseTo(0.1, 2);
    });

    test('commits the pending drag position on rebuild even without a release event', () => {
        const { video, player } = attachVideoPlayer();
        const bar = seekBar();

        bar.dispatchEvent(mouseEvent('mousedown', 0));
        bar.dispatchEvent(mouseEvent('mousemove', 140));
        expect(sliderValue(bar)).toBeCloseTo(0.7, 2);

        rebuild(player);

        // The video element now has the dragged position and the bar shows it.
        expect(video.currentTime).toBe(70);
        expect(sliderValue(seekBar())).toBeCloseTo(0.7, 2);
    });

    test('a rebuild without an ongoing drag does not move the video', () => {
        const { video, player } = attachVideoPlayer();
        video.currentTime = 15;

        rebuild(player);

        expect(video.currentTime).toBe(15);
        expect(sliderValue(seekBar())).toBeCloseTo(0.15, 2);
    });

    test('does not leave old elements or listeners behind after a rebuild', () => {
        const { video, player } = attachVideoPlayer();

        const firstBar = seekBar();
        rebuild(player);

        // The old element is gone from the DOM.
        expect(firstBar.isConnected).toBe(false);
        expect(document.querySelectorAll('.ivc-seek-bar')).toHaveLength(1);

        // The old element is detached.
        expect(firstBar.parentElement).toBeNull();

        // Its listeners are removed, so interacting with the stale element has no effect.
        video.currentTime = 20;
        const before = video.currentTime;
        firstBar.dispatchEvent(mouseEvent('mousedown', 0));
        firstBar.dispatchEvent(mouseEvent('mousemove', 150));
        firstBar.dispatchEvent(mouseEvent('click', 150));
        expect(video.currentTime).toBe(before);
    });

    test('does not accumulate controls over many rebuilds', () => {
        const { player } = attachVideoPlayer();

        for (let i = 0; i < 5; i++) {
            rebuild(player);
        }

        expect(document.querySelectorAll('.ivc-controls')).toHaveLength(1);
        expect(document.querySelectorAll('.ivc-seek-bar')).toHaveLength(1);
        expect(document.querySelectorAll('.ivc-volume-bar')).toHaveLength(1);
    });

    test('commits the drag position when the controls are removed', () => {
        const { video, player } = attachVideoPlayer();
        const bar = seekBar();

        bar.dispatchEvent(mouseEvent('mousedown', 0));
        bar.dispatchEvent(mouseEvent('mousemove', 100));
        expect(sliderValue(bar)).toBeCloseTo(0.5, 2);

        // A control mode change removes the controls completely and re-creates them.
        player.updateControlMode();

        // The position the user selected before the control bar disappeared is kept.
        expect(video.currentTime).toBe(50);
        expect(document.querySelectorAll('.ivc-controls')).toHaveLength(1);
        expect(sliderValue(seekBar())).toBeCloseTo(0.5, 2);
    });
});
