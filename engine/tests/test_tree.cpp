// Tree operations: creating children, reusing them and walking a path.
#include "check.h"
#include "tree.h"

using namespace ils;

int main() {
    Tree t;
    CHECK_EQ(t.size(), 0u);
    CHECK_EQ(t.find_child(NONE, 5), NONE);
    CHECK(t.path_tokens(NONE).empty());

    bool created = false;
    const uint32_t root = t.child_or_create(NONE, 5, ORIGIN_PROMPT, &created).id;
    CHECK(created);
    CHECK_EQ(root, 0u);
    CHECK_EQ(t.at(root).parent, NONE);
    CHECK_EQ(t.at(root).depth, 0u);
    CHECK_EQ(t.at(root).origin, ORIGIN_PROMPT);

    const uint32_t a = t.child_or_create(root, 7, ORIGIN_PROMPT, &created).id;
    CHECK(created);
    const uint32_t b = t.child_or_create(a, 9, ORIGIN_MODEL, &created).id;
    CHECK(created);
    CHECK_EQ(a, 1u);  // identifiers grow by one from 0
    CHECK_EQ(b, 2u);
    CHECK_EQ(t.at(b).parent, a);
    CHECK_EQ(t.at(b).depth, 2u);
    CHECK_EQ(t.at(b).token, 9);
    CHECK_EQ(t.at(b).origin, ORIGIN_MODEL);

    // An existing child is reused and keeps its origin.
    const uint32_t again = t.child_or_create(a, 9, ORIGIN_USER, &created).id;
    CHECK(!created);
    CHECK_EQ(again, b);
    CHECK_EQ(t.at(b).origin, ORIGIN_MODEL);
    CHECK_EQ(t.size(), 3u);

    // A sibling is a branch: same parent, another token.
    const uint32_t c = t.child_or_create(a, 10, ORIGIN_USER, &created).id;
    CHECK(created);
    CHECK_EQ(c, 3u);
    CHECK_EQ(t.at(c).depth, 2u);
    CHECK_EQ(t.find_child(a, 9), b);
    CHECK_EQ(t.find_child(a, 10), c);
    CHECK_EQ(t.find_child(a, 11), NONE);
    CHECK_EQ(t.find_child(b, 10), NONE);

    const std::vector<int32_t> pb = t.path_tokens(b);
    CHECK((pb == std::vector<int32_t>{5, 7, 9}));
    const std::vector<int32_t> pc = t.path_tokens(c);
    CHECK((pc == std::vector<int32_t>{5, 7, 10}));
    CHECK((t.path_tokens(root) == std::vector<int32_t>{5}));

    t.clear();
    CHECK_EQ(t.size(), 0u);
    CHECK_EQ(t.find_child(NONE, 5), NONE);

    return test_result();
}
