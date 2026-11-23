import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SegmentManager } from '../src/segmentManager';
import { HTMLVideoElementWithControlsList } from '../src/types';

describe('SegmentManager', () => {
  let videoElement: HTMLVideoElementWithControlsList;
  let segmentManager: SegmentManager;

  beforeEach(() => {
    videoElement = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      src: 'main.mp4',
      currentTime: 10,
      load: vi.fn(),
      play: vi.fn(() => Promise.resolve()),
      pause: vi.fn(),
      controlsList: {
        add: vi.fn(),
        remove: vi.fn(),
        contains: vi.fn(),
        toggle: vi.fn(),
        length: 0,
        entries: vi.fn(),
        forEach: vi.fn(),
        item: vi.fn(),
        keys: vi.fn(),
        values: vi.fn(),
        [Symbol.iterator]: vi.fn(),
      },
    } as unknown as HTMLVideoElementWithControlsList;

    segmentManager = new SegmentManager(videoElement);
  });

  it('should bind the ended event on construction', () => {
    expect(videoElement.addEventListener).toHaveBeenCalledWith('ended', expect.any(Function));
  });

  describe('playSegment', () => {
    it('should save main video state, change src, and play the segment', () => {
      const segmentUrl = 'segment1.mp4';
      segmentManager.playSegment(segmentUrl);

      // Type assertion to access private properties for testing
      const sm = segmentManager as any;
      expect(sm._mainVideoSrc).toBe('main.mp4');
      expect(sm._mainVideoCurrentTime).toBe(10);

      expect(videoElement.src).toBe(segmentUrl);
      expect(videoElement.load).toHaveBeenCalled();
      expect(videoElement.addEventListener).toHaveBeenCalledWith(
        'loadedmetadata',
        expect.any(Function),
        { once: true },
      );

      // Simulate 'loadedmetadata' event
      const loadedMetadataCallback = (videoElement.addEventListener as vi.Mock).mock.calls.find(
        (call) => call[0] === 'loadedmetadata',
      )[1];
      loadedMetadataCallback();

      expect(videoElement.play).toHaveBeenCalled();
    });
  });

  describe('ended event handling', () => {
    it('should resume main video when a segment ends', () => {
      // Start playing a segment
      const segmentUrl = 'segment1.mp4';
      segmentManager.playSegment(segmentUrl);

      // Simulate 'loadedmetadata' for segment video to trigger the first play
      const segmentLoadedMetadataCallback = (
        videoElement.addEventListener as vi.Mock
      ).mock.calls.find((call) => call[0] === 'loadedmetadata')[1];
      segmentLoadedMetadataCallback();

      // Simulate 'ended' event for the segment
      const endedCallback = (videoElement.addEventListener as vi.Mock).mock.calls.find(
        (call) => call[0] === 'ended',
      )[1];
      endedCallback();

      expect(videoElement.src).toBe('main.mp4');
      expect(videoElement.load).toHaveBeenCalledTimes(2); // Once for segment, once for main

      // Simulate 'loadedmetadata' for resuming main video
      const allLoadedMetadataCalls = (videoElement.addEventListener as vi.Mock).mock.calls.filter(
        (call) => call[0] === 'loadedmetadata',
      );
      const mainVideoLoadedMetadataCallback =
        allLoadedMetadataCalls[allLoadedMetadataCalls.length - 1][1];
      mainVideoLoadedMetadataCallback();

      expect(videoElement.currentTime).toBe(10);
      expect(videoElement.play).toHaveBeenCalledTimes(2); // Once for segment, once for main
    });

    it('should do nothing on ended event if not in a segment', () => {
      const originalSrc = videoElement.src;
      const originalTime = videoElement.currentTime;
      const endedCallback = (videoElement.addEventListener as vi.Mock).mock.calls.find(
        (call) => call[0] === 'ended',
      )[1];
      endedCallback();

      expect(videoElement.src).toBe(originalSrc);
      expect(videoElement.currentTime).toBe(originalTime);
      expect(videoElement.load).not.toHaveBeenCalled();
    });
  });

  it('should have a destroy method that does not throw', () => {
    expect(() => segmentManager.destroy()).not.toThrow();
  });
});

describe('SegmentManager branch lifecycle', () => {
  let videoElement: HTMLVideoElementWithControlsList;
  let segmentManager: SegmentManager;
  let callbacks: {
    onSegmentEnd: ReturnType<typeof vi.fn>;
    onSegmentError: ReturnType<typeof vi.fn>;
    onMainRestored: ReturnType<typeof vi.fn>;
  };

  const MAIN_SRC = 'https://example.com/main.mp4';
  const SEGMENT_ONE = 'https://example.com/segment-1.mp4';
  const SEGMENT_TWO = 'https://example.com/segment-2.mp4';

  /** Returns the most recently registered listener for an event. */
  const latestListener = (event: string): ((...args: unknown[]) => void) => {
    const calls = (videoElement.addEventListener as vi.Mock).mock.calls.filter(
      (call) => call[0] === event,
    );
    expect(calls.length).toBeGreaterThan(0);
    return calls[calls.length - 1][1];
  };

  beforeEach(() => {
    callbacks = {
      onSegmentEnd: vi.fn(),
      onSegmentError: vi.fn(),
      onMainRestored: vi.fn(),
    };

    videoElement = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      src: MAIN_SRC,
      currentTime: 42,
      load: vi.fn(),
      play: vi.fn(() => Promise.resolve()),
      pause: vi.fn(),
    } as unknown as HTMLVideoElementWithControlsList;

    segmentManager = new SegmentManager(videoElement, callbacks);
  });

  it('marks a branch as active and restoring as false while it plays', () => {
    segmentManager.playSegment(SEGMENT_ONE);

    expect(segmentManager.isSegmentActive()).toBe(true);
    expect(segmentManager.isRestoring()).toBe(false);
    expect(videoElement.src).toBe(SEGMENT_ONE);

    const sm = segmentManager as any;
    expect(sm._mainVideoSrc).toBe(MAIN_SRC);
    expect(sm._mainVideoCurrentTime).toBe(42);
  });

  it('restores the main source and time when the branch ends, then notifies', () => {
    segmentManager.playSegment(SEGMENT_ONE);
    latestListener('loadedmetadata')();

    // Simulate the branch finishing.
    (videoElement.addEventListener as vi.Mock).mock.calls.find((call) => call[0] === 'ended')[1]();

    expect(videoElement.src).toBe(MAIN_SRC);
    expect(segmentManager.isSegmentActive()).toBe(false);
    expect(segmentManager.isRestoring()).toBe(true);
    expect(callbacks.onSegmentEnd).not.toHaveBeenCalled();

    latestListener('loadedmetadata')();

    expect(videoElement.currentTime).toBe(42);
    expect(segmentManager.isRestoring()).toBe(false);
    expect(videoElement.play).toHaveBeenCalledTimes(2); // segment + main
    expect(callbacks.onSegmentEnd).toHaveBeenCalledTimes(1);
    expect(callbacks.onMainRestored).toHaveBeenCalledTimes(1);
    expect(callbacks.onSegmentError).not.toHaveBeenCalled();

    // The snapshot is cleared once the main video has been restored.
    const sm = segmentManager as any;
    expect(sm._mainVideoSrc).toBeNull();
    expect(sm._mainVideoCurrentTime).toBe(0);
  });

  it('falls back to the main video when the branch fails to load', () => {
    segmentManager.playSegment(SEGMENT_ONE);

    (videoElement.addEventListener as vi.Mock).mock.calls.find((call) => call[0] === 'error')[1]();

    expect(videoElement.src).toBe(MAIN_SRC);
    expect(segmentManager.isSegmentActive()).toBe(false);

    latestListener('loadedmetadata')();

    expect(callbacks.onSegmentError).toHaveBeenCalledTimes(1);
    expect(callbacks.onSegmentEnd).not.toHaveBeenCalled();
    expect(videoElement.currentTime).toBe(42);
    expect(videoElement.play).toHaveBeenCalledTimes(1); // only the restored main video
  });

  it('falls back to the main video when play() is rejected', async () => {
    (videoElement.play as vi.Mock).mockRejectedValueOnce(new Error('NotAllowedError'));

    segmentManager.playSegment(SEGMENT_ONE);
    latestListener('loadedmetadata')();

    // Let the rejected play() promise settle.
    await Promise.resolve();
    await Promise.resolve();

    expect(videoElement.src).toBe(MAIN_SRC);
    expect(segmentManager.isSegmentActive()).toBe(false);

    latestListener('loadedmetadata')();

    expect(callbacks.onSegmentError).toHaveBeenCalledTimes(1);
    expect(videoElement.currentTime).toBe(42);
  });

  it('keeps the original main snapshot when a second branch interrupts the first', () => {
    segmentManager.playSegment(SEGMENT_ONE);
    const firstSegmentHandler = latestListener('loadedmetadata');

    videoElement.src = SEGMENT_ONE;
    videoElement.currentTime = 3;

    segmentManager.playSegment(SEGMENT_TWO);

    const sm = segmentManager as any;
    // The second branch must not snapshot the first branch's source/time.
    expect(sm._mainVideoSrc).toBe(MAIN_SRC);
    expect(sm._mainVideoCurrentTime).toBe(42);
    expect(videoElement.src).toBe(SEGMENT_TWO);

    // The superseded branch's pending metadata handler is removed.
    expect(videoElement.removeEventListener).toHaveBeenCalledWith(
      'loadedmetadata',
      firstSegmentHandler,
    );

    // A stale callback must not trigger a restore or a play.
    firstSegmentHandler();
    expect(videoElement.play).not.toHaveBeenCalled();
    expect(videoElement.src).toBe(SEGMENT_TWO);

    // Ending the second branch restores the original main snapshot.
    (videoElement.addEventListener as vi.Mock).mock.calls.find((call) => call[0] === 'ended')[1]();
    latestListener('loadedmetadata')();

    expect(videoElement.src).toBe(MAIN_SRC);
    expect(videoElement.currentTime).toBe(42);
    expect(callbacks.onSegmentEnd).toHaveBeenCalledTimes(1);
  });

  it('does not let a pending restore from an earlier branch override a newer one', () => {
    segmentManager.playSegment(SEGMENT_ONE);
    latestListener('loadedmetadata')();

    const endedHandler = (videoElement.addEventListener as vi.Mock).mock.calls.find(
      (call) => call[0] === 'ended',
    )[1];

    // Branch one ends: the main restore is pending (loadedmetadata not fired yet).
    endedHandler();
    const staleRestoreHandler = latestListener('loadedmetadata');
    expect(segmentManager.isRestoring()).toBe(true);

    // A new branch starts while the previous restore is still pending.
    segmentManager.playSegment(SEGMENT_TWO);

    const sm = segmentManager as any;
    expect(sm._mainVideoSrc).toBe(MAIN_SRC);
    expect(sm._mainVideoCurrentTime).toBe(42);
    expect(segmentManager.isSegmentActive()).toBe(true);
    expect(segmentManager.isRestoring()).toBe(false);
    expect(videoElement.removeEventListener).toHaveBeenCalledWith(
      'loadedmetadata',
      staleRestoreHandler,
    );

    // Stale restore callback must be inert.
    staleRestoreHandler();
    expect(videoElement.currentTime).toBe(42);
    expect(videoElement.src).toBe(SEGMENT_TWO);

    (videoElement.addEventListener as vi.Mock).mock.calls.find((call) => call[0] === 'ended')[1]();
    latestListener('loadedmetadata')();

    expect(videoElement.src).toBe(MAIN_SRC);
    expect(videoElement.currentTime).toBe(42);
    expect(callbacks.onSegmentEnd).toHaveBeenCalledTimes(1);
  });

  it('removes listeners and drops the snapshot on destroy', () => {
    segmentManager.playSegment(SEGMENT_ONE);
    const pendingSegmentHandler = latestListener('loadedmetadata');

    segmentManager.destroy();

    expect(segmentManager.isSegmentActive()).toBe(false);
    expect(segmentManager.isRestoring()).toBe(false);

    const sm = segmentManager as any;
    expect(sm._mainVideoSrc).toBeNull();
    expect(sm._mainVideoCurrentTime).toBe(0);

    expect(videoElement.removeEventListener).toHaveBeenCalledWith('ended', expect.any(Function));
    expect(videoElement.removeEventListener).toHaveBeenCalledWith('error', expect.any(Function));
    expect(videoElement.removeEventListener).toHaveBeenCalledWith(
      'loadedmetadata',
      pendingSegmentHandler,
    );

    videoElement.load = vi.fn();
    (videoElement.play as vi.Mock).mockClear();

    // Events delivered after destroy must not start a restore or a play.
    pendingSegmentHandler();
    endedHandlerOf(videoElement)();

    expect(videoElement.load).not.toHaveBeenCalled();
    expect(videoElement.play).not.toHaveBeenCalled();
    expect(callbacks.onSegmentEnd).not.toHaveBeenCalled();
    expect(callbacks.onMainRestored).not.toHaveBeenCalled();
  });

  it('is a no-op when playSegment is called after destroy', () => {
    segmentManager.destroy();
    videoElement.load = vi.fn();

    segmentManager.playSegment(SEGMENT_ONE);

    expect(videoElement.src).toBe(MAIN_SRC);
    expect(videoElement.load).not.toHaveBeenCalled();
  });
});

/** Returns the first `ended` listener registered on the video element. */
function endedHandlerOf(videoElement: HTMLVideoElementWithControlsList): () => void {
  return (videoElement.addEventListener as vi.Mock).mock.calls.find(
    (call) => call[0] === 'ended',
  )[1];
}
