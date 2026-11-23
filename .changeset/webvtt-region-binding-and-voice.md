---
"@react-av/vtt-core": patch
---

Collect `REGION` blocks written in the file header and keep cue-to-region bindings correct. A `region:` reference now resolves to the last region with a matching id, a cue that explicitly sets `line`, `size` or `vertical` drops out of its region regardless of the order the settings are written in, and an unrelated later setting no longer clears a parsed `line` or `position`. Cue text `<v>` (voice) tags now attach to the cue text tree so `getCueAsHTML` renders them with their annotation as the `title`, including when nested.
