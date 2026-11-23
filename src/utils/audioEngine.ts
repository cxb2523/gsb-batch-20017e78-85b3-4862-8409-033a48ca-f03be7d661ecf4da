// Audio Engine with real-time generative background music, Web Speech TTS, and auto-ducking
//
// Lifecycle contract
// ------------------
// Every narration request (Web Speech or a custom uploaded clip) belongs to a *session*.
// Only the newest session is allowed to touch shared state (ducking, word highlight,
// end callbacks, fallback timers). Starting or stopping narration bumps the active
// session so callbacks from an older scene / older utterance become no-ops.

export interface AudioPlaybackState {
  isPlaying: boolean;
  currentTime: number;
  currentWordIndex: number;
  duckingActive: boolean;
}

export type WordBoundaryListener = (
  word: string,
  charIndex: number,
  wordIndex: number,
  sessionId: number
) => void;

export interface NarrationOptions {
  /** Speak only the words starting at this index (used after seeking / resuming). */
  startWordIndex?: number;
}

export interface CustomAudioOptions {
  /** Start the uploaded track at this offset (seconds). */
  startTime?: number;
}

/** Full-volume background music level. */
export const MUSIC_LEVEL = 0.25;
/** Ducking level applied while the narrator is speaking. */
export const MUSIC_DUCK_LEVEL = 0.08;

type TimerId = ReturnType<typeof setInterval>;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private musicGain: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  private masterGain: GainNode | null = null;
  private isMusicPlayingActive = false;
  private musicInterval: TimerId | null = null;
  private currentTrack = 'lofi';
  private speechUtterance: SpeechSynthesisUtterance | null = null;
  private wordListeners: Set<WordBoundaryListener> = new Set();
  private currentWordIndex: number = -1;
  private currentSpokenWord: string = '';
  private fallbackWordTimer: TimerId | null = null;
  private hasReceivedNativeBoundary: boolean = false;

  private sessionSeq: number = 0;
  private activeSession: number = 0;
  private activeKind: 'speech' | 'custom' | null = null;
  private activeOnEnd: (() => void) | null = null;
  private customAudio: HTMLAudioElement | null = null;

  private duckingActive: boolean = false;
  private autoDuck: boolean = true;
  private musicGainTarget: number = MUSIC_LEVEL;

  public getCurrentTrack(): string {
    return this.currentTrack;
  }

  /** True while a Web Speech utterance is in flight (custom audio excluded). */
  public isSpeaking(): boolean {
    return this.activeKind === 'speech' && this.speechUtterance !== null;
  }

  /** True while *any* narration (speech or uploaded audio) is in flight. */
  public isNarrationActive(): boolean {
    return this.activeSession !== 0;
  }

  /** Monotonic id of the currently active narration session (0 = idle). */
  public getActiveSessionId(): number {
    return this.activeSession;
  }

  public addWordListener(listener: WordBoundaryListener): () => void {
    this.wordListeners.add(listener);
    if (this.activeSession !== 0 && this.currentWordIndex >= 0) {
      try {
        listener(this.currentSpokenWord, 0, this.currentWordIndex, this.activeSession);
      } catch {}
    }
    return () => {
      this.wordListeners.delete(listener);
    };
  }

  public notifyWord(word: string, charIndex: number, wordIndex: number, sessionId?: number) {
    const session = sessionId === undefined ? this.activeSession : sessionId;
    if (sessionId === undefined || sessionId === this.activeSession) {
      this.currentSpokenWord = word;
      this.currentWordIndex = wordIndex;
    }
    this.wordListeners.forEach((listener) => {
      try {
        listener(word, charIndex, wordIndex, session);
      } catch (err) {
        console.error('Error in word listener:', err);
      }
    });
  }

  public getCurrentWord(): { word: string; index: number } {
    return { word: this.currentSpokenWord, index: this.currentWordIndex };
  }

  private initContext() {
    if (typeof window === 'undefined') return;
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return;
      this.ctx = new AudioCtx();

      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.setValueAtTime(0.9, this.ctx.currentTime);
      this.masterGain.connect(this.ctx.destination);

      this.musicGain = this.ctx.createGain();
      this.musicGain.gain.setValueAtTime(this.musicGainTarget, this.ctx.currentTime);
      this.musicGain.connect(this.masterGain);

      this.sfxGain = this.ctx.createGain();
      this.sfxGain.gain.setValueAtTime(0.4, this.ctx.currentTime);
      this.sfxGain.connect(this.masterGain);

      // Re-apply the logical ducking target now that the graph exists.
      this.rampMusicGain(this.musicGainTarget, 0);
    }

    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }

  // Play Sound Effects
  public playPop() {
    try {
      this.initContext();
      if (!this.ctx || !this.sfxGain) return;
      const t = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(320, t);
      osc.frequency.exponentialRampToValueAtTime(740, t + 0.08);

      gain.gain.setValueAtTime(0.3, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.09);

      osc.connect(gain);
      gain.connect(this.sfxGain);

      osc.start(t);
      osc.stop(t + 0.1);
    } catch {
      // Audio fallback
    }
  }

  public playWhoosh() {
    try {
      this.initContext();
      if (!this.ctx || !this.sfxGain) return;
      const t = this.ctx.currentTime;

      // Filtered noise swoosh
      const bufferSize = this.ctx.sampleRate * 0.2;
      const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
      const output = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        output[i] = (Math.random() * 2 - 1) * 0.3;
      }

      const noise = this.ctx.createBufferSource();
      noise.buffer = buffer;

      const filter = this.ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(400, t);
      filter.frequency.exponentialRampToValueAtTime(1400, t + 0.1);
      filter.frequency.exponentialRampToValueAtTime(300, t + 0.2);
      filter.Q.value = 3.0;

      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0.01, t);
      gain.gain.linearRampToValueAtTime(0.2, t + 0.08);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.2);

      noise.connect(filter);
      filter.connect(gain);
      gain.connect(this.sfxGain);

      noise.start(t);
      noise.stop(t + 0.2);
    } catch {
      // Audio fallback
    }
  }

  public playDrawChime() {
    try {
      this.initContext();
      if (!this.ctx || !this.sfxGain) return;
      const t = this.ctx.currentTime;
      const notes = [523.25, 659.25, 783.99]; // C5, E5, G5
      notes.forEach((freq, idx) => {
        const osc = this.ctx!.createOscillator();
        const gain = this.ctx!.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, t + idx * 0.04);
        gain.gain.setValueAtTime(0.12, t + idx * 0.04);
        gain.gain.exponentialRampToValueAtTime(0.001, t + idx * 0.04 + 0.25);
        osc.connect(gain);
        gain.connect(this.sfxGain!);
        osc.start(t + idx * 0.04);
        osc.stop(t + idx * 0.04 + 0.28);
      });
    } catch {
      // Audio fallback
    }
  }

  // ---------------------------------------------------------------------------
  // Music gain / auto-ducking
  // ---------------------------------------------------------------------------

  public getMusicGainTarget(): number {
    return this.musicGainTarget;
  }

  public isDuckingActive(): boolean {
    return this.duckingActive;
  }

  public isMusicActive(): boolean {
    return this.isMusicPlayingActive;
  }

  public getAutoDuck(): boolean {
    return this.autoDuck;
  }

  private baseMusicLevel: number = MUSIC_LEVEL;

  /** Set the un-ducked music level (project.musicVolume). */
  public setMusicVolume(volume: number) {
    const parsed = Number(volume);
    this.baseMusicLevel = Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : MUSIC_LEVEL;
    this.syncDucking();
  }

  private rampMusicGain(target: number, rampSeconds: number = 0.25) {
    this.musicGainTarget = target;
    if (!this.ctx || !this.musicGain) return;
    const t = this.ctx.currentTime;
    const param = this.musicGain.gain;
    try {
      param.cancelScheduledValues(t);
      param.setValueAtTime(param.value, t);
    } catch {}
    try {
      param.linearRampToValueAtTime(target, t + Math.max(0, rampSeconds));
    } catch {
      try {
        param.setValueAtTime(target, t);
      } catch {}
    }
  }

  /**
   * Ducking is a pure function of "narration session active" + autoDuck setting.
   * This is what keeps music from remaining ducked after a scene change / pause /
   * seek, and what makes re-enabling music mid-narration duck immediately.
   */
  private syncDucking() {
    this.duckingActive = this.autoDuck && this.activeSession !== 0;
    const duckedTarget = Math.min(this.baseMusicLevel, MUSIC_DUCK_LEVEL);
    this.rampMusicGain(this.duckingActive ? duckedTarget : this.baseMusicLevel);
  }

  public setAutoDuck(enabled: boolean) {
    this.autoDuck = Boolean(enabled);
    this.syncDucking();
  }

  /**
   * Explicit duck request kept for API compatibility. It is still gated by autoDuck
   * and by an active narration session: music is never left ducked when nobody is
   * speaking.
   */
  public setDucking(active: boolean) {
    this.duckingActive = Boolean(active) && this.autoDuck && this.activeSession !== 0;
    const duckedTarget = Math.min(this.baseMusicLevel, MUSIC_DUCK_LEVEL);
    this.rampMusicGain(this.duckingActive ? duckedTarget : this.baseMusicLevel);
  }

  // ---------------------------------------------------------------------------
  // Generative background music
  // ---------------------------------------------------------------------------

  public startMusic(track: string = 'lofi') {
    this.initContext();
    if (this.isMusicPlayingActive && this.currentTrack === track) {
      // Idempotent: never stack a second chord interval for the same track.
      this.syncDucking();
      return;
    }
    this.stopMusic();
    this.currentTrack = track;
    this.isMusicPlayingActive = true;
    this.syncDucking();

    // Generative chord progression based on track
    const chordProgressions: Record<string, number[][]> = {
      lofi: [
        [261.63, 329.63, 392.0, 493.88], // Cmaj7
        [220.0, 261.63, 329.63, 392.0],  // Am7
        [174.61, 220.0, 261.63, 329.63], // Fmaj7
        [196.0, 246.94, 293.66, 349.23], // G7
      ],
      tech: [
        [130.81, 196.0, 261.63, 392.0], // C power
        [110.0, 164.81, 220.0, 329.63], // A power
        [146.83, 220.0, 293.66, 440.0], // D power
        [123.47, 185.0, 246.94, 370.0], // B power
      ],
      acoustic: [
        [261.63, 329.63, 392.0],        // C
        [196.0, 246.94, 293.66],        // G
        [220.0, 261.63, 329.63],        // Am
        [174.61, 220.0, 261.63],        // F
      ],
    };

    const chords = chordProgressions[track] || chordProgressions.lofi;
    let chordIdx = 0;

    const playChord = () => {
      if (!this.isMusicPlayingActive || !this.ctx || !this.musicGain) return;
      const notes = chords[chordIdx % chords.length];
      chordIdx++;

      const t = this.ctx.currentTime;
      notes.forEach((freq, i) => {
        const osc = this.ctx!.createOscillator();
        const gain = this.ctx!.createGain();
        osc.type = track === 'tech' ? 'sawtooth' : 'sine';
        osc.frequency.setValueAtTime(freq, t);

        const filter = this.ctx!.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(track === 'tech' ? 1200 : 700, t);

        gain.gain.setValueAtTime(0.02, t);
        gain.gain.linearRampToValueAtTime(0.08, t + 0.6 + i * 0.05);
        gain.gain.exponentialRampToValueAtTime(0.005, t + 3.2);

        osc.connect(filter);
        filter.connect(gain);
        gain.connect(this.musicGain!);

        osc.start(t);
        osc.stop(t + 3.3);
      });
    };

    playChord();
    this.musicInterval = setInterval(playChord, 3200);
  }

  public stopMusic() {
    this.isMusicPlayingActive = false;
    if (this.musicInterval) {
      clearInterval(this.musicInterval);
      this.musicInterval = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Narration (Web Speech + custom audio) session management
  // ---------------------------------------------------------------------------

  private hasSpeechSupport(): boolean {
    return (
      typeof window !== 'undefined' &&
      'speechSynthesis' in window &&
      typeof SpeechSynthesisUtterance !== 'undefined'
    );
  }

  private clearFallbackTimer() {
    if (this.fallbackWordTimer) {
      clearInterval(this.fallbackWordTimer);
      this.fallbackWordTimer = null;
    }
  }

  private teardownCustomAudio() {
    const audio = this.customAudio;
    if (!audio) return;
    this.customAudio = null;
    try {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audio.currentTime = 0;
    } catch {}
  }

  /**
   * Stop whichever narration is active, clear its fallback timer, detach custom
   * audio callbacks and restore music volume. Ending a session notifies its owner
   * exactly once; stale utterance/browser callbacks can no longer reach state.
   */
  public stopNarration() {
    const hadSession = this.activeSession !== 0;
    const onEnd = this.activeOnEnd;

    this.activeSession = 0;
    this.activeKind = null;
    this.activeOnEnd = null;

    this.clearFallbackTimer();
    this.speechUtterance = null;
    if (this.hasSpeechSupport()) {
      try {
        window.speechSynthesis.cancel();
      } catch {}
    }
    this.teardownCustomAudio();

    this.currentWordIndex = -1;
    this.currentSpokenWord = '';
    this.notifyWord('', -1, -1, 0);
    this.syncDucking();

    if (hadSession && onEnd) {
      try {
        onEnd();
      } catch (err) {
        console.error('Error in narration end callback:', err);
      }
    }
  }

  /** Backwards-compatible alias used by the script editor / legacy callers. */
  public stopSpeaking() {
    this.stopNarration();
  }

  /**
   * Speak narration. Returns the new session id (0 when nothing was spoken).
   * Any previous narration is stopped first, so repeated calls can never stack.
   */
  public speakNarration(
    text: string,
    onWordSpoken?: (word: string, charIndex: number, wordIndex: number) => void,
    onEnd?: () => void,
    rate: number = 1.0,
    pitch: number = 1.0,
    options: NarrationOptions = {}
  ): number {
    this.stopNarration();

    const trimmedText = typeof text === 'string' ? text.trim() : '';
    if (!trimmedText || !this.hasSpeechSupport()) {
      if (onEnd) onEnd();
      return 0;
    }

    this.initContext();

    const session = ++this.sessionSeq;
    this.activeSession = session;
    this.activeKind = 'speech';
    this.activeOnEnd = onEnd || null;
    this.syncDucking();

    const allWords = trimmedText.split(/\s+/).filter(Boolean);
    const startWordIndex = Math.max(0, Math.min(allWords.length - 1, options.startWordIndex ?? 0));
    const wordsList = allWords.slice(startWordIndex);
    if (wordsList.length === 0) {
      this.stopNarration();
      if (onEnd) onEnd();
      return 0;
    }
    const spokenText = wordsList.join(' ');

    const utterance = new SpeechSynthesisUtterance(spokenText);
    utterance.rate = Math.max(0.7, Math.min(1.5, rate));
    utterance.pitch = Math.max(0.8, Math.min(1.3, pitch));

    // Try to pick a natural English voice
    try {
      const voices = window.speechSynthesis.getVoices();
      const naturalVoice =
        voices.find(
          (v) =>
            (v.name.includes('Natural') ||
              v.name.includes('Google') ||
              v.name.includes('Siri') ||
              v.name.includes('Samantha') ||
              v.name.includes('Daniel')) &&
            v.lang.startsWith('en')
        ) || voices.find((v) => v.lang.startsWith('en'));
      if (naturalVoice) utterance.voice = naturalVoice;
    } catch {
      // Voice list unavailable
    }

    this.hasReceivedNativeBoundary = false;

    // Fallback timer: in case SpeechSynthesis onboundary is not fired by the OS/voice.
    // Estimates speech progress (~2.6 words per second scaled by rate). Every tick
    // re-checks the session id so a timer from a previous scene can never write into
    // the current scene's subtitle state.
    let fallbackIdx = 0;
    const intervalMs = Math.max(150, Math.round(1000 / (2.6 * utterance.rate)));
    this.fallbackWordTimer = setInterval(() => {
      if (session !== this.activeSession) {
        this.clearFallbackTimer();
        return;
      }
      if (this.hasReceivedNativeBoundary) {
        this.clearFallbackTimer();
        return;
      }
      if (fallbackIdx < wordsList.length) {
        const spokenWord = wordsList[fallbackIdx];
        const wordIndex = startWordIndex + fallbackIdx;
        fallbackIdx++;
        try {
          if (onWordSpoken) onWordSpoken(spokenWord, 0, wordIndex);
        } catch (err) {
          console.error('Error in word callback:', err);
        }
        this.notifyWord(spokenWord, 0, wordIndex, session);
      } else {
        this.clearFallbackTimer();
      }
    }, intervalMs);

    utterance.onboundary = (event) => {
      if (session !== this.activeSession) return;
      if (event.name !== 'word') return;

      this.hasReceivedNativeBoundary = true;
      this.clearFallbackTimer();

      const charIdx = event.charIndex;
      const slice = spokenText.slice(charIdx);
      const match = slice.match(/^[\w'-]+/);
      const spokenWord = match
        ? match[0]
        : event.charLength
        ? spokenText.substring(charIdx, charIdx + event.charLength)
        : '';

      const textBefore = spokenText.slice(0, charIdx);
      const wordsBefore = textBefore.trim() ? textBefore.trim().split(/\s+/).filter(Boolean) : [];
      const wordIndex = startWordIndex + wordsBefore.length;

      try {
        if (onWordSpoken) onWordSpoken(spokenWord, charIdx, wordIndex);
      } catch (err) {
        console.error('Error in word callback:', err);
      }
      this.notifyWord(spokenWord, charIdx, wordIndex, session);
    };

    const finish = () => {
      if (session !== this.activeSession) return;
      this.clearFallbackTimer();
      this.speechUtterance = null;
      this.activeSession = 0;
      this.activeKind = null;
      const callback = this.activeOnEnd;
      this.activeOnEnd = null;
      this.currentWordIndex = -1;
      this.currentSpokenWord = '';
      this.notifyWord('', -1, -1, 0);
      this.syncDucking();
      if (callback) {
        try {
          callback();
        } catch (err) {
          console.error('Error in narration end callback:', err);
        }
      }
    };

    utterance.onend = finish;
    utterance.onerror = finish;

    this.speechUtterance = utterance;
    try {
      window.speechSynthesis.speak(utterance);
    } catch {
      finish();
    }

    return session;
  }

  /**
   * Play an uploaded voiceover clip with the same session semantics as TTS.
   * Returns the session id (0 when playback could not start).
   */
  public playCustomAudio(url: string, onEnd?: () => void, options: CustomAudioOptions = {}): number {
    const AudioCtor: typeof Audio | undefined =
      typeof Audio !== 'undefined'
        ? Audio
        : typeof window !== 'undefined'
        ? (window as unknown as { Audio?: typeof Audio }).Audio
        : undefined;

    this.stopNarration();

    if (!AudioCtor) {
      if (onEnd) onEnd();
      return 0;
    }

    const session = ++this.sessionSeq;
    this.activeSession = session;
    this.activeKind = 'custom';
    this.activeOnEnd = onEnd || null;
    this.syncDucking();

    const audio = new AudioCtor(url);

    const finish = () => {
      if (session !== this.activeSession) return;
      this.customAudio = null;
      this.activeSession = 0;
      this.activeKind = null;
      const callback = this.activeOnEnd;
      this.activeOnEnd = null;
      this.currentWordIndex = -1;
      this.currentSpokenWord = '';
      this.notifyWord('', -1, -1, 0);
      this.syncDucking();
      if (callback) {
        try {
          callback();
        } catch (err) {
          console.error('Error in narration end callback:', err);
        }
      }
    };

    audio.onended = finish;
    audio.onerror = finish;

    if (options.startTime && options.startTime > 0) {
      try {
        audio.currentTime = options.startTime;
      } catch {}
    }

    this.customAudio = audio;
    try {
      const playResult = audio.play();
      if (playResult && typeof playResult.catch === 'function') {
        playResult.catch(() => {});
      }
    } catch {}

    return session;
  }

  /** Seek the uploaded clip, if one is active. */
  public seekCustomAudio(time: number) {
    if (!this.customAudio) return;
    try {
      this.customAudio.currentTime = Math.max(0, time);
    } catch {}
  }

  public stopCustomAudio() {
    if (this.activeKind === 'custom') {
      this.stopNarration();
      return;
    }
    this.teardownCustomAudio();
  }

  public stopAll() {
    this.stopNarration();
    this.stopMusic();
  }

  /** Tear everything down (used by tests and full app resets). */
  public dispose() {
    this.stopAll();
    this.wordListeners.clear();
    this.currentWordIndex = -1;
    this.currentSpokenWord = '';
  }
}

export const audioEngine = new AudioEngine();
