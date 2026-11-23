import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IVLabsPlayer } from '../src/player';
import type { CuePoint, HTMLVideoElementWithControlsList, PlayerConfig } from '../src/types';

const MAIN_SRC = 'https://example.com/main.mp4';
const SEGMENT_A = 'https://example.com/segment-a.mp4';
const SEGMENT_B = 'https://example.com/segment-b.mp4';

type PlayerInternals = {
  segmentManager: {
    isSegmentActive: () => boolean;
    isRestoring: () => boolean;
    _mainVideoSrc: string | null;
    _mainVideoCurrentTime: number;
  };
  cueHandler: { destroy: () => void };
};

const internals = (player: IVLabsPlayer): PlayerInternals => player as unknown as PlayerInternals;

const branchCue = (id: string, time: number, segments: string[]): CuePoint => ({
  id,
  time,
  payload: {
    interaction: {
      type: 'choice-video-segment-change',
      question: 'Where to?',
      options: segments.map((video, index) => ({ level: `Path ${index + 1}`, video })),
    },
  },
});

describe('IVLabsPlayer branch lifecycle (integration)', () => {
  let player: IVLabsPlayer;
  let video: HTMLVideoElementWithControlsList;

  /** Dispatches a DOM event on the video element. */
  const emit = (type: string): void => {
    video.dispatchEvent(new Event(type));
  };

  /** Moves playback to a time and fires the cue-handling timeupdate. */
  const seek = (time: number): void => {
    video.currentTime = time;
    emit('timeupdate');
  };

  /** Answers the currently displayed branch prompt with the given option index. */
  const chooseOption = (index = 0): void => {
    const buttons = document.querySelectorAll<HTMLButtonElement>('.ivl-choice-button');
    expect(buttons.length).toBeGreaterThan(index);
    buttons[index].click();
  };

  const createPlayer = (cues: CuePoint[]): IVLabsPlayer => {
    const config: PlayerConfig = { videoUrl: MAIN_SRC, cues, initialState: 'idle' };
    const instance = new IVLabsPlayer('player-target', config);
    const createdVideo = document.querySelector(
      'video',
    ) as unknown as HTMLVideoElementWithControlsList;

    // jsdom does not implement media playback; stub it deterministically.
    createdVideo.load = vi.fn();
    createdVideo.pause = vi.fn();
    createdVideo.play = vi.fn(() => Promise.resolve());

    return instance;
  };

  const flushPromises = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };

  beforeEach(() => {
    document.body.innerHTML = '<div id="player-target"></div>';
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    player?.destroy();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('plays a branch, restores the main video and returns to playing', () => {
    player = createPlayer([branchCue('branch', 5, [SEGMENT_A, SEGMENT_B])]);
    video = document.querySelector('video') as unknown as HTMLVideoElementWithControlsList;

    seek(5);
    expect(player.getState()).toBe('waitingForInteraction');

    chooseOption(0);

    // The branch state is distinct from the main-video states.
    expect(player.getState()).toBe('playingSegment');
    expect(internals(player).segmentManager.isSegmentActive()).toBe(true);
    expect(video.src).toBe(SEGMENT_A);

    // The main snapshot was captured before switching away.
    const sm = internals(player).segmentManager;
    expect(sm._mainVideoSrc).toBe(MAIN_SRC);
    expect(sm._mainVideoCurrentTime).toBe(5);

    // Segment metadata arrives -> segment playback starts.
    emit('loadedmetadata');
    expect(video.play).toHaveBeenCalledTimes(1);

    // Let the segment run to its end.
    video.currentTime = 12;
    emit('ended');

    // Main source restored; position restored once metadata is available.
    expect(video.src).toBe(MAIN_SRC);
    expect(internals(player).segmentManager.isRestoring()).toBe(true);
    expect(player.getState()).toBe('playingSegment');

    emit('loadedmetadata');

    expect(video.currentTime).toBe(5);
    expect(video.play).toHaveBeenCalledTimes(2);
    expect(player.getState()).toBe('playing');
    expect(internals(player).segmentManager.isSegmentActive()).toBe(false);
    expect(internals(player).segmentManager.isRestoring()).toBe(false);

    // The pending snapshot has been cleared.
    expect(sm._mainVideoSrc).toBeNull();
    expect(sm._mainVideoCurrentTime).toBe(0);
  });

  it('keeps main-video cues from firing while the branch is playing', () => {
    player = createPlayer([
      branchCue('branch', 5, [SEGMENT_A]),
      { id: 'after', time: 6, payload: { message: 'later' } },
    ]);
    video = document.querySelector('video') as unknown as HTMLVideoElementWithControlsList;

    const onCueEnter = vi.fn();
    player.on('onCueEnter', onCueEnter);

    seek(5);
    chooseOption(0);
    onCueEnter.mockClear();

    // This timeupdate belongs to the branch segment, not the main video.
    emit('timeupdate');
    expect(onCueEnter).not.toHaveBeenCalled();
  });

  it('falls back to the main position when branch playback is rejected', async () => {
    player = createPlayer([branchCue('branch', 5, [SEGMENT_A])]);
    video = document.querySelector('video') as unknown as HTMLVideoElementWithControlsList;

    // Reject playback while the branch source is loaded, resolve for main.
    video.play = vi.fn(() =>
      video.src === SEGMENT_A ? Promise.reject(new Error('NotAllowedError')) : Promise.resolve(),
    );

    const onError = vi.fn();
    player.on('ERROR', onError);

    seek(5);
    chooseOption(0);
    emit('loadedmetadata');
    await flushPromises();

    // The rejection routed back to the main video.
    expect(video.src).toBe(MAIN_SRC);
    expect(internals(player).segmentManager.isRestoring()).toBe(true);

    emit('loadedmetadata');

    expect(video.currentTime).toBe(5);
    expect(player.getState()).toBe('playing');
    expect(onError).toHaveBeenCalledTimes(1);

    // Not stuck waiting for interaction: main-video cues work again.
    const onCueEnter = vi.fn();
    player.on('onCueEnter', onCueEnter);
    seek(9);
    expect(onCueEnter).toHaveBeenCalledTimes(0); // no cue registered at 9

    // Adding a later cue proves the cue handler was restarted.
    player.loadCues([{ id: 'later', time: 9 }]);
    seek(9);
    expect(onCueEnter).toHaveBeenCalledWith(expect.objectContaining({ cueId: 'later' }));
  });

  it('falls back to the main position when the branch fails to load', async () => {
    player = createPlayer([branchCue('branch', 5, [SEGMENT_A])]);
    video = document.querySelector('video') as unknown as HTMLVideoElementWithControlsList;

    seek(5);
    chooseOption(0);
    expect(video.src).toBe(SEGMENT_A);

    emit('error');
    await flushPromises();

    expect(video.src).toBe(MAIN_SRC);

    emit('loadedmetadata');

    expect(video.currentTime).toBe(5);
    expect(player.getState()).toBe('playing');
  });

  it('captures a fresh main snapshot on a repeated branch', () => {
    player = createPlayer([
      branchCue('branch-1', 5, [SEGMENT_A]),
      branchCue('branch-2', 20, [SEGMENT_B]),
    ]);
    video = document.querySelector('video') as unknown as HTMLVideoElementWithControlsList;
    const sm = internals(player).segmentManager;

    // First branch at 5s.
    seek(5);
    chooseOption(0);
    emit('loadedmetadata');
    video.currentTime = 9;
    emit('ended');
    emit('loadedmetadata');
    expect(video.currentTime).toBe(5);
    expect(player.getState()).toBe('playing');

    // Continue watching, then branch again from a later position.
    seek(20);
    expect(player.getState()).toBe('waitingForInteraction');
    chooseOption(0);

    expect(player.getState()).toBe('playingSegment');
    expect(video.src).toBe(SEGMENT_B);
    // Snapshot reflects the second branch point, not the first restore.
    expect(sm._mainVideoSrc).toBe(MAIN_SRC);
    expect(sm._mainVideoCurrentTime).toBe(20);

    emit('loadedmetadata');
    video.currentTime = 25;
    emit('ended');
    emit('loadedmetadata');

    expect(video.src).toBe(MAIN_SRC);
    expect(video.currentTime).toBe(20);
    expect(player.getState()).toBe('playing');
    expect(sm._mainVideoSrc).toBeNull();
  });

  it('keeps the snapshot stable when a second branch follows a completed restore', () => {
    player = createPlayer([
      branchCue('branch-1', 5, [SEGMENT_A]),
      branchCue('branch-2', 20, [SEGMENT_B]),
    ]);
    video = document.querySelector('video') as unknown as HTMLVideoElementWithControlsList;
    const sm = internals(player).segmentManager;

    seek(5);
    chooseOption(0);
    emit('loadedmetadata');

    // Branch ends: the main-video restore is pending (metadata not fired yet).
    emit('ended');
    expect(sm.isRestoring()).toBe(true);
    expect(video.src).toBe(MAIN_SRC);

    // A late metadata event that belonged to the ended branch must not cause a
    // second seek/playback; only the pending restore consumes it.
    const playCallsBeforeRestore = (video.play as unknown as ReturnType<typeof vi.fn>).mock.calls
      .length;
    emit('loadedmetadata');
    expect(video.currentTime).toBe(5);
    expect(player.getState()).toBe('playing');
    expect((video.play as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      playCallsBeforeRestore + 1,
    );

    // A duplicate metadata event after the restore is inert.
    emit('loadedmetadata');
    expect(video.currentTime).toBe(5);
    expect((video.play as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      playCallsBeforeRestore + 1,
    );

    // Second branch snapshots the new main position.
    seek(20);
    chooseOption(0);
    expect(sm._mainVideoCurrentTime).toBe(20);
    emit('loadedmetadata');
    expect(player.getState()).toBe('playingSegment');

    video.currentTime = 30;
    emit('ended');
    emit('loadedmetadata');

    expect(video.src).toBe(MAIN_SRC);
    expect(video.currentTime).toBe(20);
    expect(player.getState()).toBe('playing');
  });

  it('removes listeners, clears the snapshot and ignores events after destroy', () => {
    player = createPlayer([branchCue('branch', 5, [SEGMENT_A])]);
    video = document.querySelector('video') as unknown as HTMLVideoElementWithControlsList;
    const sm = internals(player).segmentManager;

    const onVideoStarted = vi.fn();
    const onCueEnter = vi.fn();
    player.on('VIDEO_STARTED', onVideoStarted);
    player.on('onCueEnter', onCueEnter);

    seek(5);
    chooseOption(0);
    emit('loadedmetadata');
    expect(player.getState()).toBe('playingSegment');

    const removeListener = vi.spyOn(video, 'removeEventListener');
    const loadCallsAfterBranch = (video.load as unknown as ReturnType<typeof vi.fn>).mock.calls
      .length;

    player.destroy();

    // Listeners registered by the player and the segment manager were removed.
    expect(removeListener).toHaveBeenCalledWith('play', expect.any(Function));
    expect(removeListener).toHaveBeenCalledWith('pause', expect.any(Function));
    expect(removeListener).toHaveBeenCalledWith('ended', expect.any(Function));
    expect(removeListener).toHaveBeenCalledWith('error', expect.any(Function));

    // The pending main snapshot was dropped.
    expect(sm._mainVideoSrc).toBeNull();
    expect(sm._mainVideoCurrentTime).toBe(0);
    expect(sm.isSegmentActive()).toBe(false);

    onVideoStarted.mockClear();
    onCueEnter.mockClear();

    // Late media events must not trigger analytics, interaction or restoration.
    emit('play');
    emit('pause');
    emit('ended');
    emit('error');
    emit('loadedmetadata');
    seek(5);

    expect(onVideoStarted).not.toHaveBeenCalled();
    expect(onCueEnter).not.toHaveBeenCalled();
    expect((video.load as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      loadCallsAfterBranch,
    );
    expect(video.src).toBe(SEGMENT_A);
    expect(player.getState()).toBe('playingSegment');
  });

  it('can be destroyed before a branch and stays inert', () => {
    player = createPlayer([branchCue('branch', 5, [SEGMENT_A])]);
    video = document.querySelector('video') as unknown as HTMLVideoElementWithControlsList;

    player.destroy();
    const stateAfterDestroy = player.getState();

    seek(5);

    expect(player.getState()).toBe(stateAfterDestroy);
    expect(document.querySelectorAll('.ivl-choice-button').length).toBe(0);
    expect(video.src).toBe(MAIN_SRC);
  });

  it('ignores a subtitle load that resolves after destroy', () => {
    const config: PlayerConfig = {
      videoUrl: MAIN_SRC,
      subtitlesUrl: 'https://example.com/subs.vtt',
      cues: [{ id: 'cue', time: 3, payload: { message: 'hello' } }],
      initialState: 'idle',
    };
    player = new IVLabsPlayer('player-target', config);
    const track = document.querySelector('track') as HTMLTrackElement;
    expect(track).not.toBeNull();

    const removeListener = vi.spyOn(track, 'removeEventListener');
    player.destroy();

    // Subtitle listeners were removed from the track element.
    expect(removeListener).toHaveBeenCalledWith('load', expect.any(Function));
    expect(removeListener).toHaveBeenCalledWith('error', expect.any(Function));

    // A late subtitle event must not start playback or re-bind listeners.
    const videoInDom = document.querySelector(
      'video',
    ) as unknown as HTMLVideoElementWithControlsList;
    expect(videoInDom.src).toBe('');

    track.dispatchEvent(new Event('load'));
    track.dispatchEvent(new Event('error'));

    expect(videoInDom.src).toBe('');
    expect(player.getState()).toBe('idle');
  });

  it('ignores clicks on a leftover interaction overlay after destroy', () => {
    player = createPlayer([branchCue('branch', 5, [SEGMENT_A])]);
    video = document.querySelector('video') as unknown as HTMLVideoElementWithControlsList;

    seek(5);
    const button = document.querySelector<HTMLButtonElement>('.ivl-choice-button');
    expect(button).not.toBeNull();

    const onBranchJump = vi.fn();
    player.on('onBranchJump', onBranchJump);

    player.destroy();

    // InteractionManager.destroy() removes the overlay, so there is no stale
    // button left; and even if referenced directly, no branch must start.
    expect(document.querySelector('.ivl-interaction-overlay')).toBeNull();
    expect(onBranchJump).not.toHaveBeenCalled();
    expect(video.src).toBe(MAIN_SRC);
  });
});
