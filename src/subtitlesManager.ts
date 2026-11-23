import { CuePoint } from './types';

/**
 * Represents an extended text track cue with additional properties.
 */
interface ExtendedTextTrackCue extends TextTrackCue {
  text: string;
}

/**
 * Manages subtitles for a video element.
 * Handles loading and processing of subtitle cues.
 */
export class SubtitlesManager {
  private subtitlesElement: HTMLTrackElement;
  private cuePoints: CuePoint[] = [];
  private destroyed = false;

  private readonly _handleLoad = (): void => {
    if (this.destroyed) return;
    const track = this.subtitlesElement.track;
    if (!track) {
      console.warn('Subtitle track not available');
      this.callback?.(this.cuePoints);
      return;
    }
    const trackCues = Array.from(track.cues || []);
    const cues = this.cuePoints.map((cueConfig) => ({
      ...cueConfig,
      time:
        trackCues.find((cue) => (cue as ExtendedTextTrackCue)?.text === cueConfig.subtitleText)
          ?.startTime || 0,
    }));
    this.callback?.(cues);
  };

  private readonly _handleError = (error: Event): void => {
    if (this.destroyed) return;
    console.error('Failed to load subtitles:', error);
    this.callback?.(this.cuePoints);
  };

  private callback?: (cues?: CuePoint[]) => void;

  /**
   * Creates an instance of SubtitlesManager.
   * @param subtitlesElement - The HTML track element for subtitles.
   * @param cuePoints - Optional array of cue points to initialize with.
   */
  constructor(subtitlesElement: HTMLTrackElement, cuePoints: CuePoint[] = []) {
    this.subtitlesElement = subtitlesElement;
    this.cuePoints = cuePoints;
  }

  /**
   * Registers a callback to be invoked when subtitles are loaded or an error occurs.
   * @param callback - A function to be called with the loaded cues or the initial cues if an error occurs.
   */
  public onLoad(callback: (cues?: CuePoint[]) => void): void {
    if (this.destroyed) return;
    this.callback = callback;
    this.subtitlesElement.addEventListener('load', this._handleLoad);
    this.subtitlesElement.addEventListener('error', this._handleError);
  }

  /**
   * Removes the registered listeners and drops the callback so no subtitle
   * event can reach the player after it has been destroyed.
   */
  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.subtitlesElement.removeEventListener('load', this._handleLoad);
    this.subtitlesElement.removeEventListener('error', this._handleError);
    this.callback = undefined;
  }
}
