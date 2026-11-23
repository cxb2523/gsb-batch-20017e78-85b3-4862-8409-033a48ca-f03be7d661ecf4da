# Player audio/subtitle lifecycle tests

Run with:

```bash
npm test        # node --test through tsx (no real TTS or browser needed)
npm run lint    # tsc --noEmit
```

| File | What it covers |
| :--- | :--- |
| `audioEngine.test.ts` | Engine session model: ducking is a pure function of "narration active"; stale `onend`/`onerror`/fallback-timer callbacks from a superseded utterance are ignored; custom audio shares the same session semantics; music start is idempotent and stops cleanly. Runs under Node with fake `speechSynthesis` / `AudioContext`. |
| `playbackController.test.ts` | Timeline + narration ownership: one narration per play, no stacking on pause/resume, rapid scene switching ignores stale callbacks, seek/scrub/cue-jump rebase the subtitle index, mute/music/settings coordination. |
| `videoPlayer.dom.test.ts` | The real `<VideoPlayer />` rendered in jsdom and driven through its actual buttons/scrubber, asserting the same invariants end-to-end (including that stale utterance boundaries cannot move the next scene's highlight). |

All speech is simulated; none of these tests depend on real Web Speech synthesis.
| `standaloneSyntax.test.ts` | The exported offline player embeds its own script; this asserts that script still parses and keeps the narration-epoch/seek guards. |
