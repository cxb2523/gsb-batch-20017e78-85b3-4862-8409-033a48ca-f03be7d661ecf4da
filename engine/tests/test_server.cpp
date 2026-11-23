// The real server on a free port, with the fake model and cpp-httplib's
// WebSocket client: Origin check, late joiners, commands, events, the
// session file, the embedded web and shutdown.
#include "check.h"
#include "fake_model.h"
#include "frames.h"
#include "gzip.h"
#include "log.h"
#include "server.h"
#include "session.h"

#include <cpp-httplib/httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

using namespace ils;
using json = nlohmann::json;
using namespace std::chrono_literals;
using Clock = std::chrono::steady_clock;

namespace {

// ------------------------------------------------------------- test web

Bytes gz_of(const std::string& s) { return gzip(Bytes(s.begin(), s.end())); }

const std::string kIndex = "<!doctype html><title>test</title>";
const std::string kScript = "console.log('hi');";
const Bytes kIndexGz = gz_of(kIndex);
const Bytes kScriptGz = gz_of(kScript);
const WebAsset kAssets[] = {
    {"/index.html", "text/html; charset=utf-8", kIndexGz.data(), kIndexGz.size()},
    {"/assets/app.js", "text/javascript; charset=utf-8", kScriptGz.data(), kScriptGz.size()},
};
const WebAssets kWeb{kAssets, 2};

// --------------------------------------------------------- engine set-up

// Log + server + session, wired as in app.cpp.
struct Engine {
    FakeModel model;
    Log log;
    Session* sp = nullptr;
    Server server;
    std::unique_ptr<Session> session;
    bool started = false;

    explicit Engine(FakeOptions o, std::vector<std::string> allow = {})
        : model(o),
          server(log, kWeb,
                 {[this](const std::string& t) { sp->post(t); }, [this] { return sp->status(); },
                  [] { return std::vector<std::string>{R"({"ev":"models","test":1})"}; }}) {
        session = std::make_unique<Session>(
            model, nullptr, log, Session::Sinks{[this](const std::string& e) { server.push_event(e); }, [this] { server.notify_status(); }});
        sp = session.get();
        ServerOptions so;
        so.host = "127.0.0.1";
        so.port = 0;
        so.allow_origins = std::move(allow);
        started = server.start(so);
    }
    ~Engine() {
        server.stop();
        session.reset();
    }
    std::string host() const { return "127.0.0.1:" + std::to_string(server.port()); }
};

// --------------------------------------------------------------- client

// A WebSocket client with a reader thread. `bytes` is the log as the web
// would hold it: a message that starts with HELLO starts it again.
struct Client {
    std::unique_ptr<httplib::ws::WebSocketClient> ws;
    std::thread reader;
    std::mutex mu;
    std::condition_variable cv;
    Bytes bytes;
    std::string kinds;  // 'b' binary, 't' text, in arrival order
    std::vector<json> texts;
    bool closed = false;
    int status = -1;

    bool connect(const std::string& host, const std::string& origin) {
        httplib::Headers h;
        if (!origin.empty()) h.emplace("Origin", origin);
        ws = std::make_unique<httplib::ws::WebSocketClient>("ws://" + host + "/ws", h);
        const auto r = ws->connect();
        status = r.status();
        if (!r) return false;
        reader = std::thread([this] {
            std::string msg;
            for (;;) {
                const auto rr = ws->read(msg);
                if (rr == httplib::ws::Fail) break;
                if (rr == httplib::ws::Timeout) continue;
                std::lock_guard<std::mutex> lk(mu);
                if (rr == httplib::ws::Binary) {
                    if (!msg.empty() && static_cast<uint8_t>(msg[0]) == static_cast<uint8_t>(FrameType::Hello)) bytes.clear();
                    bytes.insert(bytes.end(), msg.begin(), msg.end());
                    kinds += 'b';
                } else {
                    texts.push_back(json::parse(msg, nullptr, false));
                    kinds += 't';
                }
                cv.notify_all();
            }
            std::lock_guard<std::mutex> lk(mu);
            closed = true;
            cv.notify_all();
        });
        return true;
    }

    template <class Pred>
    bool wait(Pred pred, std::chrono::milliseconds timeout = 5000ms) {
        std::unique_lock<std::mutex> lk(mu);
        return cv.wait_for(lk, timeout, [&] { return pred(); });
    }

    bool has_bytes(const Bytes& want) {
        return wait([&] { return bytes == want; });
    }

    // Waits for a text event with ev == `ev` and, if given, cmd == `cmd`.
    bool wait_event(const std::string& ev, const char* cmd = nullptr) {
        return wait([&] {
            for (const json& t : texts) {
                if (t.value("ev", "") == ev && (!cmd || t.value("cmd", "?") == cmd)) return true;
            }
            return false;
        });
    }

    void send(const json& j) { ws->send(j.dump()); }

    ~Client() {
        if (ws) ws->close();
        if (reader.joinable()) reader.join();
    }
};

// ------------------------------------------------------------------ tests

void test_origin() {
    Engine e({}, {"http://localhost:5173"});
    CHECK(e.started);
    CHECK(e.server.port() > 0);

    Client evil;
    CHECK(!evil.connect(e.host(), "http://evil.example"));
    CHECK_EQ(evil.status, 403);
    Client none;
    CHECK(!none.connect(e.host(), ""));
    CHECK_EQ(none.status, 403);
    Client other_host;  // the Host header is 127.0.0.1:<port>
    CHECK(!other_host.connect(e.host(), "http://localhost:" + std::to_string(e.server.port())));
    CHECK_EQ(other_host.status, 403);

    Client same;
    CHECK(same.connect(e.host(), "http://" + e.host()));
    Client dev;
    CHECK(dev.connect(e.host(), "http://localhost:5173"));
    CHECK(same.wait([&] { return !same.texts.empty(); }));
    CHECK(dev.wait([&] { return !dev.texts.empty(); }));
}

void test_late_join_and_commands() {
    FakeOptions o;
    o.delay_ms = 1;
    Engine e(o);
    CHECK(e.started);

    // Before any prompt: the log (HELLO CONFIG), then a status, without sending anything.
    Client c1;
    CHECK(c1.connect(e.host(), "http://" + e.host()));
    CHECK(c1.wait([&] { return !c1.texts.empty(); }));
    {
        std::lock_guard<std::mutex> lk(c1.mu);
        CHECK(c1.bytes == e.log.snapshot());
        CHECK(c1.kinds.size() >= 2 && c1.kinds[0] == 'b' && c1.kinds.find('t') > 0);
        const json& st = c1.texts[0];
        CHECK_EQ(st["ev"].get<std::string>(), std::string("status"));
        CHECK_EQ(st["state"].get<std::string>(), std::string("idle"));
        CHECK_EQ(st["clients"], 1);
        CHECK_EQ(st["nodes"], 0);
        CHECK_EQ(st["tps_limit"], DEFAULT_TPS_LIMIT);
        CHECK(st.contains("tps"));
    }
    // Then the connect events, after the first status.
    CHECK(c1.wait([&] { return c1.texts.size() >= 2; }));
    {
        std::lock_guard<std::mutex> lk(c1.mu);
        CHECK_EQ(c1.texts[1]["ev"].get<std::string>(), std::string("models"));
        CHECK_EQ(c1.texts[1]["test"], 1);
    }

    // A browser that only watches is not dropped by the read timeout.
    std::this_thread::sleep_for(1500ms);
    CHECK_EQ(e.server.clients(), 1u);
    CHECK(c1.ws->is_open());

    // Commands over the WebSocket; a second browser joins mid-generation.
    c1.send({{"cmd", "speed"}, {"tps", 100}});
    c1.send({{"cmd", "start"}, {"prompt", " the dog"}, {"config", {{"max_tokens", 60}}}});
    c1.send({{"cmd", "run"}});
    const auto t0 = Clock::now();
    while (e.session->status().nodes < 20 && Clock::now() - t0 < 5s) std::this_thread::sleep_for(5ms);
    CHECK(e.session->status().state == RunState::Running);
    Client c2;
    CHECK(c2.connect(e.host(), "http://" + e.host()));
    CHECK(e.session->wait_idle(10s));
    const Bytes snap = e.log.snapshot();
    CHECK(c1.has_bytes(snap));
    CHECK(c2.has_bytes(snap));
    {
        std::lock_guard<std::mutex> lk(c2.mu);
        CHECK(!c2.kinds.empty() && c2.kinds[0] == 'b');
    }
    std::vector<FrameView> fs;
    CHECK(split_frames(snap, fs));
    CHECK(!fs.empty() && fs.back().type == FrameType::Stop);
    CHECK(c2.wait_event("status"));
    CHECK(c1.wait([&] {
        for (const json& t : c1.texts) {
            if (t.value("ev", "") == "status" && t.value("clients", 0) == 2) return true;
        }
        return false;
    }));
    CHECK(c1.wait([&] { return !c1.texts.empty() && c1.texts.back().value("state", "") == "paused"; }));

    // An error goes to every browser: the cursor is on a stopped node.
    c2.send({{"cmd", "run"}});
    CHECK(c1.wait_event("error", "run"));
    CHECK(c2.wait_event("error", "run"));

    // A third client after the end gets exactly the same bytes.
    Client c3;
    CHECK(c3.connect(e.host(), "http://" + e.host()));
    CHECK(c3.has_bytes(snap));

    // The session file.
    httplib::Client http("127.0.0.1", e.server.port());
    http.set_decompress(false);
    const auto res = http.Get("/api/session.ils");
    CHECK(res);
    if (res) {
        CHECK_EQ(res->status, 200);
        CHECK_EQ(res->get_header_value("Content-Type"), "application/octet-stream");
        CHECK(!res->has_header("Content-Encoding"));
        Bytes raw;
        CHECK(gunzip(Bytes(res->body.begin(), res->body.end()), raw));
        CHECK(raw == snap);
    }

    // Shutdown with three browsers connected: quick and clean.
    const auto s0 = Clock::now();
    e.server.stop();
    CHECK(Clock::now() - s0 < 2s);
    CHECK_EQ(e.server.clients(), 0u);
    CHECK(c1.wait([&] { return c1.closed; }, 2000ms));
    CHECK(c2.wait([&] { return c2.closed; }, 2000ms));
    CHECK(c3.wait([&] { return c3.closed; }, 2000ms));
}

void test_static_and_bind() {
    Engine e({});
    CHECK(e.started);
    httplib::Client http("127.0.0.1", e.server.port());
    http.set_decompress(false);

    for (const char* path : {"/", "/index.html"}) {
        const auto r = http.Get(path);
        CHECK(r);
        if (!r) continue;
        CHECK_EQ(r->status, 200);
        CHECK_EQ(r->get_header_value("Content-Encoding"), "gzip");
        CHECK_EQ(r->get_header_value("Content-Type"), "text/html; charset=utf-8");
        CHECK_EQ(r->get_header_value("Cache-Control"), "no-cache");
        Bytes raw;
        CHECK(gunzip(Bytes(r->body.begin(), r->body.end()), raw));
        CHECK(std::string(raw.begin(), raw.end()) == kIndex);
    }
    const auto js = http.Get("/assets/app.js");
    CHECK(js);
    if (js) {
        CHECK_EQ(js->status, 200);
        CHECK_EQ(js->get_header_value("Content-Encoding"), "gzip");
        CHECK_EQ(js->get_header_value("Content-Type"), "text/javascript; charset=utf-8");
        CHECK(Bytes(js->body.begin(), js->body.end()) == kScriptGz);
    }
    for (const char* path : {"/missing", "/assets/", "/index.html/x"}) {
        const auto r = http.Get(path);
        CHECK(r);
        if (r) CHECK_EQ(r->status, 404);
    }

    // The same port again: start fails instead of throwing.
    Log log2;
    Server other(log2, kWeb, {});
    ServerOptions so;
    so.port = e.server.port();
    CHECK(!other.start(so));
}

}  // namespace

int main() {
    test_origin();
    test_late_join_and_commands();
    test_static_and_bind();
    return test_result();
}
