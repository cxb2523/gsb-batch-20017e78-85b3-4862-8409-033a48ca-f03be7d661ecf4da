// Snapshot cache, placement plan and the fake model placing itself with them.
#include "check.h"
#include "fake_model.h"
#include "snapshots.h"

#include <algorithm>
#include <numeric>

using namespace ils;

namespace {

using Tokens = std::vector<int32_t>;

Tokens range(int32_t first, size_t n) {
    Tokens t(n);
    std::iota(t.begin(), t.end(), first);
    return t;
}

std::vector<uint8_t> blob(size_t n) { return std::vector<uint8_t>(n, 7); }

int32_t argmax(const std::vector<float>& v) {
    return static_cast<int32_t>(std::max_element(v.begin(), v.end()) - v.begin());
}

void test_best() {
    SnapshotCache c;
    CHECK(c.best({1, 2, 3}, 2) == nullptr);
    CHECK(c.add({1, 2}, blob(10)));
    CHECK(c.add({1, 2, 3, 4}, blob(10)));
    CHECK(c.add({1, 2, 3, 4, 5, 6}, blob(10)));
    CHECK(c.add({1, 9, 9}, blob(10)));
    CHECK(!c.add({}, blob(10)));  // no tokens: nothing to identify it
    CHECK_EQ(c.count(), 4u);

    const Tokens path{1, 2, 3, 4, 5};
    const SnapshotCache::Entry* e = c.best(path, 4);
    CHECK(e && e->tokens == (Tokens{1, 2, 3, 4}));  // deepest ancestor; the longer one is not a prefix
    e = c.best(path, 3);
    CHECK(e && e->tokens == (Tokens{1, 2}));  // never longer than max_len
    e = c.best({1, 9, 9, 1}, 3);
    CHECK(e && e->tokens == (Tokens{1, 9, 9}));
    CHECK(c.best({7, 1, 2}, 2) == nullptr);  // not a prefix
    CHECK(c.best(path, 1) == nullptr);

    CHECK(c.has(path, 2));
    CHECK(c.has(path, 4));
    CHECK(!c.has(path, 3));
    CHECK(!c.has(path, 0));
    CHECK(!c.has({1, 2}, 4));
}

void test_plan() {
    SnapshotCache none;
    Placement p = plan_placement({1, 2}, {1, 2, 3}, false, none);
    CHECK_EQ(p.kind, Placement::Continue);
    CHECK_EQ(p.from, 2u);
    p = plan_placement({1}, {1, 2, 3}, false, none);
    CHECK_EQ(p.kind, Placement::Continue);
    CHECK_EQ(p.from, 1u);
    p = plan_placement({}, {5}, false, none);
    CHECK_EQ(p.kind, Placement::Continue);
    CHECK_EQ(p.from, 0u);

    p = plan_placement({1, 2, 3, 4}, {1, 2, 5}, true, none);
    CHECK_EQ(p.kind, Placement::Trim);
    CHECK_EQ(p.from, 2u);
    p = plan_placement({1, 2, 3, 4}, {1, 2, 5}, false, none);
    CHECK_EQ(p.kind, Placement::Clear);
    CHECK(p.snapshot == nullptr);

    // Going back to the node itself: its token is decoded again.
    p = plan_placement({1, 2, 3}, {1, 2, 3}, true, none);
    CHECK_EQ(p.kind, Placement::Trim);
    CHECK_EQ(p.from, 2u);

    // The node's own snapshot is no use, its parent's is.
    SnapshotCache c;
    c.add({1, 2, 3}, blob(10));
    c.add({1, 2}, blob(10));
    p = plan_placement({1, 2, 3}, {1, 2, 3}, false, c);
    CHECK_EQ(p.kind, Placement::Restore);
    CHECK_EQ(p.from, 2u);
    CHECK(p.snapshot && p.snapshot->tokens == (Tokens{1, 2}));

    // Restore when it saves tokens, even if the context could continue.
    const Tokens path = range(100, 30);
    SnapshotCache c24;
    c24.add(range(100, 24), blob(10));
    p = plan_placement({100}, path, false, c24);
    CHECK_EQ(p.kind, Placement::Restore);
    CHECK_EQ(p.from, 24u);
    // ...but not when the context is ahead of the snapshot.
    p = plan_placement(range(100, 26), path, false, c24);
    CHECK_EQ(p.kind, Placement::Continue);
    CHECK_EQ(p.from, 26u);
    // Trimming keeps more than the snapshot has.
    Tokens off = range(100, 27);
    off.push_back(1);
    p = plan_placement(off, path, true, c24);
    CHECK_EQ(p.kind, Placement::Trim);
    CHECK_EQ(p.from, 27u);
    // The context cannot be trimmed: an older snapshot is better than Clear.
    p = plan_placement(off, path, false, c24);
    CHECK_EQ(p.kind, Placement::Restore);
    CHECK_EQ(p.from, 24u);
}

void test_eviction() {
    SnapshotCache c(300);
    CHECK_EQ(c.limit(), 300u);
    CHECK(c.add({1}, blob(100)));
    CHECK(c.add({2}, blob(100)));
    CHECK(c.add({3}, blob(100)));
    CHECK_EQ(c.bytes(), 300u);
    CHECK(c.add({4}, blob(100)));  // evicts {1}, the least recently used
    CHECK_EQ(c.bytes(), 300u);
    CHECK(!c.has({1}, 1));
    CHECK(c.has({2}, 1));

    c.touch(c.best({2}, 1));       // {3} is now the oldest
    CHECK(c.add({5}, blob(100)));
    CHECK(c.has({2}, 1));
    CHECK(!c.has({3}, 1));
    CHECK(c.has({4}, 1));
    CHECK(c.has({5}, 1));

    CHECK(!c.add({6}, blob(301)));  // larger than the limit: not stored
    CHECK(!c.has({6}, 1));
    CHECK_EQ(c.count(), 3u);

    CHECK(c.add({4}, blob(50)));  // replaces
    CHECK_EQ(c.count(), 3u);
    CHECK_EQ(c.bytes(), 250u);

    c.remove(c.best({4}, 1));
    CHECK(!c.has({4}, 1));
    CHECK_EQ(c.bytes(), 200u);

    // Pinned: stored whatever its size, never evicted.
    c.clear();
    CHECK_EQ(c.count(), 0u);
    CHECK_EQ(c.bytes(), 0u);
    CHECK(c.add({9}, blob(400), true));
    CHECK(c.has({9}, 1));
    CHECK(c.add({9, 1}, blob(100)));  // no room beside the pinned one
    CHECK(!c.has({9, 1}, 2));
    CHECK(c.has({9}, 1));
    CHECK_EQ(c.bytes(), 400u);

    c.set_limit(1000);
    for (int32_t i = 0; i < 50; ++i) {
        CHECK(c.add({9, 2, i}, blob(70 + 13 * static_cast<size_t>(i % 5))));
        CHECK(c.bytes() <= 1000u);
        CHECK(c.has({9}, 1));
    }
    c.set_limit(500);  // shrinking evicts too
    CHECK(c.bytes() <= 500u);
    CHECK(c.has({9}, 1));

    SnapshotCache unlimited;  // 0: no limit
    for (int32_t i = 0; i < 20; ++i) CHECK(unlimited.add({i + 1}, blob(1000)));
    CHECK_EQ(unlimited.count(), 20u);
}

// The fake model generates `n` tokens after the prompt, one eval per token,
// and returns the whole path.
Tokens generate(FakeModel& m, const Tokens& prompt, size_t n) {
    Tokens path = prompt;
    EvalOutput out;
    for (size_t i = 0; i < n; ++i) {
        m.eval(path, out);
        CHECK(!out.approximate);
        path.push_back(argmax(out.logits));
    }
    return path;
}

void test_fake_model() {
    FakeOptions o;
    o.can_trim = false;
    FakeModel m(o);
    const Tokens prompt = m.tokenize_prompt("Hello there", false, "");
    CHECK(prompt.size() >= 2);
    m.prefill(Tokens(prompt.begin(), prompt.end() - 1));
    CHECK_EQ(m.snapshots().count(), 1u);  // the prompt's, pinned

    const Tokens line = generate(m, prompt, 100);
    CHECK_EQ(m.restores, 0);
    CHECK(m.snapshots().count() >= 1 + line.size() / SNAPSHOT_EVERY - 1);

    // Back to earlier nodes, deepest first: every one restores a snapshot
    // and decodes at most SNAPSHOT_EVERY tokens one at a time.
    EvalOutput out, again;
    for (size_t len = line.size() - 3; len > prompt.size(); len -= 7) {
        const Tokens path(line.begin(), line.begin() + len);
        const int restores = m.restores;
        const int singles = m.single_decodes;
        m.eval(path, out);
        CHECK_EQ(m.restores, restores + 1);
        CHECK(!out.approximate);
        CHECK(m.single_decodes - singles >= 1);
        CHECK(m.single_decodes - singles <= static_cast<int>(SNAPSHOT_EVERY));
        CHECK_EQ(argmax(out.logits), line[len]);
    }
    // To the first generated node: from the prompt's snapshot.
    {
        const int singles = m.single_decodes;
        m.eval(prompt, out);
        CHECK(!out.approximate);
        CHECK_EQ(m.single_decodes - singles, 1);
    }

    // 20 branches from different depths, with room for few snapshots.
    FakeOptions small = o;
    small.snapshot_limit = 3 * small.snapshot_blob_bytes;
    FakeModel b(small);
    b.prefill(Tokens(prompt.begin(), prompt.end() - 1));
    const size_t pinned = b.snapshots().bytes();
    CHECK(pinned > 0);
    const Tokens main_line = generate(b, prompt, 100);
    CHECK(b.snapshots().bytes() <= small.snapshot_limit + pinned);
    for (size_t i = 0; i < 20; ++i) {
        const size_t depth = prompt.size() + 1 + i * 5;  // branch after this many tokens
        Tokens path(main_line.begin(), main_line.begin() + depth);
        const int32_t first_word = FakeModel::BYTE0 + 256;
        path.push_back(main_line[depth] == first_word ? first_word + 1 : first_word);
        for (size_t k = 0; k < 30; ++k) {
            b.eval(path, out);
            CHECK(!out.approximate);  // the pinned one is always there
            CHECK(b.snapshots().bytes() <= small.snapshot_limit + pinned);
            path.push_back(argmax(out.logits));
        }
    }
    CHECK(b.restores >= 20);

    // Without snapshots a model that cannot trim rebuilds: approximate.
    FakeOptions off = o;
    off.snapshot_every = 0;
    FakeModel c(off);
    c.prefill(Tokens(prompt.begin(), prompt.end() - 1));
    CHECK_EQ(c.snapshots().count(), 0u);
    const Tokens l2 = generate(c, prompt, 10);
    c.eval(Tokens(l2.begin(), l2.begin() + prompt.size() + 2), out);
    CHECK(out.approximate);
    CHECK_EQ(c.restores, 0);
    CHECK_EQ(c.snapshots().count(), 0u);

    // A model that can trim does so, without restoring.
    FakeModel t;
    t.prefill(Tokens(prompt.begin(), prompt.end() - 1));
    const Tokens l3 = generate(t, prompt, 60);
    const int singles = t.single_decodes;
    t.eval(Tokens(l3.begin(), l3.begin() + prompt.size() + 40), out);
    CHECK(!out.approximate);
    CHECK_EQ(t.restores, 0);
    CHECK_EQ(t.single_decodes - singles, 1);
    t.eval(Tokens(l3.begin(), l3.begin() + prompt.size() + 40), again);
    CHECK(out.logits == again.logits);
}

}  // namespace

int main() {
    test_best();
    test_plan();
    test_eviction();
    test_fake_model();
    return test_result();
}
