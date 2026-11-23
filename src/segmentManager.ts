import { HTMLVideoElementWithControlsList } from './types';

/**
 * Callbacks used by the player to keep its state machine and analytics in sync
 * with the lifecycle of a temporary branch segment.
 */
export type SegmentManagerCallbacks = {
  /** Called after a branch segment ends naturally and the main video has been restored. */
  onSegmentEnd?: () => void;
  /** Called after a branch segment fails to load/play and the main video has been restored. */
  onSegmentError?: (error?: unknown) => void;
  /** Called once the main video has been restored and playback was attempted. */
  onMainRestored?: () => void;
};

type PendingHandler = () => void;
type ResumeReason = 'ended' | 'error';

/**
 * Manages the logic for switching to and from video segments.
 *
 * While a branch segment is playing, the main video source and playback
 * position are kept in a snapshot. When the segment ends (or fails), the
 * snapshot is restored and playback of the main video continues.
 */
export class SegmentManager {
  private videoElement: HTMLVideoElementWithControlsList;
  private callbacks: SegmentManagerCallbacks;

  private _mainVideoSrc: string | null = null;
  private _mainVideoCurrentTime = 0;

  private _inSegment = false;
  private _restoring = false;
  private _destroyed = false;

  /**
   * Token incremented whenever a restore starts or is superseded. Pending
   * restore callbacks capture the token at registration and become inert once
   * it no longer matches, so a stale restore can never overwrite a newer one.
   */
  private _restoreToken = 0;

  private _pendingSegmentMetadataHandler: PendingHandler | null = null;
  private _pendingRestoreMetadataHandler: PendingHandler | null = null;

  private readonly _handleEnded = (): void => {
    if (this._destroyed || !this._inSegment) return;
    this.resumeMain('ended');
  };

  private readonly _handleError = (): void => {
    if (this._destroyed) return;
    if (this._inSegment) {
      this.resumeMain('error');
      return;
    }
    // The main video failed to reload during a restore. Complete the restore
    // anyway so the player never gets stuck in the restoring state.
    if (this._restoring) {
      this.finishRestore(this._restoreToken, 'error');
    }
  };

  constructor(
    videoElement: HTMLVideoElementWithControlsList,
    callbacks: SegmentManagerCallbacks = {},
  ) {
    this.videoElement = videoElement;
    this.callbacks = callbacks;
    this.bindEvents();
  }

  private bindEvents(): void {
    this.videoElement.addEventListener('ended', this._handleEnded);
    this.videoElement.addEventListener('error', this._handleError);
  }

  /** Whether a branch segment is currently loading or playing. */
  public isSegmentActive(): boolean {
    return this._inSegment;
  }

  /** Whether the main video is currently being restored after a branch. */
  public isRestoring(): boolean {
    return this._restoring;
  }

  /**
   * Handles the transition to a new video segment.
   * Saves the current main video state and plays the new segment.
   *
   * Triggering a new segment while another one is still active or while a
   * previous restore is pending keeps the original main-video snapshot, so a
   * stale branch can never overwrite the latest one.
   *
   * @param newSegmentUrl The URL of the new video segment to play.
   */
  public playSegment(newSegmentUrl: string): void {
    if (this._destroyed) return;

    // Only snapshot when we are not already inside a branch/restore cycle;
    // otherwise the snapshot would capture the branch video instead of main.
    if (!this._inSegment && !this._restoring) {
      this._mainVideoSrc = this.videoElement.src;
      this._mainVideoCurrentTime = this.videoElement.currentTime;
    }

    this.removePendingHandlers();
    this._restoreToken += 1;
    this._inSegment = true;
    this._restoring = false;

    this.videoElement.src = newSegmentUrl;
    this.videoElement.load();

    const handler = () => {
      const isPending = this._pendingSegmentMetadataHandler === handler;
      if (isPending) {
        this._pendingSegmentMetadataHandler = null;
      }
      if (this._destroyed) return;

      // A superseded handler is normally removed when a newer branch/restore
      // starts. If its event was already queued (or a test harness replays the
      // listener) it must never start branch playback; the only effect it may
      // have is completing a pending main-video restore.
      if (!isPending) {
        if (this._restoring) {
          this.finishRestore(this._restoreToken);
        }
        return;
      }

      // Metadata arriving while the main video is being restored belongs to
      // that restore, not to a branch segment.
      if (this._restoring) {
        this.finishRestore(this._restoreToken);
        return;
      }

      if (!this._inSegment) return;

      this.safePlay((error) => {
        if (this._destroyed || !this._inSegment) return;
        this.resumeMain('error', error);
      });
    };

    this._pendingSegmentMetadataHandler = handler;
    this.videoElement.addEventListener('loadedmetadata', handler, { once: true });
  }

  /**
   * Restores the main video from the snapshot and resumes playback once its
   * metadata is available.
   */
  private resumeMain(reason: ResumeReason, error?: unknown): void {
    if (this._destroyed || !this._inSegment) return;

    this._inSegment = false;
    this._restoring = true;
    this.removePendingHandlers();

    const resumeSrc = this._mainVideoSrc;
    if (!resumeSrc) {
      this.finishRestore(this._restoreToken, reason, error);
      return;
    }

    this._restoreToken += 1;
    const token = this._restoreToken;

    this.videoElement.src = resumeSrc;
    this.videoElement.load();

    const handler = () => {
      if (this._destroyed || token !== this._restoreToken) return;
      this.finishRestore(token, reason, error);
    };

    this._pendingRestoreMetadataHandler = handler;
    this.videoElement.addEventListener('loadedmetadata', handler, { once: true });
  }

  /**
   * Completes a pending restore: seeks the main video back to the recorded
   * position, attempts playback and notifies the player. Idempotent, so a
   * duplicated metadata event cannot resume twice.
   */
  private finishRestore(token: number, reason: ResumeReason = 'ended', error?: unknown): void {
    if (this._destroyed || !this._restoring || token !== this._restoreToken) return;

    this._restoring = false;
    const resumeTime = this._mainVideoCurrentTime;
    this.clearSnapshot();
    this.removePendingHandlers();

    try {
      this.videoElement.currentTime = resumeTime;
    } catch (seekError) {
      // Some engines reject seeking before metadata is available; playback still
      // resumes from the start rather than leaving the player stuck.
      console.warn('Could not restore main video position:', seekError);
    }

    this.safePlay((playError) => {
      if (this._destroyed) return;
      console.error('Error resuming main video:', playError);
    });

    if (!this._destroyed) {
      if (reason === 'error') {
        this.callbacks.onSegmentError?.(error);
      } else {
        this.callbacks.onSegmentEnd?.();
      }
      this.callbacks.onMainRestored?.();
    }
  }

  /**
   * Plays the video and routes synchronous errors and rejected promises to the
   * provided handler so callers can fall back to the main video.
   */
  private safePlay(onError: (error: unknown) => void): void {
    try {
      const playback = this.videoElement.play() as Promise<void> | undefined;
      if (playback && typeof playback.catch === 'function') {
        playback.catch(onError);
      }
    } catch (error) {
      onError(error);
    }
  }

  private removePendingHandlers(): void {
    if (this._pendingSegmentMetadataHandler) {
      this.videoElement.removeEventListener('loadedmetadata', this._pendingSegmentMetadataHandler);
      this._pendingSegmentMetadataHandler = null;
    }
    if (this._pendingRestoreMetadataHandler) {
      this.videoElement.removeEventListener('loadedmetadata', this._pendingRestoreMetadataHandler);
      this._pendingRestoreMetadataHandler = null;
    }
  }

  private clearSnapshot(): void {
    this._mainVideoSrc = null;
    this._mainVideoCurrentTime = 0;
  }

  /**
   * Destroys the SegmentManager instance.
   * Removes all registered listeners and clears any pending snapshot so no
   * further branch switching or restoration can happen.
   */
  public destroy(): void {
    if (this._destroyed) return;

    this._destroyed = true;
    this._restoreToken += 1;
    this.removePendingHandlers();

    this.videoElement.removeEventListener('ended', this._handleEnded);
    this.videoElement.removeEventListener('error', this._handleError);

    this._inSegment = false;
    this._restoring = false;
    this.clearSnapshot();
    this.callbacks = {};
  }
}
