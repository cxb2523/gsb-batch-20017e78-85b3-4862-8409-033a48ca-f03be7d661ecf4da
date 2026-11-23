#include "hub.h"

#include <nlohmann/json.hpp>

#include <atomic>
#include <condition_variable>
#include <cstdio>
#include <deque>
#include <exception>
#include <filesystem>
#include <mutex>
#include <optional>
#include <shared_mutex>
#include <stdexcept>
#include <system_error>
#include <thread>
#include <utility>

namespace ils {

namespace {

namespace fs = std::filesystem;
using json = nlohmann::ordered_json;

constexpr auto kProgressEvery = std::chrono::milliseconds(250);  // at most 4 progress events per second

std::string dump(const json& j) { return j.dump(-1, ' ', false, json::error_handler_t::replace); }

std::string error_event(const std::string& cmd, const std::string& msg) {
    json j;
    j["ev"] = "error";
    if (!cmd.empty()) j["cmd"] = cmd;
    j["msg"] = msg;
    return dump(j);
}

json name_or_null(const std::string& s) { return s.empty() ? json(nullptr) : json(s); }

std::string file_name_of(const std::string& path) { return fs::path(path).filename().string(); }

// Same file on disk; falls back to comparing the text when either is missing.
bool same_file(const std::string& a, const std::string& b) {
    if (a.empty() || b.empty()) return false;
    std::error_code ec;
    const bool eq = fs::equivalent(a, b, ec);
    return ec ? fs::path(a).lexically_normal() == fs::path(b).lexically_normal() : eq;
}

// A command failure with a message for the user.
struct CommandError : std::runtime_error {
    using std::runtime_error::runtime_error;
};

}  // namespace

struct Hub::Impl {
    Log& log;
    Catalog& catalog;
    HubBackend backend;
    Sinks sinks;
    SessionOptions session_options;

    // The session pointer: shared to use it, exclusive to swap it. A swap
    // only moves the pointer; the old session is destroyed outside the lock.
    mutable std::shared_mutex session_mu;
    std::unique_ptr<Session> session;

    // Models: only the load (load thread, load_paths) and the destructor
    // touch them, never two at a time (load_busy).
    std::unique_ptr<Model> models[2];

    // State, under `mu`.
    mutable std::mutex mu;
    std::condition_variable cv;  // wakes the workers and wait_idle
    bool stopping = false;
    bool load_busy = false;       // a load is pending or running
    bool load_finishing = false;  // a load has ended and its events are on their way (wait_idle)
    bool loading = false;    // what the `models` event says
    std::optional<std::pair<std::string, std::string>> pending_load;  // full paths of A and B
    std::string target[2];   // full paths of the load in progress
    std::string paths[2];    // full paths of the loaded models
    uint64_t vram[2] = {0, 0};
    SeekStats seek_done;     // of the sessions already closed

    struct Download {
        DownloadRequest req;
        std::string file;
        bool running = false;
        uint64_t done = 0, total = 0;
    };
    std::deque<Download> downloads;  // the running one first
    bool dl_busy = false;            // the worker holds the front, events included
    std::atomic<bool> dl_cancel{false};

    std::string last_models;  // the last `models` event
    std::mutex models_emit_mu;  // serializes building and sending `models` events; the server never takes it

    std::thread load_thread;
    std::thread dl_thread;

    Impl(Log& l, Catalog& c, HubBackend b, Sinks s, SessionOptions so)
        : log(l), catalog(c), backend(std::move(b)), sinks(std::move(s)), session_options(so) {}

    void emit(const std::string& ev) {
        if (sinks.event) sinks.event(ev);
    }
    void status_changed() {
        if (sinks.status_changed) sinks.status_changed();
    }

    // ----------------------------------------------------------- `models`

    json download_json(const Download& d, const char* state) const {
        json j;
        j["repo"] = d.req.repo;
        j["path"] = d.req.path;
        j["file"] = d.file;
        j["state"] = state;
        j["done"] = d.done;
        j["total"] = d.total;
        return j;
    }

    // Rescans the folder and sends the `models` event. Call with no lock held.
    void emit_models() {
        std::lock_guard<std::mutex> emit_lk(models_emit_mu);
        const std::vector<CatalogEntry> files = catalog.scan();
        const GpuMemory gpu = backend.gpu_memory ? backend.gpu_memory() : GpuMemory{};

        json j;
        j["ev"] = "models";
        j["dir"] = catalog.dir().generic_string();
        json fl = json::array();
        for (const CatalogEntry& e : files) {
            json f;
            f["file"] = e.file;
            f["size"] = e.size;
            f["name"] = e.name;
            f["arch"] = e.arch;
            f["size_label"] = e.size_label;
            f["quant"] = e.quant;
            f["n_layer"] = e.n_layer;
            f["n_vocab"] = e.n_vocab;
            f["tok"] = e.tok;
            f["vram"] = e.vram;
            f["error"] = e.error;
            fl.push_back(std::move(f));
        }
        j["files"] = std::move(fl);

        std::string text;
        {
            std::lock_guard<std::mutex> lk(mu);
            json loaded;
            loaded["a"] = name_or_null(paths[0].empty() ? "" : file_name_of(paths[0]));
            loaded["b"] = name_or_null(paths[1].empty() ? "" : file_name_of(paths[1]));
            j["loaded"] = std::move(loaded);
            j["loading"] = loading;
            j["n_ctx"] = catalog.n_ctx();
            json g;
            g["total"] = gpu.total;
            g["available"] = gpu.total == 0 ? 0 : gpu.free + vram[0] + vram[1];
            j["gpu"] = std::move(g);
            j["download"] = static_cast<bool>(backend.download);
            json dl = json::array();
            for (const Download& d : downloads) dl.push_back(download_json(d, d.running ? "running" : "queued"));
            j["downloads"] = std::move(dl);
            text = dump(j);
            last_models = text;
        }
        emit(text);
    }

    // ------------------------------------------------------------- loads

    void load_event(const char* state, const std::string& a, const std::string& b, const std::string& msg = {}) {
        json j;
        j["ev"] = "load";
        j["state"] = state;
        j["a"] = name_or_null(a.empty() ? "" : file_name_of(a));
        j["b"] = name_or_null(b.empty() ? "" : file_name_of(b));
        if (!msg.empty()) j["msg"] = msg;
        emit(dump(j));
    }

    void free_model(int i) {
        models[i].reset();
        std::lock_guard<std::mutex> lk(mu);
        paths[i].clear();
        vram[i] = 0;
    }

    // Closes the session, if any, and keeps its seek counts.
    void close_session() {
        std::unique_ptr<Session> old;
        {
            std::unique_lock<std::shared_mutex> lk(session_mu);
            old = std::move(session);
        }
        if (!old) return;
        const SeekStats st = old->seek_stats();
        old.reset();  // stops its thread; the log keeps its frames until the next HELLO
        {
            std::lock_guard<std::mutex> lk(mu);
            seek_done.verified += st.verified;
            seek_done.mismatches += st.mismatches;
        }
        status_changed();
    }

    // The load sequence: close the session, free the models that do not stay
    // (before loading, so the VRAM never holds both sets), load the new ones,
    // check the tokenizer and start a new session. load_busy is set
    // by the caller; this clears it. Throws std::runtime_error on failure,
    // with nothing loaded.
    void do_load(const std::string& a, const std::string& b) {
        const int n_new = b.empty() ? 1 : 2;
        {
            std::lock_guard<std::mutex> lk(mu);
            loading = true;
            target[0] = a;
            target[1] = b;
        }
        load_event("loading", a, b);
        emit_models();

        std::string error;
        std::string a_name, b_name;
        try {
            close_session();

            // Free what does not stay, B first, before loading anything.
            const int n_old = models[1] ? 2 : (models[0] ? 1 : 0);
            const std::string want[2] = {a, b};
            bool keep[2];
            for (int i = 0; i < 2; ++i) {
                std::string have;
                {
                    std::lock_guard<std::mutex> lk(mu);
                    have = paths[i];
                }
                keep[i] = models[i] && i < n_new && n_old == n_new && have == want[i];
            }
            for (int i = 1; i >= 0; --i) {
                if (models[i] && !keep[i]) free_model(i);
            }

            for (int i = 0; i < n_new; ++i) {
                if (keep[i]) continue;
                std::unique_ptr<Model> m = backend.load_model(want[i], i, n_new);
                if (!m) throw std::runtime_error("cannot load " + file_name_of(want[i]));
                const uint64_t est = read_gguf_header(want[i], catalog.n_ctx()).vram;
                models[i] = std::move(m);
                std::lock_guard<std::mutex> lk(mu);
                paths[i] = want[i];
                vram[i] = est;
            }

            std::vector<std::string> warnings;
            if (models[1]) {
                if (const auto diff = tokenizer_difference(*models[0], *models[1])) {
                    free_model(1);  // gives its memory back
                    warnings.push_back("model B was not loaded: its tokenizer differs from A's (" + *diff + ")");
                    std::fprintf(stderr, "warning: %s\n", warnings.back().c_str());
                }
            }

            auto s = std::make_unique<Session>(
                *models[0], models[1].get(), log,
                Session::Sinks{[this](const std::string& ev) { emit(ev); }, [this] { status_changed(); }},
                std::move(warnings), session_options);
            {
                std::unique_lock<std::shared_mutex> lk(session_mu);
                session = std::move(s);
            }
            std::lock_guard<std::mutex> lk(mu);
            a_name = paths[0];
            b_name = paths[1];
        } catch (const std::exception& e) {
            error = e.what();
            if (error.empty()) error = "the load failed";
        }

        if (!error.empty()) {
            close_session();  // in case the session was the part that failed
            free_model(1);
            free_model(0);
            std::fprintf(stderr, "inside-llm: load failed: %s\n", error.c_str());
        }
        {
            // Commands are taken from here on: a browser may send `start` as
            // soon as it sees the events below.
            std::lock_guard<std::mutex> lk(mu);
            loading = false;
            load_busy = false;
            load_finishing = true;
            target[0].clear();
            target[1].clear();
        }
        if (error.empty()) {
            load_event("ready", a_name, b_name);
        } else {
            load_event("error", a, b, error);
        }
        emit_models();
        status_changed();
        {
            std::lock_guard<std::mutex> lk(mu);
            load_finishing = false;
        }
        cv.notify_all();
        if (!error.empty()) throw std::runtime_error(error);
    }

    void load_loop() {
        for (;;) {
            std::pair<std::string, std::string> job;
            {
                std::unique_lock<std::mutex> lk(mu);
                cv.wait(lk, [&] { return stopping || pending_load.has_value(); });
                if (stopping) return;
                job = std::move(*pending_load);
                pending_load.reset();
            }
            try {
                do_load(job.first, job.second);
            } catch (const std::exception&) {
                // already reported with a `load` event
            }
        }
    }

    // --------------------------------------------------------- downloads

    void download_event(const Download& d, const char* state, const std::string& msg = {}) {
        json j;
        j["ev"] = "download";
        j["repo"] = d.req.repo;
        j["path"] = d.req.path;
        j["file"] = d.file;
        j["state"] = state;
        j["done"] = d.done;
        j["total"] = d.total;
        if (!msg.empty()) j["msg"] = msg;
        emit(dump(j));
    }

    void download_loop() {
        for (;;) {
            Download d;
            {
                std::unique_lock<std::mutex> lk(mu);
                cv.wait(lk, [&] { return stopping || !downloads.empty(); });
                if (stopping) return;
                downloads.front().running = true;
                dl_busy = true;
                dl_cancel = false;
                d = downloads.front();
            }
            download_event(d, "running");
            emit_models();

            const fs::path dest = catalog.dir() / d.file;
            auto last = std::chrono::steady_clock::now() - kProgressEvery;
            auto progress = [&](const DownloadProgress& p) {
                d.done = p.done;
                d.total = p.total;
                {
                    std::lock_guard<std::mutex> lk(mu);
                    if (!downloads.empty() && downloads.front().running) {
                        downloads.front().done = p.done;
                        downloads.front().total = p.total;
                    }
                }
                const auto now = std::chrono::steady_clock::now();
                if (now - last < kProgressEvery) return;
                last = now;
                download_event(d, "running");
            };

            const char* state = "done";
            std::string msg;
            try {
                backend.download(d.req, dest, progress, dl_cancel);
            } catch (const DownloadCancelled&) {
                state = "cancelled";
            } catch (const std::exception& e) {
                state = "error";
                msg = e.what();
                std::fprintf(stderr, "inside-llm: download of %s failed: %s\n", d.file.c_str(), msg.c_str());
            }
            {
                std::lock_guard<std::mutex> lk(mu);
                downloads.pop_front();
            }
            download_event(d, state, msg);
            emit_models();  // rescans: a finished download is in `files` now
            {
                std::lock_guard<std::mutex> lk(mu);
                dl_busy = false;
            }
            cv.notify_all();
        }
    }

    // ---------------------------------------------------------- commands

    std::string resolve(const json& j, const char* field, bool required) const {
        const auto it = j.find(field);
        if (it == j.end() || it->is_null()) {
            if (required) throw CommandError(std::string("missing \"") + field + "\"");
            return {};
        }
        if (!it->is_string()) throw CommandError(std::string("\"") + field + "\" must be a file name");
        const std::string name = it->get<std::string>();
        if (name.empty() && !required) return {};
        const auto p = catalog.resolve(name);
        if (!p) throw CommandError("unknown model file: " + name);
        return p->string();
    }

    void cmd_load(const json& j) {
        const std::string a = resolve(j, "a", true);
        const std::string b = resolve(j, "b", false);
        {
            std::lock_guard<std::mutex> lk(mu);
            if (load_busy) throw CommandError("a load is already running");
            load_busy = true;
            pending_load = std::make_pair(a, b);
        }
        cv.notify_all();
    }

    static DownloadRequest request_of(const json& j) {
        DownloadRequest r;
        const auto repo = j.find("repo");
        const auto path = j.find("path");
        if (repo == j.end() || !repo->is_string()) throw CommandError("missing \"repo\"");
        if (path == j.end() || !path->is_string()) throw CommandError("missing \"path\"");
        r.repo = repo->get<std::string>();
        r.path = path->get<std::string>();
        return r;
    }

    void cmd_download(const json& j) {
        if (!backend.download) throw CommandError("this engine was built without downloads");
        Download d;
        d.req = request_of(j);
        try {
            validate_download(d.req);
        } catch (const std::invalid_argument& e) {
            throw CommandError(e.what());
        }
        d.file = download_file_name(d.req);
        {
            std::lock_guard<std::mutex> lk(mu);
            for (const Download& q : downloads) {
                if (q.req.repo == d.req.repo && q.req.path == d.req.path)
                    throw CommandError("that download is already in the queue");
                if (q.file == d.file) throw CommandError(d.file + " is already being downloaded");
            }
            std::error_code ec;
            if (fs::exists(catalog.dir() / d.file, ec))
                throw CommandError(d.file + " already exists in the models folder");
            downloads.push_back(d);
        }
        download_event(d, "queued");
        emit_models();
        cv.notify_all();
    }

    void cmd_cancel_download(const json& j) {
        const DownloadRequest r = request_of(j);
        std::optional<Download> removed;
        {
            std::lock_guard<std::mutex> lk(mu);
            auto it = downloads.begin();
            for (; it != downloads.end(); ++it) {
                if (it->req.repo == r.repo && it->req.path == r.path) break;
            }
            if (it == downloads.end()) throw CommandError("that download is not in the queue");
            if (it->running) {
                dl_cancel = true;  // the worker reports it
            } else {
                removed = *it;
                downloads.erase(it);
            }
        }
        if (removed) {
            download_event(*removed, "cancelled");
            emit_models();
            cv.notify_all();
        }
    }

    void cmd_delete(const json& j) {
        const auto it = j.find("file");
        if (it == j.end() || !it->is_string()) throw CommandError("missing \"file\"");
        const std::string name = it->get<std::string>();
        const auto p = catalog.resolve(name);
        if (!p) throw CommandError("unknown model file: " + name);
        {
            std::lock_guard<std::mutex> lk(mu);
            for (int i = 0; i < 2; ++i) {
                if (same_file(paths[i], p->string()) || same_file(target[i], p->string()))
                    throw CommandError(name + " is loaded");
            }
            if (pending_load && (same_file(pending_load->first, p->string()) || same_file(pending_load->second, p->string())))
                throw CommandError(name + " is loaded");
            for (const Download& d : downloads) {
                if (d.file == name) throw CommandError(name + " is being downloaded");
            }
        }
        std::error_code ec;
        fs::remove(*p, ec);
        if (ec) throw CommandError("cannot delete " + name + ": " + ec.message());
        emit_models();
    }

    void command(const std::string& text) {
        const json j = json::parse(text, nullptr, false);
        if (j.is_discarded() || !j.is_object()) {
            emit(error_event("", "invalid JSON command"));
            return;
        }
        const auto it = j.find("cmd");
        if (it == j.end() || !it->is_string()) {
            emit(error_event("", "missing \"cmd\""));
            return;
        }
        const std::string cmd = it->get<std::string>();
        try {
            if (cmd == "models") {
                emit_models();
            } else if (cmd == "load") {
                cmd_load(j);
            } else if (cmd == "download") {
                cmd_download(j);
            } else if (cmd == "cancel_download") {
                cmd_cancel_download(j);
            } else if (cmd == "delete") {
                cmd_delete(j);
            } else {
                bool busy;
                {
                    std::lock_guard<std::mutex> lk(mu);
                    busy = load_busy;
                }
                if (busy) throw CommandError("models are loading");
                std::shared_lock<std::shared_mutex> lk(session_mu);
                if (!session) throw CommandError("no model loaded");
                session->post(text);
            }
        } catch (const std::exception& e) {  // CommandError, or the catalog's
            emit(error_event(cmd, e.what()));
        }
    }
};

Hub::Hub(Log& log, Catalog& catalog, HubBackend backend, Sinks sinks, SessionOptions session_options)
    : impl_(std::make_unique<Impl>(log, catalog, std::move(backend), std::move(sinks), session_options)) {
    Impl* p = impl_.get();
    // The first `models` event, for connect_events() before anything changes.
    p->emit_models();
    p->load_thread = std::thread([p] { p->load_loop(); });
    p->dl_thread = std::thread([p] { p->download_loop(); });
}

Hub::~Hub() {
    Impl& s = *impl_;
    {
        std::lock_guard<std::mutex> lk(s.mu);
        s.stopping = true;
        s.dl_cancel = true;
    }
    s.cv.notify_all();
    if (s.load_thread.joinable()) s.load_thread.join();  // a load in progress ends first
    if (s.dl_thread.joinable()) s.dl_thread.join();
    s.close_session();
    s.models[1].reset();
    s.models[0].reset();
}

void Hub::load_paths(const std::string& a, const std::string& b) {
    if (a.empty()) throw std::runtime_error("model A is missing");
    {
        std::lock_guard<std::mutex> lk(impl_->mu);
        if (impl_->load_busy || impl_->load_finishing) throw std::runtime_error("a load is already running");
        impl_->load_busy = true;
    }
    impl_->do_load(a, b);
}

void Hub::command(const std::string& json) { impl_->command(json); }

Status Hub::status() const {
    std::shared_lock<std::shared_mutex> lk(impl_->session_mu);
    if (impl_->session) return impl_->session->status();
    Status st;
    st.tps_limit = DEFAULT_TPS_LIMIT;  // what the next session starts with
    return st;
}

std::vector<std::string> Hub::connect_events() const {
    std::lock_guard<std::mutex> lk(impl_->mu);
    return {impl_->last_models};
}

SeekStats Hub::seek_stats() const {
    SeekStats st;
    {
        std::lock_guard<std::mutex> lk(impl_->mu);
        st = impl_->seek_done;
    }
    std::shared_lock<std::shared_mutex> lk(impl_->session_mu);
    if (impl_->session) {
        const SeekStats cur = impl_->session->seek_stats();
        st.verified += cur.verified;
        st.mismatches += cur.mismatches;
    }
    return st;
}

bool Hub::wait_idle(std::chrono::milliseconds timeout) {
    std::unique_lock<std::mutex> lk(impl_->mu);
    return impl_->cv.wait_for(lk, timeout, [&] {
        return !impl_->load_busy && !impl_->load_finishing && !impl_->dl_busy && impl_->downloads.empty();
    });
}

}  // namespace ils
