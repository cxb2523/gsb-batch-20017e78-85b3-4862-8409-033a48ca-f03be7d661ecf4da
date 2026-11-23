// The tree of nodes. A node is a token with its parent;
// nodes are never removed or changed. Only the coordinator thread touches it.
#pragma once

#include "frames.h"

#include <cstdint>
#include <unordered_map>
#include <vector>

namespace ils {

struct Node {
    uint32_t id = 0;
    uint32_t parent = NONE;  // NONE for the first token
    int32_t token = 0;
    uint32_t depth = 0;      // position in the text, from 0
    uint8_t origin = ORIGIN_PROMPT;
};

class Tree {
public:
    void clear();
    size_t size() const { return nodes_.size(); }
    const Node& at(uint32_t id) const { return nodes_.at(id); }

    // The child of `parent` holding `token`, or NONE. `parent` may be NONE.
    uint32_t find_child(uint32_t parent, int32_t token) const;

    // Returns that child, creating it with `origin` if it does not exist.
    const Node& child_or_create(uint32_t parent, int32_t token, uint8_t origin, bool* created = nullptr);

    // Tokens from the root to `id`, both included.
    std::vector<int32_t> path_tokens(uint32_t id) const;

private:
    static uint64_t key(uint32_t parent, int32_t token) {
        return (static_cast<uint64_t>(parent) << 32) | static_cast<uint32_t>(token);
    }

    std::vector<Node> nodes_;
    std::unordered_map<uint64_t, uint32_t> children_;  // (parent, token) -> id
};

}  // namespace ils
