#include "tree.h"

#include <algorithm>

namespace ils {

void Tree::clear() {
    nodes_.clear();
    children_.clear();
}

uint32_t Tree::find_child(uint32_t parent, int32_t token) const {
    const auto it = children_.find(key(parent, token));
    return it == children_.end() ? NONE : it->second;
}

const Node& Tree::child_or_create(uint32_t parent, int32_t token, uint8_t origin, bool* created) {
    const uint32_t existing = find_child(parent, token);
    if (created) *created = existing == NONE;
    if (existing != NONE) return nodes_[existing];

    Node n;
    n.id = static_cast<uint32_t>(nodes_.size());
    n.parent = parent;
    n.token = token;
    n.depth = parent == NONE ? 0 : nodes_.at(parent).depth + 1;
    n.origin = origin;
    nodes_.push_back(n);
    children_.emplace(key(parent, token), n.id);
    return nodes_.back();
}

std::vector<int32_t> Tree::path_tokens(uint32_t id) const {
    std::vector<int32_t> path;
    if (id == NONE) return path;
    path.reserve(nodes_.at(id).depth + 1);
    for (uint32_t n = id; n != NONE; n = nodes_[n].parent) path.push_back(nodes_[n].token);
    std::reverse(path.begin(), path.end());
    return path;
}

}  // namespace ils
