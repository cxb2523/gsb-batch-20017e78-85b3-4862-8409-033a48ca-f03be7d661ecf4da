import { StateMachine } from './stateMachine';
import { CueHandler } from './cueHandler';
import { InteractionManager } from './interactionManager';
import { Analytics } from './analytics';
import { SegmentManager } from './segmentManager';
import { I18n } from './i18n';

import type {
  PlayerConfig,
  CuePoint,
  AnalyticsEvent,
  PlayerState,
  HTMLVideoElementWithControlsList,
  Translations,
  AnalyticsPayload,
  DecisionAdapter,
} from './types';
import { InMemoryDecisionAdapter } from './InMemoryDecisionAdapter';
import { LocalStorageDecisionAdapter } from './localStorageDecisionAdapter';
import { FALLBACK_CSS } from './style';
import { SubtitlesManager } from './subtitlesManager';

/**
 * The main class for the Interactive Video Labs Player.
 * This class orchestrates the video playback, cue handling, interaction management,
 * and analytics tracking.
 */
export class IVLabsPlayer {
  private videoElement: HTMLVideoElementWithControlsList;
  private config: PlayerConfig;
  private stateMachine: StateMachine;
  private cueHandler: CueHandler;
  private interactionManager: InteractionManager;
  private analytics: Analytics;
  private segmentManager: SegmentManager;
  private i18n: I18n;
  private decisionAdapter: DecisionAdapter;
  private subtitlesManager?: SubtitlesManager;

  private videoContainer: HTMLElement;
  private subtitlesElement?: HTMLTrackElement;

  private _destroyed = false;
  private _eventsBound = false;

  private readonly _handlePlay = (): void => {
    if (this._destroyed) return;
    this.analytics.track('VIDEO_STARTED', {
      event: 'VIDEO_STARTED',
      timestamp: Date.now(),
    });

    // Reflect that playback resumed, but never downgrade a branch in progress.
    const state = this.stateMachine.getState();
    if (state === 'idle' || state === 'ended' || state === 'error') {
      this.stateMachine.transitionTo('playing');
    }
  };

  private readonly _handlePause = (): void => {
    if (this._destroyed) return;
    this.analytics.track('VIDEO_PAUSED', {
      event: 'VIDEO_PAUSED',
      timestamp: Date.now(),
    });
  };

  private readonly _handleEnded = (): void => {
    if (this._destroyed) return;
    this.analytics.track('VIDEO_ENDED', {
      event: 'VIDEO_ENDED',
      timestamp: Date.now(),
    });

    // The SegmentManager may have already started restoring the main video;
    // in that case the segment lifecycle owns the state transition.
    if (this.segmentManager.isSegmentActive() || this.segmentManager.isRestoring()) return;

    this.stateMachine.transitionTo('ended');
  };

  private readonly _handleCue = (cue: CuePoint): void => {
    if (this._destroyed) return;
    // Cues belong to the main video only. Ignore any timeupdate from a branch
    // segment or from the main video while it is being restored.
    if (this.segmentManager.isSegmentActive() || this.segmentManager.isRestoring()) return;

    this.analytics.track('onCueEnter', {
      event: 'onCueEnter',
      cueId: cue.id,
      timestamp: Date.now(),
    });

    if (cue.payload?.interaction) {
      this.videoElement.pause();
      this.stateMachine.transitionTo('waitingForInteraction');
      this.interactionManager.handleInteractionCue(cue);
      this.analytics.track('onPromptShown', {
        event: 'onPromptShown',
        cueId: cue.id,
        timestamp: Date.now(),
      });
    } else {
      this.stateMachine.transitionTo('playing');
    }
  };

  private readonly _handleResponse = (response: unknown, cue: CuePoint): void => {
    if (this._destroyed) return;

    this.analytics.track('onInteractionSelected', {
      event: 'onInteractionSelected',
      cueId: cue.id,
      data: { response },
      timestamp: Date.now(),
    });

    const nextSegment = (response as { nextSegment?: unknown } | null | undefined)?.nextSegment;

    if (typeof nextSegment === 'string' && nextSegment) {
      this.analytics.track('onBranchJump', {
        event: 'onBranchJump',
        cueId: cue.id,
        data: { nextSegment },
        timestamp: Date.now(),
      });
      // Main-video cues must not fire while the branch segment is playing.
      this.cueHandler.stop();
      this.stateMachine.transitionTo('playingSegment');
      this.segmentManager.playSegment(nextSegment);
    } else {
      this.stateMachine.transitionTo('playing');
      this.safePlay((error) => {
        console.error('Video playback failed:', error);
      });
    }

    this.analytics.track('INTERACTION_COMPLETED', {
      event: 'INTERACTION_COMPLETED',
      cueId: cue.id,
      data: { response },
      timestamp: Date.now(),
    });
  };

  constructor(target: string, config: PlayerConfig) {
    const targetElement = document.getElementById(target);
    if (!targetElement) throw new Error(`Target container with ID "${target}" not found.`);

    this.config = config;
    this.videoContainer = document.createElement('div');
    this.videoContainer.className = 'ivl-player-container';

    this.videoElement = document.createElement('video') as HTMLVideoElementWithControlsList;
    this.videoElement.controls = true;
    this.videoElement.controlsList = 'nodownload';

    if (config.subtitlesUrl) {
      this.subtitlesElement = document.createElement('track');
      this.subtitlesElement.src = config.subtitlesUrl;
      this.subtitlesElement.kind = 'subtitles';
      this.subtitlesElement.default = true;
      this.subtitlesManager = new SubtitlesManager(this.subtitlesElement, config.cues);
      this.videoElement.appendChild(this.subtitlesElement);
      this.subtitlesManager.onLoad((cues) => {
        // Ignore subtitle events that arrive after destroy().
        if (this._destroyed) return;
        this.start(cues);
      });
    }

    this.videoContainer.appendChild(this.videoElement);
    targetElement.innerHTML = '';
    targetElement.appendChild(this.videoContainer);

    this._injectFallbackCss();

    this.i18n = new I18n();
    if (config.translations) {
      for (const [locale, translations] of Object.entries(config.translations)) {
        this.i18n.load(locale, translations);
      }
    }
    if (config.locale) {
      this.i18n.setLocale(config.locale);
    }

    if (config.decisionAdapter) {
      this.decisionAdapter = config.decisionAdapter;
    } else if (config.decisionAdapterType === 'localStorage') {
      this.decisionAdapter = new LocalStorageDecisionAdapter();
    } else {
      this.decisionAdapter = new InMemoryDecisionAdapter();
    }
    this.analytics = new Analytics();
    this.stateMachine = new StateMachine(config.initialState || 'idle');
    this.configureStateMachine();
    this.interactionManager = new InteractionManager(
      this.videoContainer,
      this.i18n,
      this.decisionAdapter,
    );
    this.cueHandler = new CueHandler(this.videoElement);
    // The segment manager is created before the player binds its own video
    // events so that it observes (and can act on) the `ended` event first.
    this.segmentManager = new SegmentManager(this.videoElement, {
      onSegmentEnd: () => this.handleSegmentRestored(),
      onSegmentError: (error) => this.handleSegmentError(error),
    });
    if (!config.subtitlesUrl) {
      this.start(config.cues);
    }
  }

  /**
   * Registers the transitions the player drives. Transitions that are not
   * listed here are rejected by the state machine.
   */
  private configureStateMachine(): void {
    const transitions: Array<[PlayerState, PlayerState]> = [
      ['idle', 'playing'],
      ['idle', 'waitingForInteraction'],
      ['idle', 'playingSegment'],
      ['idle', 'error'],
      ['playing', 'waitingForInteraction'],
      ['playing', 'playingSegment'],
      ['playing', 'ended'],
      ['playing', 'error'],
      ['waitingForInteraction', 'playing'],
      ['waitingForInteraction', 'playingSegment'],
      ['waitingForInteraction', 'ended'],
      ['waitingForInteraction', 'error'],
      ['playingSegment', 'playing'],
      ['playingSegment', 'error'],
      ['ended', 'playing'],
      ['ended', 'playingSegment'],
      ['error', 'playing'],
      ['error', 'playingSegment'],
    ];

    for (const [from, to] of transitions) {
      this.stateMachine.addTransition({ from, to });
    }
  }

  private start(cues?: CuePoint[]) {
    if (this._destroyed) return;

    this.cueHandler.registerCues(cues || []);
    if (!this.config.videoUrl) throw new Error('videoUrl must be provided in the PlayerConfig.');
    this.videoElement.src = this.config.videoUrl;
    this.bindEvents();
    this.cueHandler.start();
  }

  /**
   * Binds event listeners for cue handling, interaction response, and analytics.
   */
  private bindEvents(): void {
    if (this._destroyed || this._eventsBound) return;
    this._eventsBound = true;

    this.cueHandler.onCue(this._handleCue);
    this.interactionManager.onResponse(this._handleResponse);

    this.videoElement.addEventListener('play', this._handlePlay);
    this.videoElement.addEventListener('pause', this._handlePause);
    this.videoElement.addEventListener('ended', this._handleEnded);
  }

  private unbindEvents(): void {
    this._eventsBound = false;
    this.videoElement.removeEventListener('play', this._handlePlay);
    this.videoElement.removeEventListener('pause', this._handlePause);
    this.videoElement.removeEventListener('ended', this._handleEnded);
  }

  /**
   * Called once a branch segment ended naturally and the main video has been
   * restored to its previous position.
   */
  private handleSegmentRestored(): void {
    if (this._destroyed) return;
    this.cueHandler.start();
    this.stateMachine.transitionTo('playing');
  }

  /**
   * Called when a branch segment failed to load or its playback was rejected.
   * The main video has already been restored, so the player can continue.
   */
  private handleSegmentError(error?: unknown): void {
    if (this._destroyed) return;
    this.analytics.track('ERROR', {
      event: 'ERROR',
      data: { message: 'Segment playback failed; resuming main video.', error: String(error) },
      timestamp: Date.now(),
    });
    this.cueHandler.start();
    this.stateMachine.transitionTo('playing');
  }

  /**
   * Starts playback while tolerating environments where `play()` returns
   * `undefined` or throws synchronously.
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

  /** Loads cue points into the player. */
  public loadCues(cues: CuePoint[]): void {
    this.cueHandler.loadCues(cues);
  }

  /** Loads interaction segments into the player. */
  public loadInteractions(interactions: CuePoint[]): void {
    this.interactionManager.loadInteractions(interactions);
  }

  /** Returns the current player state. */
  public getState(): PlayerState {
    return this.stateMachine.getState();
  }

  /** Plays the video. */
  public play(): void {
    this.safePlay((error) => {
      console.error('Video playback failed:', error);
    });
  }

  /** Pauses the video. */
  public pause(): void {
    this.videoElement.pause();
  }

  /**
   * Registers a custom analytics hook for a specific event.
   * @param event - The event to listen for.
   * @param callback - The function to be called when the event is tracked.
   */
  public on(
    event: AnalyticsEvent,
    callback: (payload: AnalyticsPayload | undefined) => void,
  ): void {
    this.analytics.on(event, (event, payload) => callback(payload));
  }

  /**
   * Sets the current language for localization.
   * @param locale - The new locale.
   */
  public setLocale(locale: string): void {
    this.i18n.setLocale(locale);
  }

  /**
   * Loads a set of translations for a specific locale.
   * @param locale - The locale for the translations.
   * @param translations - The translation data.
   */
  public loadTranslations(locale: string, translations: Translations): void {
    this.i18n.load(locale, translations);
  }

  /**
   * Retrieves the user's decision history.
   * @returns A promise that resolves to an array of Decision objects.
   */
  public getDecisionHistory() {
    return this.decisionAdapter.getDecisionHistory();
  }

  /**
   * Clears the user's decision history.
   * @returns A promise that resolves when the history is cleared.
   */
  public clearDecisionHistory() {
    return this.decisionAdapter.clearDecisionHistory();
  }

  /**
   * Injects fallback CSS into the document head.
   * This ensures basic styling is present even if external stylesheets are not loaded.
   */
  private _injectFallbackCss(): void {
    const style = document.createElement('style');
    style.textContent = FALLBACK_CSS;
    document.head.appendChild(style);
  }

  /** Cleans up the player, removes listeners and resets state. */
  public destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;

    console.log('IVLabsPlayer destroy() called.');

    this.unbindEvents();
    this.cueHandler.destroy();
    this.segmentManager.destroy();
    this.interactionManager.destroy();
    this.subtitlesManager?.destroy();

    this.analytics.track('onSessionEnd', {
      event: 'onSessionEnd',
      timestamp: Date.now(),
    });
  }
}
