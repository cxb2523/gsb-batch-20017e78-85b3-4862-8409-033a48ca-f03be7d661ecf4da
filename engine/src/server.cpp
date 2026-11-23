#include "server.h"

#include "gzip.h"

#include <cpp-httplib/httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <condition_variable>
#include <mutex>
#include <thread>
#include <unordered_map>

namespace ils {

namespace {

namespace ws = httplib::ws;
using json = nlohmann::ordered_json;

constexpr size_t kMaxMessageBytes = 1 << 20;  // log bytes per WebSocket message (whole batches)

// How long a connection thread blocks in read() before checking whether the
// server is stopping. Only a timeout set at runtime is reported as
// ws::Timeout and keeps the connection open; the compile-time default (300 s)
// would close a browser that only watches. Liveness is ping/pong instead.
constexpr auto kReadSlice = std::chrono::seconds(1);
constexpr int kMaxMissedPongs = 3;  // pings go every 30 s
constexpr auto kCloseWait = std::chrono::seconds(3);

}  // namespace

struct Server::Impl {
    Log& log;
    WebAssets web;
    Handlers handlers;
    ServerOptions options;
    std::unordered_map<std::string, const WebAsset*> assets;

    httplib::Server svr;
    int port = -1;
    std::thread listen_thread;
    std::thread broadcaster;
    std::atomic<bool> stopping{false};
    std::mutex stop_mu;
    bool stopped = false;

    // One per open WebSocket. `ws` lives only while its handler runs: it is
    // used only under `conns_mu`, and the handler unregisters under that same
    // lock before returning.
    struct Conn {
        ws::WebSocket* ws = nullptr;
        uint64_t epoch = 0;  // position in the log
        size_t offset = 0;
        bool fresh = true;  // has not had its first `status` yet
        std::atomic<bool> dead{false};
    };
    mutable std::mutex conns_mu;
    std::condition_variable conns_cv;
    std::vector<std::shared_ptr<Conn>> conns;
    size_t last_clients = 0;  // broadcaster only

    // Wake-ups of the broadcaster.
    std::mutex wake_mu;
    std::condition_variable wake_cv;
    bool wake = false;
    bool broadcaster_stop = false;
    bool status_due = false;
    std::vector<std::string> events;

    Impl(Log& l, WebAssets w, Handlers h) : log(l), web(w), handlers(std::move(h)) {
        for (size_t i = 0; i < web.count; ++i) assets[web.items[i].path] = &web.items[i];
    }

    void kick(bool status = false, std::string event = {}) {
        {
            std::lock_guard<std::mutex> lk(wake_mu);
            wake = true;
            if (status) status_due = true;
            if (!event.empty()) events.push_back(std::move(event));
        }
        wake_cv.notify_one();
    }

    std::string status_json(const Status& s, size_t clients) const {
        json j;
        j["ev"] = "status";
        j["state"] = to_string(s.state);
        j["tps"] = std::round(s.tps * 10) / 10;
        j["tps_limit"] = s.tps_limit;
        j["nodes"] = s.nodes;
        j["clients"] = clients;
        return j.dump();
    }

    // Sends a connection everything of the log it has not seen. Under conns_mu.
    void catch_up(Conn& c) {
        for (;;) {
            Log::Chunk chunk = log.read(c.epoch, c.offset, kMaxMessageBytes);
            c.epoch = chunk.epoch;
            c.offset = chunk.next;
            if (chunk.bytes.empty()) return;
            if (!c.ws->send(reinterpret_cast<const char*>(chunk.bytes.data()), chunk.bytes.size())) {
                c.dead = true;  // its handler sees this and returns
                return;
            }
        }
    }

    void send_text(Conn& c, const std::string& text) {
        if (!c.dead && !c.ws->send(text)) c.dead = true;
    }

    void broadcast_loop() {
        for (;;) {
            std::vector<std::string> evs;
            bool status_now = false;
            {
                std::unique_lock<std::mutex> lk(wake_mu);
                wake_cv.wait(lk, [&] { return wake || broadcaster_stop; });
                if (broadcaster_stop) return;
                wake = false;
                evs.swap(events);
                status_now = status_due;
                status_due = false;
            }
            const Status st = handlers.status ? handlers.status() : Status{};

            std::lock_guard<std::mutex> lk(conns_mu);
            for (auto& c : conns) {
                if (!c->dead) catch_up(*c);
            }
            if (conns.size() != last_clients) {
                last_clients = conns.size();
                status_now = true;
            }
            for (const std::string& e : evs) {
                for (auto& c : conns) send_text(*c, e);
            }
            const std::string status = status_json(st, conns.size());
            bool any_fresh = false;
            for (auto& c : conns) any_fresh = any_fresh || c->fresh;
            // Asked for before sending anything, so the handler never waits on a slow socket.
            const std::vector<std::string> greeting =
                any_fresh && handlers.connect_events ? handlers.connect_events() : std::vector<std::string>{};
            for (auto& c : conns) {
                if (status_now || c->fresh) send_text(*c, status);
                if (c->fresh) {
                    for (const std::string& e : greeting) send_text(*c, e);
                }
                c->fresh = false;
            }
        }
    }

    bool origin_allowed(const httplib::Request& req) const {
        const std::string origin = req.get_header_value("Origin");
        if (origin.empty()) return false;
        if (origin == "http://" + req.get_header_value("Host")) return true;
        return std::find(options.allow_origins.begin(), options.allow_origins.end(), origin) !=
               options.allow_origins.end();
    }

    void on_websocket(ws::WebSocket& sock) {
        sock.set_read_timeout(kReadSlice);
        auto conn = std::make_shared<Conn>();
        conn->ws = &sock;
        {
            std::lock_guard<std::mutex> lk(conns_mu);
            if (stopping) {
                sock.close(ws::CloseStatus::GoingAway, "server stopping");
                return;
            }
            conns.push_back(conn);
        }
        kick();

        std::string msg;
        while (!stopping && !conn->dead) {
            const ws::ReadResult r = sock.read(msg);
            if (r == ws::Fail) break;
            if (r == ws::Timeout) continue;
            if (r == ws::Text && handlers.command) handlers.command(msg);
        }

        {
            std::lock_guard<std::mutex> lk(conns_mu);
            conns.erase(std::remove(conns.begin(), conns.end(), conn), conns.end());
        }
        conns_cv.notify_all();
        kick();
    }

    void setup_routes() {
        // cpp-httplib sets SO_REUSEPORT by default, which lets a second engine
        // bind the same port and share its connections. SO_REUSEADDR only
        // allows a quick restart, so a busy port is an error. On Windows
        // SO_REUSEADDR would let another process take the port over:
        // SO_EXCLUSIVEADDRUSE is the safe option there.
#ifdef _WIN32
        svr.set_socket_options([](socket_t sock) { httplib::set_socket_opt(sock, SOL_SOCKET, SO_EXCLUSIVEADDRUSE, 1); });
#else
        svr.set_socket_options([](socket_t sock) { httplib::set_socket_opt(sock, SOL_SOCKET, SO_REUSEADDR, 1); });
#endif
        svr.set_websocket_max_missed_pongs(kMaxMissedPongs);

        // The Origin check runs before the upgrade, with an explicit 403.
        svr.set_pre_routing_handler([this](const httplib::Request& req, httplib::Response& res) {
            if (req.path != "/ws" || origin_allowed(req)) return httplib::Server::HandlerResponse::Unhandled;
            res.status = 403;
            res.set_content("forbidden origin\n", "text/plain");
            return httplib::Server::HandlerResponse::Handled;
        });

        svr.WebSocket("/ws", [this](const httplib::Request&, ws::WebSocket& sock) { on_websocket(sock); });

        // Already gzip: served as an opaque file, without Content-Encoding.
        svr.Get("/api/session.ils", [this](const httplib::Request&, httplib::Response& res) {
            const Bytes gz = gzip(log.snapshot());
            res.set_content(reinterpret_cast<const char*>(gz.data()), gz.size(), "application/octet-stream");
            res.set_header("Cache-Control", "no-store");
        });

        svr.Get(R"(/.*)", [this](const httplib::Request& req, httplib::Response& res) {
            const std::string path = req.path == "/" ? "/index.html" : req.path;
            const auto it = assets.find(path);
            if (it == assets.end()) {
                res.status = 404;
                res.set_content("not found\n", "text/plain");
                return;
            }
            const WebAsset& a = *it->second;
            res.set_content(reinterpret_cast<const char*>(a.data), a.size, a.mime);
            res.set_header("Content-Encoding", "gzip");
            if (path == "/index.html") res.set_header("Cache-Control", "no-cache");
        });
    }
};

Server::Server(Log& log, WebAssets web, Handlers handlers)
    : impl_(std::make_unique<Impl>(log, web, std::move(handlers))) {
    Impl* p = impl_.get();
    log.set_listener([p] { p->kick(); });
    impl_->setup_routes();
}

Server::~Server() {
    stop();
    impl_->log.set_listener(nullptr);
}

bool Server::start(const ServerOptions& options) {
    Impl& s = *impl_;
    s.options = options;
    if (options.port == 0) {
        s.port = s.svr.bind_to_any_port(options.host);
        if (s.port < 0) return false;
    } else {
        if (!s.svr.bind_to_port(options.host, options.port)) return false;
        s.port = options.port;
    }
    s.broadcaster = std::thread([&s] { s.broadcast_loop(); });
    s.listen_thread = std::thread([&s] { s.svr.listen_after_bind(); });
    s.svr.wait_until_ready();
    return true;
}

int Server::port() const { return impl_->port; }

void Server::push_event(const std::string& json) { impl_->kick(false, json); }

void Server::notify_status() { impl_->kick(true); }

size_t Server::clients() const {
    std::lock_guard<std::mutex> lk(impl_->conns_mu);
    return impl_->conns.size();
}

void Server::stop() {
    Impl& s = *impl_;
    {
        std::lock_guard<std::mutex> lk(s.stop_mu);
        if (s.stopped) return;
        s.stopped = true;
    }
    s.stopping = true;

    // WebSocket connections first: otherwise stopping waits for their reads.
    {
        std::lock_guard<std::mutex> lk(s.conns_mu);
        for (auto& c : s.conns) c->ws->close(ws::CloseStatus::GoingAway, "server stopping");
    }
    {
        std::unique_lock<std::mutex> lk(s.conns_mu);
        s.conns_cv.wait_for(lk, kCloseWait, [&] { return s.conns.empty(); });
    }
    {
        std::lock_guard<std::mutex> lk(s.wake_mu);
        s.broadcaster_stop = true;
    }
    s.wake_cv.notify_all();
    if (s.broadcaster.joinable()) s.broadcaster.join();

    s.svr.stop();
    if (s.listen_thread.joinable()) s.listen_thread.join();
}

}  // namespace ils
