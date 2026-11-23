// The session log: the ordered list of every frame, in memory. It is the
// single source of truth: a browser that connects late gets all of it, and
// a recorded session is this log. The coordinator appends;
// the server reads from any thread.
#pragma once

#include "frames.h"

#include <cstdint>
#include <functional>
#include <mutex>
#include <vector>

namespace ils {

class Log {
public:
    // What a reader is missing. `epoch` and `next` are the reader's new position.
    struct Chunk {
        uint64_t epoch = 0;
        size_t next = 0;
        Bytes bytes;  // whole batches; empty when the reader is up to date
    };

    // Starts a new log with `batch` (which begins with HELLO). Bumps the epoch,
    // so every reader starts again from offset 0.
    void reset(const Bytes& batch);

    // Appends a batch: the frames of one step, which travel in one message.
    void append(const Bytes& batch);

    // Copies what a reader at (epoch, offset) has not seen yet. A reader from
    // another epoch gets the log from the start. Stops at the batch boundary
    // that keeps the chunk within `max_bytes`, but always returns at least one
    // whole batch when there is one.
    Chunk read(uint64_t epoch, size_t offset, size_t max_bytes) const;

    Bytes snapshot() const;  // the whole log
    uint64_t epoch() const;
    size_t size() const;

    // Called after every reset and append, with no lock held. Set once,
    // before other threads use the log.
    void set_listener(std::function<void()> listener) { listener_ = std::move(listener); }

private:
    mutable std::mutex mu_;
    Bytes bytes_;
    std::vector<size_t> batch_ends_;  // offset just past each batch, ascending
    uint64_t epoch_ = 0;
    std::function<void()> listener_;
};

}  // namespace ils
