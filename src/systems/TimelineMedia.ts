import type * as Three from 'three';
import type { SceneObject } from '../types/editor';
import type { SceneTimeline, TimelineClip, TimelineSound } from '../types/timeline';

export function createTimelineMedia(
  timeline: SceneTimeline,
  objects: SceneObject[],
  three: typeof Three,
  reportError: (message: string) => void,
  preview: boolean
) {
  // Kept inside the factory: the exported player embeds this function via
  // `toString()`, so it must not reference module-level bindings.
  const EDGE = 1e-6;
  const clips = new Map<string, TimelineClip[]>();
  const mixers = new Map<string, Three.AnimationMixer>();
  const activeClips = new Map<string, string>();
  const sounds = new Map<string, {
    segment: TimelineSound; audio: HTMLAudioElement; active: boolean; attempt: number; pendingOffset: number | null
  }>();
  const clipIds = new Set<string>();
  const soundIds = new Set<string>();
  const find = (id: string) => objects.find(item => item.id === id);
  let stopped = false;
  let previousTime: number | undefined;

  if (timeline.clips !== undefined && !Array.isArray(timeline.clips)) reportError('Invalid timeline clip list.');
  else for (const segment of timeline.clips ?? []) {
    const item = segment && find(segment.targetId);
    const clip = item?.object.animations[segment.clipIndex];
    const list = clips.get(segment?.targetId) ?? [];
    if (!item || item.type !== 'model' || !clip || !segment.id || clipIds.has(segment.id) ||
        !Number.isInteger(segment.clipIndex) || !Number.isFinite(clip.duration) || clip.duration <= 0 ||
        !Number.isFinite(segment.start) || segment.start < 0 ||
        !Number.isFinite(segment.duration) || segment.duration <= 0 ||
        segment.start + segment.duration > timeline.duration + 1e-8 ||
        list.some(other => segment.start < other.start + other.duration - 1e-8 &&
          other.start < segment.start + segment.duration - 1e-8)) {
      reportError(`Invalid or overlapping timeline clip: ${segment?.id ?? '(missing)'}`);
      continue;
    }
    clipIds.add(segment.id);
    list.push(segment);
    clips.set(segment.targetId, list);
  }
  for (const list of clips.values()) list.sort((a, b) => a.start - b.start);

  if (timeline.sounds !== undefined && !Array.isArray(timeline.sounds)) reportError('Invalid timeline sound list.');
  else for (const segment of timeline.sounds ?? []) {
    const item = segment && find(segment.targetId);
    const sound = item?.properties.sounds?.find(value => value.id === segment.soundId);
    if (!sound || typeof sound.url !== 'string' || !sound.url || !Number.isFinite(sound.volume) ||
        sound.volume < 0 || sound.volume > 1 || !segment.id || soundIds.has(segment.id) ||
        !Number.isFinite(segment.start) || segment.start < 0 ||
        !Number.isFinite(segment.duration) || segment.duration <= 0 ||
        segment.start + segment.duration > timeline.duration + 1e-8) {
      reportError(`Invalid timeline sound: ${segment?.id ?? '(missing)'}`);
      continue;
    }
    soundIds.add(segment.id);
    if (!preview) {
      const audio = new Audio(sound.url);
      audio.volume = sound.volume;
      audio.loop = sound.loop;
      const state = { segment, audio, active: false, attempt: 0, pendingOffset: null as number | null };
      // Duration is unknown until metadata arrives, so a looping seek made earlier is
      // remembered and re-applied (wrapped) once the length is available.
      audio.addEventListener('loadedmetadata', () => {
        if (stopped || state.pendingOffset === null) return;
        const offset = state.pendingOffset;
        state.pendingOffset = null;
        audio.currentTime = wrapped(audio, offset);
      }, { once: true });
      sounds.set(segment.id, state);
    }
  }

  function endsTimeline(segment: TimelineClip) {
    return Math.abs(segment.start + segment.duration - timeline.duration) <= EDGE;
  }

  // A clip owns the half-open range [start, start + duration). The single exception is
  // the final timeline tick, which may land exactly on a clip end: keep that clip's
  // last frame there so scrubbing to the very end still shows the finished pose.
  function clipAt(list: TimelineClip[], time: number) {
    let found: TimelineClip | undefined;
    for (const segment of list) {
      const end = segment.start + segment.duration;
      if (time >= segment.start - EDGE && (time < end - EDGE ||
          (endsTimeline(segment) && time <= end + EDGE))) found = segment;
    }
    return found;
  }

  // Loop-aware clock: `offset` seconds into a looping sound becomes `offset % duration`.
  function wrapped(audio: HTMLAudioElement, offset: number) {
    const length = audio.duration;
    return audio.loop && Number.isFinite(length) && length > 0 ? offset % length : offset;
  }

  function seek(time: number, running: boolean, jump = false) {
    if (stopped) return;
    for (const [id, list] of clips) {
      const item = find(id)!;
      const segment = clipAt(list, time);
      const mixer = mixers.get(id);
      if (!segment) {
        if (mixer) {
          mixer.stopAllAction();
          activeClips.delete(id);
        }
        continue;
      }
      let target = mixer;
      if (!target) {
        target = new three.AnimationMixer(item.object);
        mixers.set(id, target);
      }
      const clip = item.object.animations[segment.clipIndex];
      if (activeClips.get(id) !== segment.id) {
        // Deactivating restores the pose saved before the previous action bound its
        // properties, so switching clips never leaves the old clip's last frame behind.
        target.stopAllAction();
        const action = target.clipAction(clip);
        action.reset();
        action.setLoop(three.LoopOnce, 1);
        action.clampWhenFinished = true;
        action.play();
        action.paused = true;
        activeClips.set(id, segment.id);
      }
      const action = target.clipAction(clip);
      action.time = Math.min(clip.duration, segment.duration, Math.max(0, time - segment.start));
      target.update(0);
    }
    const jumped = jump || (timeline.trigger !== 'scroll' && previousTime !== undefined &&
      (time < previousTime - EDGE || time - previousTime > 0.3));
    for (const state of sounds.values()) {
      const { segment, audio } = state;
      const shouldPlay = running && time >= segment.start && time < segment.start + segment.duration;
      if (!shouldPlay) {
        if (state.active) audio.pause();
        state.active = false;
        continue;
      }
      const seeking = !state.active || jumped;
      if (seeking) {
        const offset = Math.max(0, time - segment.start);
        const known = Number.isFinite(audio.duration) && audio.duration > 0;
        const target = wrapped(audio, offset);
        try {
          audio.currentTime = target;
          // Wrapping needs the media duration; remember the raw offset so the
          // loadedmetadata handler can apply it once the length is known.
          state.pendingOffset = audio.loop && !known ? offset : null;
        } catch {
          state.pendingOffset = audio.loop ? offset : null;
        }
      }
      if (!state.active || (jumped && audio.paused)) {
        state.active = true;
        const attempt = ++state.attempt;
        void audio.play().catch(error => {
          // A pause() issued while play() settles rejects with AbortError; that is an
          // expected interruption, not a playback failure, so it stays silent.
          const aborted = error instanceof Error && error.name === 'AbortError';
          if (!stopped && !aborted && state.active && attempt === state.attempt) {
            reportError(`Timeline sound: ${error instanceof Error ? error.message : String(error)}`);
          }
        });
      }
    }
    previousTime = time;
  }

  return {
    seek,
    stop() {
      if (stopped) return;
      stopped = true;
      for (const mixer of mixers.values()) {
        mixer.stopAllAction();
        mixer.uncacheRoot(mixer.getRoot());
      }
      mixers.clear();
      activeClips.clear();
      for (const state of sounds.values()) {
        state.active = false;
        state.audio.pause();
        try {
          state.audio.currentTime = 0;
        } catch {
          // The element may already be detached; pausing above is enough to release it.
        }
        state.audio.removeAttribute('src');
        state.audio.load();
      }
      sounds.clear();
      previousTime = undefined;
    }
  };
}
