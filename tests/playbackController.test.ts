import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  PlaybackController,
} from '../src/utils/playbackController';
import type { NarrationEngine, PlaybackSnapshot } from '../src/utils/playbackController';
import type { Scene } from '../src/types/explainroo';

interface FakeSession {
  id: number;
  text: string;
  startWordIndex: number;
  onWord?: (word: string, charIndex: number, wordIndex: number) => void;
  onEnd?: () => void;
}

class FakeEngine implements NarrationEngine {
  public nextSession = 0;
  public sessions = new Map<number, FakeSession>();
  public activeSession = 0;
  public maxConcurrentNarrations = 0;
  public narrationStarts = 0;
  public stopCount = 0;
  public musicStarts: string[] = [];
  public musicStops = 0;
  public musicActive = false;
  public ducked = false;
  public autoDuck = true;
  public volume = 0.25;
  public customPlays: Array<{ url: string; startTime: number; session: number }> = [];

  speakNarration(
    text: string,
    onWordSpoken?: (word: string, charIndex: number, wordIndex: number) => void,
    onEnd?: () => void,
    _rate?: number,
    _pitch?: number,
    options?: { startWordIndex?: number }
  ): number {
    this.stopNarration();
    const id = ++this.nextSession;
    this.narrationStarts++;
    this.sessions.set(id, {
      id,
      text,
      startWordIndex: options?.startWordIndex ?? 0,
      onWord: onWordSpoken,
      onEnd,
    });
    this.activeSession = id;
    this.ducked = this.autoDuck;
    this.maxConcurrentNarrations = Math.max(
      this.maxConcurrentNarrations,
      Array.from(this.sessions.values()).filter((s) => s.id === this.activeSession).length
    );
    return id;
  }

  playCustomAudio(url: string, onEnd?: () => void, options?: { startTime?: number }): number {
    this.stopNarration();
    const id = ++this.nextSession;
    this.narrationStarts++;
    const session: FakeSession = { id, text: `custom:${url}`, startWordIndex: 0, onEnd };
    this.sessions.set(id, session);
    this.activeSession = id;
    this.ducked = this.autoDuck;
    this.customPlays.push({ url, startTime: options?.startTime ?? 0, session: id });
    return id;
  }

  stopNarration(): void {
    if (this.activeSession !== 0) this.stopCount++;
    this.activeSession = 0;
    this.ducked = false;
  }

  seekCustomAudio(_time: number): void {}

  startMusic(track: string): void {
    this.musicStarts.push(track);
    this.musicActive = true;
  }

  stopMusic(): void {
    this.musicStops++;
    this.musicActive = false;
  }

  setAutoDuck(enabled: boolean): void {
    this.autoDuck = enabled;
    if (!enabled) this.ducked = false;
  }

  setMusicVolume(volume: number): void {
    this.volume = volume;
  }

  // --- test helpers -------------------------------------------------------
  fireWord(sessionId: number, wordIndex: number) {
    const s = this.sessions.get(sessionId);
    s?.onWord?.('word', 0, wordIndex);
  }

  fireEnd(sessionId: number) {
    const s = this.sessions.get(sessionId);
    s?.onEnd?.();
  }
}

function makeScene(overrides: Partial<Scene> = {}): Scene {
  return {
    id: 'scene-a',
    title: 'Scene A',
    narration: 'one two three four five six',
    elements: [],
    durationSeconds: 6,
    ...overrides,
  };
}

function trackSnapshots(controller: PlaybackController): PlaybackSnapshot[] {
  const snapshots: PlaybackSnapshot[] = [];
  controller.subscribe((s) => snapshots.push(s));
  return snapshots;
}

describe('PlaybackController narration lifecycle', () => {
  let engine: FakeEngine;
  let controller: PlaybackController;

  beforeEach(() => {
    engine = new FakeEngine();
    controller = new PlaybackController(engine);
    controller.updateScene(makeScene(), 0, 2);
  });

  test('play starts exactly one narration session', () => {
    controller.play();
    controller.play(); // idempotent
    assert.equal(engine.narrationStarts, 1);
    assert.equal(engine.activeSession, 1);
    assert.equal(engine.ducked, true);
    assert.equal(controller.getSnapshot().isPlaying, true);
  });

  test('pause stops narration, restores music level and resets highlight', () => {
    controller.play();
    const session = engine.activeSession;
    engine.fireWord(session, 3);
    assert.equal(controller.getSnapshot().liveWordIndex, 3);

    controller.pause();
    assert.equal(engine.activeSession, 0);
    assert.equal(engine.ducked, false, 'music must not stay ducked after pause');
    assert.equal(controller.getSnapshot().liveWordIndex, -1);
    assert.equal(controller.getSnapshot().narrationActive, false);
  });

  test('resume after pause does not stack narrations', () => {
    controller.play();
    controller.pause();
    controller.play();
    controller.pause();
    controller.play();

    assert.equal(engine.maxConcurrentNarrations, 1);
    assert.equal(engine.narrationStarts, 3);
    assert.equal(engine.activeSession !== 0, true);
    // Every start was preceded by a stop of the previous session.
    assert.equal(engine.stopCount, 2);
  });

  test('paused scene edit does not start narration', () => {
    controller.updateScene(makeScene({ narration: 'edited words here' }), 0, 2);
    assert.equal(engine.narrationStarts, 0);
    assert.equal(controller.getWordIndexForTime(0), 0);
  });

  test('editing narration while playing replaces the session instead of stacking', () => {
    controller.play();
    const first = engine.activeSession;
    controller.updateScene(makeScene({ narration: 'totally new words in this scene' }), 0, 2);
    assert.equal(engine.narrationStarts, 2);
    assert.notEqual(engine.activeSession, first);
    assert.equal(engine.activeSession !== 0, true);
  });
});

describe('PlaybackController scene switching', () => {
  test('rapid scene switches ignore callbacks from the previous scene', () => {
    const engine = new FakeEngine();
    const controller = new PlaybackController(engine);
    const sceneA = makeScene({ id: 'a', narration: 'alpha beta gamma delta' });
    const sceneB = makeScene({ id: 'b', narration: 'one two three four' });

    controller.updateScene(sceneA, 0, 2);
    controller.play();
    const sessionA = engine.activeSession;

    // Switch to scene B while still playing, then immediately back to A and to B.
    controller.updateScene(sceneB, 1, 2);
    const sessionB1 = engine.activeSession;
    controller.updateScene(sceneA, 0, 2);
    controller.updateScene(sceneB, 1, 2);
    const sessionB2 = engine.activeSession;

    assert.notEqual(sessionA, sessionB2);
    assert.notEqual(sessionB1, sessionB2);

    // Late callbacks from scene A / the first B must not touch scene B's state.
    engine.fireWord(sessionA, 2);
    engine.fireWord(sessionB1, 1);
    engine.fireEnd(sessionA);

    const snapshot = controller.getSnapshot();
    assert.equal(snapshot.sceneId, 'b');
    assert.equal(snapshot.liveWordIndex, -1, 'stale word callbacks must be ignored');
    assert.equal(snapshot.isPlaying, true);
    assert.equal(engine.activeSession, sessionB2, 'stale end callback must not stop current narration');
  });

  test('scene switch resets time and starts the new scene narration', () => {
    const engine = new FakeEngine();
    const controller = new PlaybackController(engine);
    controller.updateScene(makeScene({ id: 'a' }), 0, 2);
    controller.play();
    controller.advance(2.5);

    controller.updateScene(makeScene({ id: 'b', narration: 'new scene text' }), 1, 2);
    const snapshot = controller.getSnapshot();
    assert.equal(snapshot.currentTime, 0);
    assert.equal(snapshot.sceneId, 'b');
    assert.equal(snapshot.narrationActive, true);
    assert.equal(engine.narrationStarts, 2);
  });

  test('reaching the end of a non-final scene invokes onSceneEnd once', () => {
    const engine = new FakeEngine();
    const controller = new PlaybackController(engine);
    let sceneEnds = 0;
    controller.setCallbacks({ onSceneEnd: () => sceneEnds++ });

    controller.updateScene(makeScene({ id: 'a', durationSeconds: 2 }), 0, 2);
    controller.play();
    controller.advance(2.5);
    controller.advance(1); // guarded while waiting for the parent to swap scenes
    assert.equal(sceneEnds, 1);
    assert.equal(controller.getSnapshot().currentTime, 0);
    assert.equal(engine.activeSession, 0, 'finished scene narration must be stopped');
    assert.equal(engine.ducked, false);
  });

  test('last scene end stops playback, narration and music', () => {
    const engine = new FakeEngine();
    const controller = new PlaybackController(engine);
    let ended = 0;
    controller.setCallbacks({ onPlaybackEnd: () => ended++ });

    controller.updateScene(makeScene({ id: 'a', durationSeconds: 2 }), 0, 1);
    controller.play();
    controller.advance(3);

    assert.equal(ended, 1);
    const snapshot = controller.getSnapshot();
    assert.equal(snapshot.isPlaying, false);
    assert.equal(snapshot.currentTime, 2);
    assert.equal(engine.activeSession, 0);
    assert.equal(engine.musicActive, false);
    assert.equal(engine.ducked, false);
  });
});

describe('PlaybackController seeking and replay', () => {
  test('seek while playing stops old narration and restarts at the new word', () => {
    const engine = new FakeEngine();
    const controller = new PlaybackController(engine);
    controller.updateScene(makeScene(), 0, 1);
    controller.play();
    const first = engine.activeSession;
    engine.fireWord(first, 1);

    controller.seek(4.5); // 4.5 / 6 * 6 words -> index 4
    assert.equal(engine.activeSession !== 0, true);
    assert.notEqual(engine.activeSession, first);
    assert.equal(engine.sessions.get(engine.activeSession)?.startWordIndex, 4);

    engine.fireWord(first, 1); // stale
    assert.equal(controller.getSnapshot().liveWordIndex, -1);
  });

  test('scrub drag only starts one narration session at the end', () => {
    const engine = new FakeEngine();
    const controller = new PlaybackController(engine);
    controller.updateScene(makeScene(), 0, 1);
    controller.play();
    const startsBefore = engine.narrationStarts;

    controller.beginScrub();
    for (let t = 0.5; t <= 5; t += 0.5) controller.scrubTo(t);
    assert.equal(engine.narrationStarts, startsBefore, 'no speech while scrubbing');
    assert.equal(controller.getSnapshot().liveWordIndex, -1);
    assert.equal(controller.getSnapshot().activeWordIndex, 5, 'highlight follows scrub position');

    // The rAF clock must not fight the drag by advancing the timeline.
    controller.advance(1);
    assert.equal(controller.getSnapshot().currentTime, 5);

    controller.endScrub();
    assert.equal(engine.narrationStarts, startsBefore + 1);
    assert.equal(engine.sessions.get(engine.activeSession)?.startWordIndex, 5);
  });

  test('scrubbing while paused only moves the highlight', () => {
    const engine = new FakeEngine();
    const controller = new PlaybackController(engine);
    controller.updateScene(makeScene(), 0, 1);

    controller.beginScrub();
    controller.scrubTo(3);
    controller.endScrub();
    assert.equal(engine.narrationStarts, 0);
    assert.equal(controller.getSnapshot().activeWordIndex, 3);
    assert.equal(controller.getSnapshot().isPlaying, false);
  });

  test('cue jump seeks and resets the subtitle index', () => {
    const engine = new FakeEngine();
    const controller = new PlaybackController(engine);
    controller.updateScene(makeScene(), 0, 1);
    controller.play();
    const first = engine.activeSession;
    engine.fireWord(first, 5);

    controller.seek(1); // word index 1
    assert.equal(controller.getSnapshot().activeWordIndex, 1);
    assert.equal(engine.sessions.get(engine.activeSession)?.startWordIndex, 1);
  });

  test('restart/replay starts a single fresh narration from the beginning', () => {
    const engine = new FakeEngine();
    const controller = new PlaybackController(engine);
    controller.updateScene(makeScene(), 0, 1);
    controller.play();
    controller.seek(3);
    controller.restart();

    const snapshot = controller.getSnapshot();
    assert.equal(snapshot.currentTime, 0);
    assert.equal(snapshot.isPlaying, true);
    assert.equal(engine.sessions.get(engine.activeSession)?.startWordIndex, 0);
    assert.equal(engine.maxConcurrentNarrations, 1);
  });
});

describe('PlaybackController mute + music coordination', () => {
  test('muting voice stops narration and restores music; unmuting restarts once', () => {
    const engine = new FakeEngine();
    const controller = new PlaybackController(engine);
    controller.updateScene(makeScene(), 0, 1);
    controller.play();

    controller.setVoiceMuted(true);
    assert.equal(engine.activeSession, 0);
    assert.equal(engine.ducked, false);

    controller.setVoiceMuted(true); // no-op
    assert.equal(engine.narrationStarts, 1);

    controller.setVoiceMuted(false);
    assert.equal(engine.narrationStarts, 2);
    assert.equal(engine.activeSession !== 0, true);
  });

  test('disabling music also stops narration and clears the highlight', () => {
    const engine = new FakeEngine();
    const controller = new PlaybackController(engine);
    controller.updateScene(makeScene(), 0, 1);
    controller.play();
    const session = engine.activeSession;
    engine.fireWord(session, 2);

    controller.setMusicEnabled(false);
    const snapshot = controller.getSnapshot();
    assert.equal(engine.musicActive, false);
    assert.equal(engine.activeSession, 0);
    assert.equal(engine.ducked, false);
    assert.equal(snapshot.liveWordIndex, -1);
    assert.equal(snapshot.narrationActive, false);
    assert.equal(snapshot.isPlaying, true, 'the timeline keeps running');
  });

  test('disabling music stops it and it never restarts on play or scene change', () => {
    const engine = new FakeEngine();
    const controller = new PlaybackController(engine);
    controller.updateScene(makeScene({ id: 'a' }), 0, 2);
    controller.play();
    assert.equal(engine.musicActive, true);

    controller.setMusicEnabled(false);
    assert.equal(engine.musicActive, false);
    const starts = engine.musicStarts.length;

    controller.pause();
    controller.play();
    controller.updateScene(makeScene({ id: 'b' }), 1, 2);
    controller.restart();

    assert.equal(engine.musicActive, false);
    assert.equal(engine.musicStarts.length, starts, 'disabled music must never restart');
  });

  test('re-enabling music while playing restores it without stacking narration', () => {
    const engine = new FakeEngine();
    const controller = new PlaybackController(engine);
    controller.updateScene(makeScene(), 0, 1);

    controller.setMusicEnabled(false);
    controller.setMusicEnabled(true);
    assert.equal(engine.musicActive, false, 'paused: enabling music must not start playback');
    assert.equal(engine.narrationStarts, 0);

    controller.play();
    assert.equal(engine.musicActive, true);
    const startsOnPlay = engine.narrationStarts;

    controller.setMusicEnabled(false);
    assert.equal(engine.activeSession, 0);
    assert.equal(engine.ducked, false);
    controller.setMusicEnabled(true);
    assert.equal(engine.musicActive, true);
    assert.equal(engine.narrationStarts, startsOnPlay, 're-enabling music does not restart narration');

    // An explicit action (unmute-equivalent) restarts exactly one narration.
    controller.setVoiceMuted(false);
    assert.equal(engine.maxConcurrentNarrations, 1);
  });

  test('the last scene reaching its end leaves the player paused for replay', () => {
    const engine = new FakeEngine();
    const controller = new PlaybackController(engine);
    controller.updateScene(makeScene({ id: 'only', durationSeconds: 2 }), 0, 1);
    controller.play();
    controller.advance(3);

    const snapshot = controller.getSnapshot();
    assert.equal(snapshot.isPlaying, false);
    assert.equal(snapshot.currentTime, snapshot.duration);
    assert.equal(engine.activeSession, 0);

    // Pressing play again replays from zero with exactly one narration.
    controller.play();
    assert.equal(controller.getSnapshot().currentTime, 0);
    assert.equal(controller.getSnapshot().isPlaying, true);
    assert.equal(engine.narrationStarts, 2);
  });

  test('custom audio narration uses the same lifecycle and session starts at offset', () => {
    const engine = new FakeEngine();
    const controller = new PlaybackController(engine);
    controller.updateScene(
      makeScene({ narration: '', customAudioUrl: 'blob:voice', durationSeconds: 10 }),
      0,
      1
    );
    controller.play();
    assert.equal(engine.customPlays.length, 1);
    assert.equal(engine.customPlays[0].url, 'blob:voice');

    controller.seek(4);
    assert.equal(engine.customPlays.length, 2);
    assert.equal(engine.customPlays[1].startTime, 4);
    assert.equal(engine.ducked, true);
  });

  test('music volume and auto-duck settings reach the engine', () => {
    const engine = new FakeEngine();
    const controller = new PlaybackController(engine);
    controller.updateScene(makeScene(), 0, 1);
    controller.setMusicVolume(0.4);
    controller.setAutoDuck(false);
    assert.equal(engine.volume, 0.4);
    assert.equal(engine.autoDuck, false);
  });

  test('external narration stop (e.g. script editor preview) clears the highlight', () => {
    const engine = new FakeEngine();
    const controller = new PlaybackController(engine);
    controller.updateScene(makeScene(), 0, 1);
    controller.play();
    const session = engine.activeSession;
    engine.fireWord(session, 4);
    assert.equal(controller.getSnapshot().liveWordIndex, 4);

    // Simulate another component calling audioEngine.stopSpeaking(): the engine
    // notifies listeners with wordIndex -1 for that session.
    engine.stopNarration();
    controller.observeEngineWord(0, -1);
    assert.equal(controller.getSnapshot().liveWordIndex, -1);
    assert.equal(controller.getSnapshot().activeWordIndex, 0, 'highlight falls back to the clock');
    assert.equal(controller.getSnapshot().isPlaying, true);
  });
});
