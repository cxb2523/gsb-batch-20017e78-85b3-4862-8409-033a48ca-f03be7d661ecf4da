// Snapshot cache and placement plan (snapshots.h).
#include "snapshots.h"

#include <algorithm>

namespace ils {
namespace {

// Whether `prefix` is a prefix of `path`.
bool is_prefix(const std::vector<int32_t>& prefix, const std::vector<int32_t>& path) {
    return prefix.size() <= path.size() && std::equal(prefix.begin(), prefix.end(), path.begin());
}

}  // namespace

SnapshotCache::SnapshotCache(size_t limit_bytes) : limit_(limit_bytes) {}

void SnapshotCache::set_limit(size_t limit_bytes) {
    limit_ = limit_bytes;
    evict();
}

void SnapshotCache::clear() {
    entries_.clear();
    bytes_ = 0;
}

bool SnapshotCache::add(std::vector<int32_t> tokens, std::vector<uint8_t> blob, bool pinned) {
    if (tokens.empty()) return false;
    if (!pinned && limit_ > 0 && blob.size() > limit_) return false;
    for (auto it = entries_.begin(); it != entries_.end(); ++it) {
        if (it->tokens == tokens) {
            bytes_ -= it->blob.size();
            entries_.erase(it);
            break;
        }
    }
    bytes_ += blob.size();
    entries_.push_back(Entry{std::move(tokens), std::move(blob), pinned, ++clock_});
    // The new one is the most recently used: it goes last, and only if the
    // pinned ones leave no room for it.
    evict();
    return true;
}

bool SnapshotCache::has(const std::vector<int32_t>& path, size_t n) const {
    if (n == 0 || n > path.size()) return false;
    for (const Entry& e : entries_)
        if (e.tokens.size() == n && std::equal(e.tokens.begin(), e.tokens.end(), path.begin())) return true;
    return false;
}

const SnapshotCache::Entry* SnapshotCache::best(const std::vector<int32_t>& path, size_t max_len) const {
    const Entry* found = nullptr;
    for (const Entry& e : entries_) {
        if (e.tokens.size() > max_len || !is_prefix(e.tokens, path)) continue;
        if (!found || e.tokens.size() > found->tokens.size()) found = &e;
    }
    return found;
}

void SnapshotCache::touch(const Entry* e) {
    for (Entry& x : entries_)
        if (&x == e) x.used = ++clock_;
}

void SnapshotCache::remove(const Entry* e) {
    for (auto it = entries_.begin(); it != entries_.end(); ++it) {
        if (&*it == e) {
            bytes_ -= it->blob.size();
            entries_.erase(it);
            return;
        }
    }
}

void SnapshotCache::evict() {
    while (limit_ > 0 && bytes_ > limit_) {
        auto lru = entries_.end();
        for (auto it = entries_.begin(); it != entries_.end(); ++it)
            if (!it->pinned && (lru == entries_.end() || it->used < lru->used)) lru = it;
        if (lru == entries_.end()) return;  // only pinned ones left
        bytes_ -= lru->blob.size();
        entries_.erase(lru);
    }
}

// For Clear, `from` is 0: the context is emptied and the tokens before the
// last one are then decoded in batches.
Placement plan_placement(const std::vector<int32_t>& held, const std::vector<int32_t>& path, bool can_trim,
                         const SnapshotCache& cache) {
    const size_t cap = path.empty() ? 0 : path.size() - 1;
    size_t common = 0;
    while (common < cap && common < held.size() && held[common] == path[common]) ++common;

    const bool exact_fit = held.size() == common;
    const bool usable = exact_fit || can_trim;
    const SnapshotCache::Entry* s = cache.best(path, cap);
    if (s && (s->tokens.size() > common || !usable)) return {Placement::Restore, s->tokens.size(), s};
    if (exact_fit) return {Placement::Continue, common, nullptr};
    if (can_trim) return {Placement::Trim, common, nullptr};
    return {Placement::Clear, 0, nullptr};
}

}  // namespace ils
