// Browser self check for the rebuild behavior. It runs the acceptance scenarios against the real DOM instead of
// jsdom, which makes the layout dependent parts (getBoundingClientRect, drag events) realistic.
// Build with `npm run demo` and open `samples/rebuild-demo/selfcheck.html` in a browser.

import { Settings } from '../../src/ts/shared/settings';
import { VideoControlMode } from '../../src/ts/shared/videoControlMode';
import { VideoDetector } from '../../src/ts/instagram/videoDetector';
import { VideoPlayer } from '../../src/ts/instagram/videoPlayer';
import { Resources } from '../../src/ts/instagram/resources';

const results = document.getElementById('results') as HTMLDivElement;
const video = document.getElementById('video') as HTMLVideoElement;
const playerElement = document.getElementById('player') as HTMLDivElement;

type Check = {
    name: string;
    run: () => Promise<{ passed: boolean; detail: string }>;
};

function report(name: string, passed: boolean, detail?: string) {
    const line = document.createElement('div');
    line.className = `result ${passed ? 'pass' : 'fail'}`;
    line.textContent = `${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`;
    results.appendChild(line);
}

function mouse(type: string, target: EventTarget, clientX: number) {
    target.dispatchEvent(
        new MouseEvent(type, {
            clientX,
            bubbles: true,
            cancelable: true,
            button: 0,
            view: window,
        })
    );
}

function rectOf(element: Element) {
    return element.getBoundingClientRect();
}

function barValue(selector: string) {
    const progress = document.querySelector(
        `${selector} .ivc-control-bar-progress`
    ) as HTMLElement | null;
    if (!progress) return -1;
    return parseFloat(progress.style.width) / 100;
}

function seekBar() {
    return document.querySelector('.ivc-seek-bar') as HTMLElement;
}

function volumeBar() {
    return document.querySelector('.ivc-volume-bar') as HTMLElement;
}

function speakerIcon() {
    return document.querySelector(
        '.ivc-icon-button img[src*="speaker"]'
    ) as HTMLImageElement;
}

Object.defineProperty(video, 'duration', { value: 120 });

const image = (name: string) => `../../src/static/images/${name}`;
Resources.shared.urls = {
    images: {
        play: image('play.svg'),
        pause: image('pause.svg'),
        fullscreenEnter: image('fullscreen-enter.svg'),
        fullscreenExit: image('fullscreen-exit.svg'),
        speakerOn: image('speaker-on.svg'),
        speakerOff: image('speaker-off.svg'),
        pictureInPictureEnter: image('picture-in-picture-enter.svg'),
        pictureInPictureExit: image('picture-in-picture-exit.svg'),
        playbackSpeed: image('playback-speed.svg'),
        download: image('download.svg'),
    },
    sounds: { silence: '../../src/static/audio/silence.mp3' },
};

Settings.shared.videoControlMode = VideoControlMode.custom;
Settings.shared.lastPlaybackVolume = 0.4;
Settings.shared.showTimeCodeText = false;
Settings.shared.showPlaybackSpeedOption = false;
Settings.shared.showFullscreenButton = false;
Settings.shared.showDownloadButton = false;

const detector = new VideoDetector();
const player = new VideoPlayer(detector);
player.videoRootElementRef = new WeakRef(playerElement);
player.videoElementRef = new WeakRef(video);
player.attach();

// Give the browser a chance to apply the DOM changes. Reading a layout value forces a reflow.
function nextFrame(): Promise<void> {
    return new Promise((resolve) =>
        setTimeout(() => {
            // Forces the layout to be up to date before the next step measures the bars.
            document.body.offsetHeight;
            resolve();
        }, 0)
    );
}

// Resets the state the checks depend on between the scenarios.
function resetVolume(volume: number, muted: boolean) {
    video.volume = volume;
    video.muted = muted;
}

// Expands the collapsed volume bar, like hovering the player does.
async function expandVolumeBar() {
    const mute = speakerIcon().parentElement as HTMLElement;
    mute.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
    await nextFrame();
}

// Waits for a bar to have a width again after a rebuild.
async function waitForBarWidth(selector: string) {
    for (let i = 0; i < 50; i++) {
        await nextFrame();
        const bar = document.querySelector(selector);
        if (!bar) continue;
        const background = bar.querySelector(
            '.ivc-control-bar-background'
        ) as HTMLElement;
        if (background.getBoundingClientRect().width > 0) return;
    }
}

const checks: Check[] = [
    {
        name: 'seek bar keeps position and drag when rebuilt mid-drag',
        run: async () => {
            video.currentTime = 0;
            await nextFrame();

            const bar = seekBar();
            const rect = rectOf(
                bar.querySelector('.ivc-control-bar-background') as HTMLElement
            );

            mouse('mousedown', bar, rect.left + rect.width * 0.25);
            mouse('mousemove', document, rect.left + rect.width * 0.75);

            // Settings change while the mouse is still down.
            player.updateControlSetting();
            await nextFrame();

            const rebuilt = seekBar();
            const expected = video.currentTime / video.duration;
            const shown = barValue('.ivc-seek-bar');
            if (Math.abs(shown - expected) > 0.02) {
                return {
                    passed: false,
                    detail: `bar ${shown.toFixed(2)} != video ${expected.toFixed(2)}`,
                };
            }

            // Releasing the mouse over the rebuilt bar jumps to that position.
            const rebuiltRect = rectOf(
                rebuilt.querySelector(
                    '.ivc-control-bar-background'
                ) as HTMLElement
            );
            mouse(
                'mouseup',
                document,
                rebuiltRect.left + rebuiltRect.width * 0.5
            );
            await nextFrame();

            const passed =
                Math.abs(video.currentTime - video.duration * 0.5) <
                video.duration * 0.02;
            return {
                passed,
                detail: `currentTime ${video.currentTime.toFixed(1)} of ${video.duration}`,
            };
        },
    },
    {
        name: 'volume bar keeps position and mute button state when rebuilt mid-drag',
        run: async () => {
            resetVolume(0.5, false);
            await nextFrame();
            await expandVolumeBar();

            const bar = volumeBar();
            const rect = rectOf(
                bar.querySelector('.ivc-control-bar-background') as HTMLElement
            );
            if (rect.width <= 0) {
                return { passed: false, detail: 'volume bar has no width' };
            }

            mouse('mousedown', bar, rect.left + rect.width * 0.5);
            mouse('mousemove', document, rect.left + rect.width * 0.8);

            // Settings change while the mouse is still down.
            player.updateControlSetting();
            await waitForBarWidth('.ivc-volume-bar');

            const shown = barValue('.ivc-volume-bar');
            if (Math.abs(shown - video.volume) > 0.02) {
                return {
                    passed: false,
                    detail: `bar ${shown.toFixed(2)} != volume ${video.volume.toFixed(2)}`,
                };
            }

            // The drag continues on the rebuilt bar: pull the volume to zero.
            const rebuilt = volumeBar();
            const rebuiltRect = rectOf(
                rebuilt.querySelector(
                    '.ivc-control-bar-background'
                ) as HTMLElement
            );
            mouse('mousedown', rebuilt, rebuiltRect.left);
            mouse('mouseup', document, rebuiltRect.left);
            await nextFrame();

            const passed =
                video.volume === 0 &&
                video.muted &&
                speakerIcon().src.includes('speaker-off') &&
                Math.abs(barValue('.ivc-volume-bar')) < 0.02;
            return {
                passed,
                detail: `volume ${video.volume}, muted ${video.muted}, bar ${barValue('.ivc-volume-bar')}`,
            };
        },
    },
    {
        name: 'user volume change after the ignore window is synchronized to other videos',
        run: async () => {
            // Start with a known, unmuted state. The change is stored, since no ignore window is open.
            resetVolume(0.4, false);
            video.dispatchEvent(new Event('volumechange'));
            await nextFrame();

            detector.notifyVideoPlay(player);
            requestAnimationFrame(() => {});

            // Wait for the ignore window to expire.
            await new Promise((resolve) => setTimeout(resolve, 100));

            player.applyUserVolume(() => {
                video.volume = 0.7;
            });

            const passed =
                Math.abs(Settings.shared.lastPlaybackVolume - 0.7) < 0.001;
            return {
                passed,
                detail: `stored volume ${Settings.shared.lastPlaybackVolume.toFixed(2)}`,
            };
        },
    },
    {
        name: 'Instagram volume change in the ignore window is reverted and not stored',
        run: async () => {
            // Establish an unmuted baseline, so the incoming mute is an actual change.
            resetVolume(0.4, false);
            video.dispatchEvent(new Event('volumechange'));
            await nextFrame();

            detector.notifyVideoPlay(player);

            // Instagram mutes the video right after playback starts.
            video.muted = true;
            video.dispatchEvent(new Event('volumechange'));

            const passed =
                !video.muted &&
                Math.abs(video.volume - 0.4) < 0.001 &&
                Math.abs(Settings.shared.lastPlaybackVolume - 0.4) < 0.001;
            return {
                passed,
                detail: `volume ${video.volume}, muted ${video.muted}, stored ${Settings.shared.lastPlaybackVolume}`,
            };
        },
    },
];

async function run() {
    for (const check of checks) {
        try {
            const result = await check.run();
            report(check.name, result.passed, result.detail);
        } catch (ex) {
            report(check.name, false, String(ex));
        }
    }
    (window as unknown as { __selfCheckDone: boolean }).__selfCheckDone = true;
}

run().then();
