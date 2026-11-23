// Snapshots of a model's state and the choice of how to place a model on a
// node.
//
// A snapshot is the state of a model after decoding some tokens, kept in RAM
// as an opaque blob. It is identified by those tokens (a prefix of a path),
// not by a node id: the model only ever sees tokens. Nothing here knows
// llama.cpp, so the real model and the fake one share it and it is tested
// without the GPU.
//
// Not thread-safe: each model owns one cache and uses it from one thread.
#pragma once

#include <cstddef>
#include <cstdint>
#include <list>
#include <vector>

namespace ils {

// A snapshot is taken whenever the context holds a multiple of this many
// tokens (and after the prompt minus its last token, pinned).
constexpr size_t SNAPSHOT_EVERY = 16;

// Whether a context holding `n_tokens` tokens is due a periodic snapshot.
inline bool snapshot_due(size_t n_tokens, size_t every = SNAPSHOT_EVERY) {
    return every > 0 && n_tokens > 0 && n_tokens % every == 0;
}

class SnapshotCache {
public:
    struct Entry {
        std::vector<int32_t> tokens;  // what the context held when it was taken
        std::vector<uint8_t> blob;
        bool pinned = false;  // never evicted (the prompt's)
        uint64_t used = 0;    // larger: used more recently (taken or restored)
    };

    // `limit_bytes` bounds the sum of the blobs; 0 is unlimited.
    explicit SnapshotCache(size_t limit_bytes = 0);

    void set_limit(size_t limit_bytes);
    size_t limit() const { return limit_; }

    void clear();

    // Stores a snapshot and then evicts the least recently used ones that
    // are not pinned until the total fits the limit. Returns false, storing
    // nothing, if `tokens` is empty or if the blob alone exceeds the limit
    // and it is not pinned. If there is already one for `tokens`, it is
    // replaced. A pinned snapshot is stored whatever its size.
    bool add(std::vector<int32_t> tokens, std::vector<uint8_t> blob, bool pinned = false);

    // Whether there is a snapshot for exactly the first `n` tokens of `path`.
    bool has(const std::vector<int32_t>& path, size_t n) const;

    // The snapshot with the most tokens among those that are a prefix of
    // `path` no longer than `max_len`, or null. The pointer is valid until
    // the next add, remove or clear.
    const Entry* best(const std::vector<int32_t>& path, size_t max_len) const;

    void touch(const Entry* e);   // marks it as just used
    void remove(const Entry* e);  // a snapshot that failed to restore

    size_t bytes() const { return bytes_; }  // sum of the blobs
    size_t count() const { return entries_.size(); }

private:
    void evict();

    std::list<Entry> entries_;
    size_t limit_ = 0;
    size_t bytes_ = 0;
    uint64_t clock_ = 0;
};

// How to make a context that holds `held` hold the tokens of `path` before
// its last one, so that the last one can be decoded.
struct Placement {
    enum Kind {
        Continue,  // the context is a prefix of the path: decode from `from`
        Trim,      // cut the context down to `from` tokens, then decode from `from`
        Restore,   // restore `snapshot` (`from` tokens), then decode from `from`
        Clear,     // empty the context and rebuild it in batches: approximate
    };
    Kind kind = Continue;
    size_t from = 0;  // tokens the context holds once placed
    const SnapshotCache::Entry* snapshot = nullptr;  // Restore only
};

// The cheapest exact way, in tokens left to decode one at a time:
//   - L is the length of the common prefix of `held` and `path`, capped at
//     path.size() - 1 (the last token is always decoded).
//   - From the context: Continue if it holds exactly L tokens, Trim if it
//     holds more and `can_trim`.
//   - Restore the deepest snapshot that is a prefix of the path no longer
//     than path.size() - 1, if it leaves fewer tokens to decode than the
//     context does (it has more than L tokens) or the context cannot be used.
//   - Clear when the context has extra tokens, cannot be trimmed and there
//     is no snapshot.
// `path` is never empty.
Placement plan_placement(const std::vector<int32_t>& held, const std::vector<int32_t>& path, bool can_trim,
                         const SnapshotCache& cache);

}  // namespace ils
