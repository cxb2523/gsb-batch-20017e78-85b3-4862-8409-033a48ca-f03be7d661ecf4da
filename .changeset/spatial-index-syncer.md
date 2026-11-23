---
"@canvas-tile-engine/core": minor
---

Add `SpatialIndexSyncer`, which keeps a `SpatialIndex` mirrored against a live `ItemCollection`. It bulk-loads the collection in order once and subscribes, then applies inserts as appended index entries, updates as in-place bounding-box replacements that keep registration order, and removals as single-entry deletions, so viewport queries always reflect the collection's current order without stale or repeated items. Batched mutations sync within one subscription callback; `getSyncCount()` observes delivered callbacks and `dispose()` releases the subscription once. The collection object is the registration key, so repeat registrations share one syncer and subscription, while ordinary arrays keep the existing full-rebuild path.
