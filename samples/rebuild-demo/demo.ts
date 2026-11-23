// A small, dependency free demo page for the control bar rebuild behavior.
// Build it with `npm run demo` and open `samples/rebuild-demo/index.html`.

import { Settings } from '../../src/ts/shared/settings';
import { VideoControlMode } from '../../src/ts/shared/videoControlMode';
import { VideoDetector } from '../../src/ts/instagram/videoDetector';
import { VideoPlayer } from '../../src/ts/instagram/videoPlayer';
import { Resources } from '../../src/ts/instagram/resources';

const logElement = document.getElementById('log') as HTMLDivElement;
const video = document.getElementById('video') as HTMLVideoElement;
const playerElement = document.getElementById('player') as HTMLDivElement;

function log(message: string) {
    const line = document.createElement('div');
    line.textContent = `${new Date().toLocaleTimeString()}  ${message}`;
    logElement.appendChild(line);
    logElement.scrollTop = logElement.scrollHeight;
}

function format(value: number) {
    return Number.isFinite(value) ? value.toFixed(2) : String(value);
}

// The demo has no video file to load. A fixed duration keeps the seek bar usable without one.
Object.defineProperty(video, 'duration', { value: 120 });

// The extension resolves these urls from its manifest. The demo resolves them from the source folder.
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
    sounds: {
        silence: '../../src/static/audio/silence.mp3',
    },
};

Settings.shared.videoControlMode = VideoControlMode.custom;
Settings.shared.lastPlaybackVolume = 0.4;
Settings.shared.showTimeCodeText = true;
Settings.shared.showPlaybackSpeedOption = true;
Settings.shared.showFullscreenButton = true;

// The detector acts as the playback manager. It contains the cross-video volume synchronization.
const detector = new VideoDetector();

const player = new VideoPlayer(detector);
player.videoRootElementRef = new WeakRef(playerElement);
player.videoElementRef = new WeakRef(video);

player.attach();

video.addEventListener('volumechange', () =>
    log(`volumechange: volume=${format(video.volume)} muted=${video.muted}`)
);
video.addEventListener('timeupdate', () =>
    log(`timeupdate: currentTime=${format(video.currentTime)}`)
);

// Show the values that matter after a rebuild: the video element state and the bar position.
function logBarState(prefix: string) {
    const barWidth = (selector: string) => {
        const bar = document.querySelector(selector);
        if (!bar) return 'n/a';
        const progress = bar.querySelector(
            '.ivc-control-bar-progress'
        ) as HTMLElement;
        return progress.style.width;
    };

    log(
        `${prefix}: currentTime=${format(video.currentTime)} seekBar=${barWidth('.ivc-seek-bar')} ` +
            `volume=${format(video.volume)} volumeBar=${barWidth('.ivc-volume-bar')} muted=${video.muted}`
    );
}

document.getElementById('rebuild')?.addEventListener('click', () => {
    logBarState('before rebuild');

    // This is exactly what a settings change does on Instagram.
    player.updateControlSetting();

    logBarState('after rebuild');
    log(
        `controls in DOM: ${document.querySelectorAll('.ivc-seek-bar').length} seek bar(s), ` +
            `${document.querySelectorAll('.ivc-volume-bar').length} volume bar(s)`
    );
});

document.getElementById('play')?.addEventListener('click', () => {
    if (video.paused) {
        video.play().catch(() => {
            log('playback is not possible: the demo has no video source');
        });
    } else {
        video.pause();
    }
});

document.getElementById('instagram-mute')?.addEventListener('click', () => {
    // Instagram mutes Reels shortly after playback starts. The detector reverts this change.
    log('simulating play + Instagram mute');
    detector.notifyVideoPlay(player);

    setTimeout(() => {
        video.muted = true;
        video.dispatchEvent(new Event('volumechange'));
        logBarState('after simulated Instagram mute');
    }, 10);
});

log('demo ready: drag a bar and click "Rebuild controls" while dragging');
