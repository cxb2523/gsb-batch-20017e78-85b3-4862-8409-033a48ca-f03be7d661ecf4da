#include "log.h"

#include <algorithm>

namespace ils {

void Log::reset(const Bytes& batch) {
    {
        std::lock_guard<std::mutex> lk(mu_);
        ++epoch_;
        bytes_ = batch;
        batch_ends_.clear();
        if (!batch.empty()) batch_ends_.push_back(bytes_.size());
    }
    if (listener_) listener_();
}

void Log::append(const Bytes& batch) {
    if (batch.empty()) return;
    {
        std::lock_guard<std::mutex> lk(mu_);
        bytes_.insert(bytes_.end(), batch.begin(), batch.end());
        batch_ends_.push_back(bytes_.size());
    }
    if (listener_) listener_();
}

Log::Chunk Log::read(uint64_t epoch, size_t offset, size_t max_bytes) const {
    std::lock_guard<std::mutex> lk(mu_);
    Chunk c;
    c.epoch = epoch_;
    if (epoch != epoch_ || offset > bytes_.size()) offset = 0;
    c.next = offset;
    if (offset >= bytes_.size()) return c;

    // First boundary past the offset, then as many more as fit.
    auto it = std::upper_bound(batch_ends_.begin(), batch_ends_.end(), offset);
    size_t end = *it;
    for (++it; it != batch_ends_.end() && *it - offset <= max_bytes; ++it) end = *it;

    c.bytes.assign(bytes_.begin() + static_cast<std::ptrdiff_t>(offset),
                   bytes_.begin() + static_cast<std::ptrdiff_t>(end));
    c.next = end;
    return c;
}

Bytes Log::snapshot() const {
    std::lock_guard<std::mutex> lk(mu_);
    return bytes_;
}

uint64_t Log::epoch() const {
    std::lock_guard<std::mutex> lk(mu_);
    return epoch_;
}

size_t Log::size() const {
    std::lock_guard<std::mutex> lk(mu_);
    return bytes_.size();
}

}  // namespace ils
