// Framework-independent playback session controller.
//
// It owns the player's timeline and ties narration, uploaded voiceover, background
// music and subtitle highlighting to a single scene session. Every narration start
//bumps an epoch; callbacks (word boundaries, end-of-speech) from a previous scene or
// a previous pause are ignored, so rapid scene switches cannot rewrite the current
// scene's subtitles.
//
// The controller talks to a small engine interface, which lets tests run it with a
// fake engine and with no real speech synthesis.

import type { Scene } from '../types/explainroo';

export interface NarrationEngine {
  speakNarration(
    text: string,
    onWordSpoken?: (word: string, charIndex: number, wordIndex: number) => void,
    onEnd?: () => void,
    rate?: number,
    pitch?: number,
    options?: { startWordIndex?: number }
  ): number;
  playCustomAudio(url: string, onEnd?: () => void, options?: { startTime?: number }): number;
  stopNarration(): void;
  seekCustomAudio(time: number): void;
  startMusic(track: string): void;
  stopMusic(): void;
  setAutoDuck(enabled: boolean): void;
  setMusicVolume(volume: number): void;
}

export interface PlaybackSnapshot {
  isPlaying: boolean;
  isScrubbing: boolean;
  currentTime: number;
  duration: number;
  sceneId: string;
  sceneIndex: number;
  totalScenes: number;
  /** Word index reported by the active narration, -1 when there is none. */
  liveWordIndex: number;
  /** Word index the subtitle UI should highlight (live word, else time-based). */
  activeWordIndex: number;
  narrationActive: boolean;
  voiceMuted: boolean;
  musicEnabled: boolean;
}

export interface PlaybackCallbacks {
  onSceneEnd?: () => void;
  onPlaybackEnd?: () => void;
}

export const DEFAULT_SCENE_DURATION = 7;

export function splitNarrationWords(text: string | undefined | null): string[] {
  return (text || '').trim().split(/\s+/).filter(Boolean);
}

export class PlaybackController {
  private engine: NarrationEngine;
  private callbacks: PlaybackCallbacks = {};

  private scene: Scene | null = null;
  private sceneIndex = 0;
  private totalScenes = 1;
  private duration = DEFAULT_SCENE_DURATION;
  /** Identifies the narration source currently bound to the scene. */
  private narrationSignature = '';

  private isPlaying = false;
  private isScrubbing = false;
  private currentTime = 0;
  private playbackSpeed = 1;

  private voiceMuted = false;
  private musicEnabled = true;
  private musicTrack = 'lofi';
  private autoDuck = true;
  private voiceRate = 1;
  private voicePitch = 1;

  private liveWordIndex = -1;
  private narrationActive = false;
  private narrationEpoch = 0;
  /** Set while waiting for the parent to hand us the next scene. */
  private awaitingScene = false;

  private listeners = new Set<(snapshot: PlaybackSnapshot) => void>();
  private lastSnapshot: PlaybackSnapshot | null = null;

  constructor(engine: NarrationEngine) {
    this.engine = engine;
  }

  // ---------------------------------------------------------------------------
  // Subscription
  // ---------------------------------------------------------------------------

  public subscribe(listener: (snapshot: PlaybackSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public getSnapshot(): PlaybackSnapshot {
    return {
      isPlaying: this.isPlaying,
      isScrubbing: this.isScrubbing,
      currentTime: this.currentTime,
      duration: this.duration,
      sceneId: this.scene ? this.scene.id : '',
      sceneIndex: this.sceneIndex,
      totalScenes: this.totalScenes,
      liveWordIndex: this.liveWordIndex,
      activeWordIndex: this.getActiveWordIndex(),
      narrationActive: this.narrationActive,
      voiceMuted: this.voiceMuted,
      musicEnabled: this.musicEnabled,
    };
  }

  private emit() {
    const snapshot = this.getSnapshot();
    this.lastSnapshot = snapshot;
    this.listeners.forEach((listener) => {
      try {
        listener(snapshot);
      } catch (err) {
        console.error('Error in playback listener:', err);
      }
    });
  }

  public getLastSnapshot(): PlaybackSnapshot | null {
    return this.lastSnapshot;
  }

  public getScene(): Scene | null {
    return this.scene;
  }

  /**
   * Observe engine-level word notifications. When narration is stopped from
   * outside this controller (e.g. the script editor's voice preview), drop the
   * stale subtitle override instead of freezing on the previous word.
   */
  public observeEngineWord(_sessionId: number, wordIndex: number) {
    if (wordIndex >= 0) return;
    // Nothing to clear: either this controller already reset its state, or no
    // narration was active in the first place.
    if (!this.narrationActive && this.liveWordIndex < 0) return;
    this.narrationActive = false;
    this.liveWordIndex = -1;
    this.emit();
  }

  public getWords(): string[] {
    return splitNarrationWords(this.scene ? this.scene.narration : '');
  }

  public isScrubbingActive(): boolean {
    return this.isScrubbing;
  }

  public getPlaybackSpeed(): number {
    return this.playbackSpeed;
  }

  // ---------------------------------------------------------------------------
  // Time <-> word mapping
  // ---------------------------------------------------------------------------

  public getWordIndexForTime(time: number, words: string[] = this.getWords()): number {
    if (words.length === 0) return -1;
    const safeDuration = Math.max(0.1, this.duration);
    if (time >= safeDuration) return words.length - 1;
    const ratio = Math.max(0, Number.isFinite(time) ? time : 0) / safeDuration;
    // The tiny epsilon keeps exact fractions (e.g. 1s of 6 over 6 words) from
    // losing a word to floating-point error.
    const index = Math.floor(ratio * words.length + 1e-9);
    return Math.min(words.length - 1, Math.max(0, index));
  }

  public getActiveWordIndex(): number {
    const words = this.getWords();
    if (words.length === 0) return -1;
    if (this.liveWordIndex >= 0 && this.liveWordIndex < words.length) {
      return this.liveWordIndex;
    }
    return this.getWordIndexForTime(this.currentTime, words);
  }

  // ---------------------------------------------------------------------------
  // Scene binding
  // ---------------------------------------------------------------------------

  /**
   * Bind the player to a scene. A different scene id is a new session: stop all
   * previous narration, reset time/highlight, and (if playing) start the new
   * scene's narration from zero. Same-id updates (editing elements/narration while
   * paused) only refresh the stored scene data.
   */
  public updateScene(scene: Scene, sceneIndex: number, totalScenes: number) {
    const sceneChanged = !this.scene || this.scene.id !== scene.id;
    const previousSignature = this.narrationSignature;
    const signature = `${scene.id}::${scene.narration || ''}::${scene.customAudioUrl || ''}`;

    this.scene = scene;
    this.sceneIndex = sceneIndex;
    this.totalScenes = Math.max(1, totalScenes);
    this.duration = Math.max(0.1, scene.durationSeconds || DEFAULT_SCENE_DURATION);
    this.narrationSignature = signature;

    if (sceneChanged) {
      this.awaitingScene = false;
      this.isScrubbing = false;
      this.currentTime = 0;
      this.stopNarrationInternal();
      if (this.isPlaying) {
        this.syncMusic();
        this.startNarrationAt(0);
      }
    } else {
      if (this.currentTime > this.duration) {
        this.currentTime = this.duration;
      }
      // Editing the narration / swapping the uploaded clip while playing should
      // start a single fresh session for the new source, never stack on top of it.
      if (signature !== previousSignature && this.isPlaying) {
        this.stopNarrationInternal();
        this.startNarrationAt(this.currentTime);
      }
    }

    this.emit();
  }

  public setCallbacks(callbacks: PlaybackCallbacks) {
    this.callbacks = callbacks;
  }

  // ---------------------------------------------------------------------------
  // Transport
  // ---------------------------------------------------------------------------

  public play() {
    if (this.isPlaying) return;
    if (this.awaitingScene) return;
    if (this.currentTime >= this.duration - 1e-6) {
      this.currentTime = 0;
    }
    this.isPlaying = true;
    this.isScrubbing = false;
    this.syncMusic();
    this.startNarrationAt(this.currentTime);
    this.emit();
  }

  public pause() {
    if (!this.isPlaying) {
      // Still make sure nothing is left speaking / ducked while paused.
      this.stopNarrationInternal();
      this.emit();
      return;
    }
    this.isPlaying = false;
    this.isScrubbing = false;
    this.awaitingScene = false;
    // Stop narration and its fallback timer; `stopNarration` also restores the
    // music level. Ambient music itself keeps playing softly, as before.
    this.stopNarrationInternal();
    this.emit();
  }

  public togglePlay() {
    if (this.isPlaying) {
      this.pause();
    } else {
      this.play();
    }
  }

  /** Stop narration, restore music, reset highlight and jump to the given time. */
  public seek(time: number) {
    const target = Math.min(this.duration, Math.max(0, Number.isFinite(time) ? time : 0));
    this.awaitingScene = false;
    this.currentTime = target;
    this.isScrubbing = false;
    this.stopNarrationInternal();
    if (this.isPlaying && target < this.duration) {
      this.startNarrationAt(target);
    }
    this.emit();
  }

  /** Replay the current scene from the beginning, keeping the play/pause state. */
  public restart() {
    this.awaitingScene = false;
    this.currentTime = 0;
    this.isScrubbing = false;
    this.stopNarrationInternal();
    if (this.isPlaying) {
      this.startNarrationAt(0);
    }
    this.emit();
  }

  /**
   * Begin dragging the scrubber. Narration is stopped immediately so the highlight
   * falls back to the scrub position, and a single fresh session is started when
   * the drag ends instead of one per input event.
   */
  public beginScrub() {
    if (this.isScrubbing) return;
    this.isScrubbing = true;
    this.stopNarrationInternal();
    this.emit();
  }

  public scrubTo(time: number) {
    const target = Math.min(this.duration, Math.max(0, Number.isFinite(time) ? time : 0));
    this.currentTime = target;
    this.liveWordIndex = -1;
    this.emit();
  }

  public endScrub() {
    if (!this.isScrubbing) return;
    this.isScrubbing = false;
    if (this.isPlaying && this.currentTime < this.duration) {
      this.startNarrationAt(this.currentTime);
    }
    this.emit();
  }

  /** Advance the timeline by a delta (seconds). Returns the new time. */
  public advance(deltaSeconds: number): number {
    if (!this.isPlaying || this.awaitingScene || this.isScrubbing) return this.currentTime;
    const delta = Math.max(0, Number.isFinite(deltaSeconds) ? deltaSeconds : 0);
    const next = this.currentTime + delta;

    if (next < this.duration) {
      this.currentTime = next;
      this.emit();
      return this.currentTime;
    }

    if (this.sceneIndex < this.totalScenes - 1) {
      // Hold at zero and wait for the parent to swap scenes. Narration for the
      // finished scene is torn down right away; its callbacks are already stale.
      this.currentTime = 0;
      this.awaitingScene = true;
      this.stopNarrationInternal();
      this.emit();
      if (this.callbacks.onSceneEnd) {
        try {
          this.callbacks.onSceneEnd();
        } catch (err) {
          console.error('Error in onSceneEnd callback:', err);
        }
      }
    } else {
      this.currentTime = this.duration;
      this.isPlaying = false;
      // Playback is over: stop narration and its fallback timer, restore the music
      // gain and also stop the ambient music since there is nothing left to play.
      this.stopNarrationInternal();
      this.engine.stopMusic();
      this.emit();
      if (this.callbacks.onPlaybackEnd) {
        try {
          this.callbacks.onPlaybackEnd();
        } catch (err) {
          console.error('Error in onPlaybackEnd callback:', err);
        }
      }
    }

    return this.currentTime;
  }

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  public setPlaybackSpeed(speed: number) {
    this.playbackSpeed = Math.max(0.1, Number.isFinite(speed) ? speed : 1);
  }

  public setSpeechParams(rate: number, pitch: number) {
    this.voiceRate = Number.isFinite(rate) ? rate : 1;
    this.voicePitch = Number.isFinite(pitch) ? pitch : 1;
  }

  public setVoiceMuted(muted: boolean) {
    const next = Boolean(muted);
    if (this.voiceMuted === next) return;
    this.voiceMuted = next;
    this.stopNarrationInternal();
    if (this.isPlaying && !next) {
      this.startNarrationAt(this.currentTime);
    }
    this.emit();
  }

  public setMusicEnabled(enabled: boolean) {
    const next = Boolean(enabled);
    if (this.musicEnabled === next) return;
    this.musicEnabled = next;
    if (!next) {
      // Disabling background music is part of the same lifecycle reset: stop the
      // current narration and its fallback timer, clear the subtitle override and
      // restore the music gain so it can never remain ducked.
      this.stopNarrationInternal();
      this.engine.stopMusic();
    } else if (this.isPlaying) {
      // Only the music is restored; narration stays stopped until the next
      // explicit narration action (play / unmute / seek / scene change).
      this.engine.startMusic(this.musicTrack);
    }
    this.emit();
  }

  public setMusicTrack(track: string) {
    if (!track || this.musicTrack === track) return;
    this.musicTrack = track;
    if (this.isPlaying && this.musicEnabled) {
      this.engine.startMusic(track);
    }
    this.emit();
  }

  public setMusicVolume(volume: number) {
    this.engine.setMusicVolume(volume);
  }

  public setAutoDuck(enabled: boolean) {
    this.autoDuck = Boolean(enabled);
    this.engine.setAutoDuck(this.autoDuck);
    this.emit();
  }

  public getMusicEnabled(): boolean {
    return this.musicEnabled;
  }

  public getVoiceMuted(): boolean {
    return this.voiceMuted;
  }

  // ---------------------------------------------------------------------------
  // Narration internals
  // ---------------------------------------------------------------------------

  private syncMusic() {
    if (this.isPlaying && this.musicEnabled) {
      this.engine.startMusic(this.musicTrack);
    } else {
      this.engine.stopMusic();
    }
  }

  /**
   * Invalidate the current narration epoch *before* stopping the engine, so the
   * engine's end callback for the outgoing session is ignored, then restore the
   * music level and clear the subtitle override.
   */
  private stopNarrationInternal() {
    this.narrationEpoch += 1;
    this.liveWordIndex = -1;
    this.narrationActive = false;
    this.engine.stopNarration();
  }

  private startNarrationAt(time: number) {
    const scene = this.scene;
    this.liveWordIndex = -1;

    if (!scene || this.voiceMuted) {
      this.narrationActive = false;
      return;
    }

    const words = splitNarrationWords(scene.narration);
    const hasCustomAudio = Boolean(scene.customAudioUrl);
    if (!hasCustomAudio && words.length === 0) {
      this.narrationActive = false;
      return;
    }

    const epoch = ++this.narrationEpoch;
    const sceneId = scene.id;
    const isCurrent = () => epoch === this.narrationEpoch && this.scene?.id === sceneId;

    const handleWord = (_word: string, _charIndex: number, wordIndex: number) => {
      if (!isCurrent()) return;
      this.liveWordIndex = wordIndex;
      this.emit();
    };

    const handleEnd = () => {
      if (!isCurrent()) return;
      this.liveWordIndex = -1;
      this.narrationActive = false;
      this.emit();
    };

    this.narrationActive = true;

    if (hasCustomAudio && scene.customAudioUrl) {
      this.engine.playCustomAudio(scene.customAudioUrl, handleEnd, {
        startTime: Math.max(0, time),
      });
    } else {
      const startWordIndex = Math.max(0, this.getWordIndexForTime(time, words));
      this.engine.speakNarration(
        scene.narration,
        handleWord,
        handleEnd,
        this.voiceRate,
        this.voicePitch,
        { startWordIndex }
      );
    }

    // If the engine could not start (e.g. no speech synthesis) it calls onEnd
    // synchronously, which already flipped narrationActive back to false.
  }

  /** Release audio resources; the controller remains usable after dispose. */
  public dispose() {
    this.isPlaying = false;
    this.isScrubbing = false;
    this.awaitingScene = false;
    this.stopNarrationInternal();
    this.engine.stopMusic();
  }
}
