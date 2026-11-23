// The hub: owns the models and the session, and answers the model commands
// of the wire protocol: models, load, download,
// cancel_download and delete. Every other command goes to the session, if
// there is one. Built around injected functions (HubBackend), so tests and
// the fake engine run it without llama.cpp, without the GPU and offline.
//
// Threads: command() is called from the server's connection threads. A load
// runs on a thread of the hub's own, one at a time; downloads run one at a
// time on another, in queue order. The session has its own thread (session.h).
#pragma once

#include "catalog.h"
#include "hf.h"
#include "log.h"
#include "model.h"
#include "session.h"

#include <chrono>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace ils {

struct HubBackend {
    // Loads a model. `path` is a full path; `slot` 0 is A and 1 is B;
    // `n_models` is how many this load has (1 or 2). Throws
    // std::runtime_error with a message for the user.
    std::function<std::unique_ptr<Model>(const std::string& path, int slot, int n_models)> load_model;
    // The transfer of a download; empty: the engine cannot download.
    DownloadFn download;
    // Memory of the dedicated GPUs now (model.h); empty: no GPU (all zero).
    std::function<GpuMemory()> gpu_memory;
};

class Hub {
public:
    struct Sinks {
        // A JSON event for every connection (server.push_event).
        std::function<void(const std::string& json)> event;
        // The status changed (server.notify_status).
        std::function<void()> status_changed;
    };

    // Nothing is loaded until load_paths() or a `load` command.
    Hub(Log& log, Catalog& catalog, HubBackend backend, Sinks sinks, SessionOptions session_options = {});
    ~Hub();  // stops the load and download threads and the session, then frees the models

    Hub(const Hub&) = delete;
    Hub& operator=(const Hub&) = delete;

    // Loads A (and B, if not empty) from full paths, anywhere on disk, and
    // starts a session: for -a and -b. Blocking. With B and a different
    // tokenizer, B is freed and the session goes on with A and a warning in
    // HELLO, as `load` does. Throws std::runtime_error if A or B cannot be
    // loaded, leaving nothing loaded.
    void load_paths(const std::string& a, const std::string& b);

    // A command from a browser (JSON text). Any thread. Model commands are
    // answered with events; any other goes to the session, or gets an
    // `error` event ("no model loaded", "models are loading").
    void command(const std::string& json);

    // The session's status; without a session, Idle with the default speed limit.
    Status status() const;

    // What a browser that has just connected needs besides the log and the
    // status: the current `models` event.
    std::vector<std::string> connect_events() const;

    // The session's; all zero without one. Accumulated over every session.
    SeekStats seek_stats() const;

    // Blocks until no load is running and the download queue is empty, or
    // until the timeout. For tests. Returns false on timeout.
    bool wait_idle(std::chrono::milliseconds timeout);

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}  // namespace ils
