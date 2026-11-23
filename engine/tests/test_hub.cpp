// The hub (hub.h, the model-management commands): routing, hot loads,
// the reuse rule, freeing before loading, failures, the download queue and
// delete. Fake models, metadata-only GGUF fixtures and a fake transfer: no
// llama.cpp, no GPU, no network.
#include "catalog.h"
#include "check.h"
#include "fake_model.h"
#include "frames.h"
#include "gguf_fixture.h"
#include "hub.h"

#include <nlohmann/json.hpp>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <filesystem>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

using namespace ils;
using json = nlohmann::json;
using namespace std::chrono_literals;
namespace fs = std::filesystem;

namespace {

constexpr int kCtx = 4096;
constexpr uint64_t kGpuTotal = 1000000000;
constexpr uint64_t kGpuFree = 600000000;

// ------------------------------------------------------------- fixtures

FixtureGguf family(int32_t file_type) {
    FixtureGguf f;
    f.file_type = file_type;
    return f;
}

FixtureGguf other_family() {
    FixtureGguf f;
    f.tokens = {"<s>", "</s>", "x", "y", "z", "w"};
    return f;
}

// A clean folder with the test's files.
fs::path make_dir(const std::string& name) {
    const fs::path dir = fs::temp_directory_path() / name;
    fs::remove_all(dir);
    fs::create_directories(dir);
    write_fixture_gguf(dir / "a-Q8_0.gguf", family(7));
    write_fixture_gguf(dir / "a-Q2_K.gguf", family(10));
    write_fixture_gguf(dir / "a-Q4_0.gguf", family(2));
    write_fixture_gguf(dir / "other-Q4_K_M.gguf", other_family());
    write_fixture_gguf(dir / "fail-Q4_0.gguf", family(2));  // the backend refuses it
    return dir;
}

// ------------------------------------------------------------ fake backend

// Counts loads and live models; a file starting with "other" has another
// tokenizer, one starting with "fail" cannot be loaded.
struct Backend {
    std::mutex mu;
    std::vector<std::string> loads;  // "<file>@<slot>/<n>"
    int live = 0;
    int max_live_at_load = 0;        // live models when a load started, at most
    std::vector<int> live_at_load;
    int load_ms = 0;

    class Counted : public FakeModel {
    public:
        Counted(FakeOptions o, Backend& b) : FakeModel(std::move(o)), b_(b) {
            std::lock_guard<std::mutex> lk(b_.mu);
            ++b_.live;
        }
        ~Counted() override {
            std::lock_guard<std::mutex> lk(b_.mu);
            --b_.live;
        }

    private:
        Backend& b_;
    };

    std::unique_ptr<Model> load(const std::string& path, int slot, int n) {
        const std::string file = fs::path(path).filename().string();
        {
            std::lock_guard<std::mutex> lk(mu);
            loads.push_back(file + "@" + std::to_string(slot) + "/" + std::to_string(n));
            live_at_load.push_back(live);
        }
        if (load_ms) std::this_thread::sleep_for(std::chrono::milliseconds(load_ms));
        if (file.rfind("fail", 0) == 0) throw std::runtime_error("cannot load " + file + ": simulated");
        FakeOptions o;
        o.file = file;
        if (file.rfind("other", 0) == 0) o.extra_piece = "<other>";
        if (slot == 1) o.variant = 1;
        return std::make_unique<Counted>(o, *this);
    }

    std::vector<std::string> take_loads() {
        std::lock_guard<std::mutex> lk(mu);
        std::vector<std::string> out;
        out.swap(loads);
        live_at_load.clear();
        return out;
    }
    int live_now() {
        std::lock_guard<std::mutex> lk(mu);
        return live;
    }
};

// A transfer that writes a fixture after some progress. A repo with "slow"
// runs until cancelled (or 10 s); one with "fail" fails.
void fake_download(const DownloadRequest& req, const fs::path& dest,
                   const std::function<void(const DownloadProgress&)>& progress, const std::atomic<bool>& cancel) {
    const bool slow = req.repo.find("slow") != std::string::npos;
    const int steps = slow ? 1000 : 40;  // 10 ms each
    const uint64_t total = 4000;
    for (int i = 1; i <= steps; ++i) {
        std::this_thread::sleep_for(10ms);
        if (cancel) throw DownloadCancelled();
        if (req.repo.find("fail") != std::string::npos) throw std::runtime_error("HTTP 404");
        progress({total * static_cast<uint64_t>(i) / steps, total});
    }
    write_fixture_gguf(dest, family(7));
}

// ------------------------------------------------------------- the setup

struct Events {
    std::mutex mu;
    std::vector<json> all;
    void add(const std::string& s) {
        std::lock_guard<std::mutex> lk(mu);
        all.push_back(json::parse(s));
    }
    std::vector<json> take(const std::string& ev = "") {
        std::lock_guard<std::mutex> lk(mu);
        std::vector<json> out;
        for (const json& j : all) {
            if (ev.empty() || j["ev"] == ev) out.push_back(j);
        }
        all.clear();
        return out;
    }
    json last(const std::string& ev) {
        std::lock_guard<std::mutex> lk(mu);
        for (auto it = all.rbegin(); it != all.rend(); ++it) {
            if ((*it)["ev"] == ev) return *it;
        }
        return nullptr;
    }
};

struct Rig {
    fs::path dir;
    Log log;
    Catalog catalog;
    Backend backend;
    Events events;
    std::atomic<int> status_calls{0};
    std::function<void(const json&)> hook;  // called with every event, from the hub's threads
    std::unique_ptr<Hub> hub;

    explicit Rig(const std::string& name, bool downloads = true) : dir(make_dir(name)), catalog(dir, kCtx) {
        HubBackend hb;
        hb.load_model = [this](const std::string& p, int s, int n) { return backend.load(p, s, n); };
        if (downloads) hb.download = fake_download;
        hb.gpu_memory = [] { return GpuMemory{kGpuTotal, kGpuFree}; };
        hub = std::make_unique<Hub>(log, catalog, hb,
                                    Hub::Sinks{[this](const std::string& e) {
                                                   events.add(e);
                                                   if (hook) hook(json::parse(e));
                                               },
                                               [this] { ++status_calls; }});
    }
    ~Rig() {
        hub.reset();
        std::error_code ec;
        fs::remove_all(dir, ec);
    }

    void cmd(const json& j) { hub->command(j.dump()); }
    void cmd_wait(const json& j) {
        cmd(j);
        CHECK(hub->wait_idle(10s));
    }

    // HELLO of the log, as JSON.
    json hello() {
        std::vector<FrameView> fs;
        const Bytes b = log.snapshot();
        if (!split_frames(b, fs) || fs.empty() || fs[0].type != FrameType::Hello) return nullptr;
        return json::parse(std::string(reinterpret_cast<const char*>(fs[0].body), fs[0].length));
    }
};

std::vector<std::string> file_names(const json& models) {
    std::vector<std::string> out;
    for (const json& f : models.at("files")) out.push_back(f.at("file"));
    return out;
}

bool has_file(const json& models, const std::string& name) {
    for (const json& f : models.at("files")) {
        if (f.at("file").get<std::string>() == name) return true;
    }
    return false;
}

uint64_t vram_of(const fs::path& p) { return read_gguf_header(p, kCtx).vram; }

// The one error event of `events`, for `cmd`; its message, or "" if none.
std::string error_msg(std::vector<json> evs, const std::string& cmd) {
    for (const json& e : evs) {
        if (e["ev"] == "error" && e.value("cmd", "") == cmd) return e["msg"];
    }
    return "";
}

bool contains(const std::string& s, const std::string& part) { return s.find(part) != std::string::npos; }

// ------------------------------------------------------------------ tests

void test_start_empty_and_load_one() {
    Rig r("ils_test_hub_one");

    // Before anything: the models event, nothing loaded.
    const std::vector<std::string> ce = r.hub->connect_events();
    CHECK_EQ(ce.size(), 1u);
    const json m0 = json::parse(ce[0]);
    CHECK_EQ(m0["ev"], "models");
    CHECK(m0["loaded"]["a"].is_null());
    CHECK(m0["loaded"]["b"].is_null());
    CHECK_EQ(m0["loading"], false);
    CHECK_EQ(m0["download"], true);
    CHECK_EQ(m0["n_ctx"], kCtx);
    CHECK_EQ(m0["gpu"]["total"], kGpuTotal);
    CHECK_EQ(m0["gpu"]["available"], kGpuFree);
    CHECK((file_names(m0) == std::vector<std::string>{"a-Q2_K.gguf", "a-Q4_0.gguf", "a-Q8_0.gguf",
                                                      "fail-Q4_0.gguf", "other-Q4_K_M.gguf"}));
    CHECK(m0["downloads"].empty());
    CHECK(r.hub->status().state == RunState::Idle);

    // Session commands need a model.
    r.events.take();
    r.cmd({{"cmd", "start"}, {"prompt", "hi"}});
    r.cmd({{"cmd", "run"}});
    {
        const auto evs = r.events.take("error");
        CHECK_EQ(evs.size(), 2u);
        CHECK_EQ(error_msg(evs, "start"), "no model loaded");
        CHECK_EQ(error_msg(evs, "run"), "no model loaded");
    }
    // Malformed commands.
    r.hub->command("{not json");
    r.hub->command("{\"x\":1}");
    CHECK_EQ(r.events.take("error").size(), 2u);

    r.cmd_wait({{"cmd", "load"}, {"a", "a-Q8_0.gguf"}});
    const auto evs = r.events.take();
    std::vector<json> loads, models;
    for (const json& e : evs) {
        if (e["ev"] == "load") loads.push_back(e);
        if (e["ev"] == "models") models.push_back(e);
    }
    CHECK_EQ(loads.size(), 2u);
    CHECK_EQ(loads[0]["state"], "loading");
    CHECK_EQ(loads[0]["a"], "a-Q8_0.gguf");
    CHECK(loads[0]["b"].is_null());
    CHECK_EQ(loads[1]["state"], "ready");
    CHECK_EQ(loads[1]["a"], "a-Q8_0.gguf");
    CHECK(loads[1]["b"].is_null());
    CHECK(models.size() >= 2u);
    CHECK_EQ(models.front()["loading"], true);
    const json m = models.back();
    CHECK_EQ(m["loading"], false);
    CHECK_EQ(m["loaded"]["a"], "a-Q8_0.gguf");
    CHECK(m["loaded"]["b"].is_null());
    CHECK_EQ(m["gpu"]["available"], kGpuFree + vram_of(r.dir / "a-Q8_0.gguf"));
    CHECK((r.backend.take_loads() == std::vector<std::string>{"a-Q8_0.gguf@0/1"}));
    CHECK(json::parse(r.hub->connect_events()[0]) == m);

    // The log starts with the new session's HELLO.
    const json h = r.hello();
    CHECK(!h.is_null());
    CHECK_EQ(h["models"].size(), 1u);
    CHECK_EQ(h["models"][0]["file"], "a-Q8_0.gguf");
    CHECK(r.status_calls > 0);

    // Session commands go to the session as soon as `load` says ready, as a
    // browser sends them.
    r.hook = [&](const json& e) {
        if (e["ev"] == "load" && e["state"] == "ready") r.cmd({{"cmd", "start"}, {"prompt", "The quick"}, {"format", "raw"}});
    };
    r.cmd_wait({{"cmd", "load"}, {"a", "a-Q8_0.gguf"}});
    r.hook = nullptr;
    CHECK((r.backend.take_loads().empty()));
    bool started = false;
    for (int i = 0; i < 200 && !started; ++i) {
        started = r.hub->status().nodes > 0;
        if (!started) std::this_thread::sleep_for(10ms);
    }
    CHECK(started);
    CHECK(r.events.take("error").empty());
    CHECK_EQ(r.hub->seek_stats().verified, 0u);
}

void test_pairs_and_reuse() {
    Rig r("ils_test_hub_pairs");
    r.cmd_wait({{"cmd", "load"}, {"a", "a-Q8_0.gguf"}});
    r.backend.take_loads();

    // One model to two: A is loaded again (the number of models changed).
    r.cmd_wait({{"cmd", "load"}, {"a", "a-Q8_0.gguf"}, {"b", "a-Q2_K.gguf"}});
    CHECK((r.backend.take_loads() == std::vector<std::string>{"a-Q8_0.gguf@0/2", "a-Q2_K.gguf@1/2"}));
    CHECK_EQ(r.backend.live_now(), 2);
    {
        const json m = r.events.last("models");
        CHECK_EQ(m["loaded"]["a"], "a-Q8_0.gguf");
        CHECK_EQ(m["loaded"]["b"], "a-Q2_K.gguf");
        CHECK_EQ(m["gpu"]["available"],
                 kGpuFree + vram_of(r.dir / "a-Q8_0.gguf") + vram_of(r.dir / "a-Q2_K.gguf"));
        const json h = r.hello();
        CHECK_EQ(h["models"].size(), 2u);
        CHECK(h["warnings"].empty());
    }

    // The same pair again: nothing is loaded, but the session is new.
    const uint64_t epoch = r.log.epoch();
    r.cmd_wait({{"cmd", "load"}, {"a", "a-Q8_0.gguf"}, {"b", "a-Q2_K.gguf"}});
    CHECK(r.backend.take_loads().empty());
    CHECK(r.log.epoch() > epoch);

    // Another B: A stays, the old B is freed before the new one loads.
    r.cmd_wait({{"cmd", "load"}, {"a", "a-Q8_0.gguf"}, {"b", "a-Q4_0.gguf"}});
    {
        std::lock_guard<std::mutex> lk(r.backend.mu);
        CHECK((r.backend.loads == std::vector<std::string>{"a-Q4_0.gguf@1/2"}));
        CHECK((r.backend.live_at_load == std::vector<int>{1}));
    }
    r.backend.take_loads();

    // A B with another tokenizer: dropped, A goes on alone with a warning.
    r.events.take();
    r.cmd_wait({{"cmd", "load"}, {"a", "a-Q8_0.gguf"}, {"b", "other-Q4_K_M.gguf"}});
    CHECK((r.backend.take_loads() == std::vector<std::string>{"other-Q4_K_M.gguf@1/2"}));
    CHECK_EQ(r.backend.live_now(), 1);
    {
        const json ready = r.events.last("load");
        CHECK_EQ(ready["state"], "ready");
        CHECK_EQ(ready["a"], "a-Q8_0.gguf");
        CHECK(ready["b"].is_null());
        const json m = r.events.last("models");
        CHECK(m["loaded"]["b"].is_null());
        const json h = r.hello();
        CHECK_EQ(h["models"].size(), 1u);
        CHECK_EQ(h["warnings"].size(), 1u);
        CHECK(contains(h["warnings"][0], "tokenizer differs"));
    }

    // A whole new set: everything is freed before the first load.
    r.cmd_wait({{"cmd", "load"}, {"a", "other-Q4_K_M.gguf"}});
    {
        std::lock_guard<std::mutex> lk(r.backend.mu);
        CHECK((r.backend.loads == std::vector<std::string>{"other-Q4_K_M.gguf@0/1"}));
        CHECK((r.backend.live_at_load == std::vector<int>{0}));
    }
    CHECK_EQ(r.backend.live_now(), 1);
}

void test_failures_and_names() {
    Rig r("ils_test_hub_fail");
    r.cmd_wait({{"cmd", "load"}, {"a", "a-Q8_0.gguf"}, {"b", "a-Q2_K.gguf"}});
    r.events.take();
    r.backend.take_loads();

    // B fails: nothing stays loaded.
    r.cmd_wait({{"cmd", "load"}, {"a", "a-Q8_0.gguf"}, {"b", "fail-Q4_0.gguf"}});
    CHECK_EQ(r.backend.live_now(), 0);
    {
        const json ld = r.events.last("load");
        CHECK_EQ(ld["state"], "error");
        CHECK(contains(ld["msg"], "simulated"));
        const json m = r.events.last("models");
        CHECK(m["loaded"]["a"].is_null());
        CHECK(m["loaded"]["b"].is_null());
        CHECK_EQ(m["loading"], false);
        CHECK_EQ(m["gpu"]["available"], kGpuFree);
    }
    r.events.take();
    r.cmd({{"cmd", "step"}});
    CHECK_EQ(error_msg(r.events.take(), "step"), "no model loaded");

    // Names are file names of the folder, nothing else.
    const std::string abs = (r.dir / "a-Q8_0.gguf").string();
    for (const json& bad : {json{{"cmd", "load"}, {"a", "../a-Q8_0.gguf"}}, json{{"cmd", "load"}, {"a", abs}},
                            json{{"cmd", "load"}, {"a", "sub/a-Q8_0.gguf"}}, json{{"cmd", "load"}, {"a", "nope.gguf"}},
                            json{{"cmd", "load"}, {"a", "a-Q8_0.gguf"}, {"b", "../x.gguf"}},
                            json{{"cmd", "load"}}, json{{"cmd", "load"}, {"a", 3}}}) {
        r.cmd(bad);
        const auto evs = r.events.take();
        CHECK_EQ(evs.size(), 1u);
        CHECK(!error_msg(evs, "load").empty());
    }
    // A stayed (same slot, file and count), so only the failing B was loaded.
    CHECK((r.backend.take_loads() == std::vector<std::string>{"fail-Q4_0.gguf@1/2"}));
    CHECK(r.hub->wait_idle(1s));

    // A second load while one runs is refused; so are session commands.
    r.backend.load_ms = 300;
    r.cmd({{"cmd", "load"}, {"a", "a-Q8_0.gguf"}});
    r.cmd({{"cmd", "load"}, {"a", "a-Q2_K.gguf"}});
    r.cmd({{"cmd", "run"}});
    std::this_thread::sleep_for(50ms);
    {
        const auto evs = r.events.take();
        CHECK_EQ(error_msg(evs, "load"), "a load is already running");
        CHECK_EQ(error_msg(evs, "run"), "models are loading");
    }
    CHECK(r.hub->wait_idle(10s));
    CHECK_EQ(r.events.last("models")["loaded"]["a"], "a-Q8_0.gguf");
    r.backend.load_ms = 0;
}

void test_delete() {
    Rig r("ils_test_hub_delete");
    r.cmd_wait({{"cmd", "load"}, {"a", "a-Q8_0.gguf"}});
    r.events.take();

    r.cmd({{"cmd", "delete"}, {"file", "a-Q8_0.gguf"}});
    CHECK(contains(error_msg(r.events.take(), "delete"), "is loaded"));
    CHECK(fs::exists(r.dir / "a-Q8_0.gguf"));

    for (const json& bad : {json{{"cmd", "delete"}, {"file", "nope.gguf"}},
                            json{{"cmd", "delete"}, {"file", "../a-Q2_K.gguf"}}, json{{"cmd", "delete"}}}) {
        r.cmd(bad);
        CHECK(!error_msg(r.events.take(), "delete").empty());
    }

    r.cmd({{"cmd", "delete"}, {"file", "a-Q2_K.gguf"}});
    const auto evs = r.events.take();
    CHECK(error_msg(evs, "delete").empty());
    CHECK(!fs::exists(r.dir / "a-Q2_K.gguf"));
    CHECK_EQ(evs.size(), 1u);
    CHECK_EQ(evs[0]["ev"], "models");
    CHECK(!has_file(evs[0], "a-Q2_K.gguf"));
    CHECK(has_file(evs[0], "a-Q8_0.gguf"));
}

void test_downloads() {
    Rig r("ils_test_hub_dl");

    // A download from start to end.
    const auto t0 = std::chrono::steady_clock::now();
    r.cmd_wait({{"cmd", "download"}, {"repo", "user/repo-GGUF"}, {"path", "sub/new-Q8_0.gguf"}});
    const double secs = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
    {
        const auto evs = r.events.take();
        std::vector<std::string> states;
        int running = 0;
        uint64_t last_done = 0;
        for (const json& e : evs) {
            if (e["ev"] != "download") continue;
            CHECK_EQ(e["repo"], "user/repo-GGUF");
            CHECK_EQ(e["path"], "sub/new-Q8_0.gguf");
            CHECK_EQ(e["file"], "new-Q8_0.gguf");
            if (e["state"] == "running") {
                ++running;
                last_done = e["done"];
            }
            if (states.empty() || states.back() != e["state"]) states.push_back(e["state"]);
        }
        CHECK((states == std::vector<std::string>{"queued", "running", "done"}));
        CHECK(running >= 2);                                    // the start and some progress
        CHECK(running <= 2 + static_cast<int>(secs * 4) + 1);  // at most ~4 per second
        CHECK(last_done > 0);
        // The queue event lists it; the last one lists the file and an empty queue.
        bool listed_queued = false;
        for (const json& e : evs) {
            if (e["ev"] == "models" && e["downloads"].size() == 1 && e["downloads"][0]["file"] == "new-Q8_0.gguf")
                listed_queued = true;
        }
        CHECK(listed_queued);
    }
    const json m = json::parse(r.hub->connect_events()[0]);
    CHECK(has_file(m, "new-Q8_0.gguf"));
    CHECK(m["downloads"].empty());
    CHECK(fs::exists(r.dir / "new-Q8_0.gguf"));

    // Refused: an existing file, a bad repo or path.
    for (const json& bad : {json{{"cmd", "download"}, {"repo", "user/repo"}, {"path", "a-Q8_0.gguf"}},
                            json{{"cmd", "download"}, {"repo", "bad repo"}, {"path", "x.gguf"}},
                            json{{"cmd", "download"}, {"repo", "user/repo"}, {"path", "../x.gguf"}},
                            json{{"cmd", "download"}, {"repo", "user/repo"}, {"path", "x.bin"}},
                            json{{"cmd", "download"}, {"repo", "user/repo"}}}) {
        r.cmd(bad);
        const auto evs = r.events.take();
        CHECK_EQ(evs.size(), 1u);
        CHECK(!error_msg(evs, "download").empty());
    }

    // A queue: a slow one running, then a second. Duplicates are refused.
    r.cmd({{"cmd", "download"}, {"repo", "user/slow"}, {"path", "s1.gguf"}});
    r.cmd({{"cmd", "download"}, {"repo", "user/r2"}, {"path", "q2.gguf"}});
    r.cmd({{"cmd", "download"}, {"repo", "user/slow"}, {"path", "s1.gguf"}});
    r.cmd({{"cmd", "download"}, {"repo", "other/repo"}, {"path", "dir/s1.gguf"}});  // same file name
    std::this_thread::sleep_for(100ms);
    {
        const auto evs = r.events.take();
        int refused = 0;
        for (const json& e : evs) refused += e["ev"] == "error" ? 1 : 0;
        CHECK_EQ(refused, 2);
        json last_models;
        for (const json& e : evs) {
            if (e["ev"] == "models") last_models = e;
        }
        CHECK_EQ(last_models["downloads"].size(), 2u);
        CHECK_EQ(last_models["downloads"][0]["state"], "running");
        CHECK_EQ(last_models["downloads"][1]["state"], "queued");
    }

    // Cancel the queued one, then the running one.
    r.cmd({{"cmd", "cancel_download"}, {"repo", "user/r2"}, {"path", "q2.gguf"}});
    {
        const auto evs = r.events.take();
        bool cancelled = false;
        for (const json& e : evs) {
            if (e["ev"] == "download" && e["file"] == "q2.gguf" && e["state"] == "cancelled") cancelled = true;
        }
        CHECK(cancelled);
    }
    r.cmd({{"cmd", "cancel_download"}, {"repo", "user/slow"}, {"path", "s1.gguf"}});
    CHECK(r.hub->wait_idle(5s));
    {
        const auto evs = r.events.take();
        bool cancelled = false;
        for (const json& e : evs) {
            if (e["ev"] == "download" && e["file"] == "s1.gguf" && e["state"] == "cancelled") cancelled = true;
        }
        CHECK(cancelled);
    }
    CHECK(!fs::exists(r.dir / "s1.gguf"));
    CHECK(!fs::exists(r.dir / "q2.gguf"));
    r.cmd({{"cmd", "cancel_download"}, {"repo", "user/slow"}, {"path", "s1.gguf"}});
    CHECK(!error_msg(r.events.take(), "cancel_download").empty());

    // A failing transfer.
    r.cmd_wait({{"cmd", "download"}, {"repo", "user/fail"}, {"path", "f.gguf"}});
    {
        const auto evs = r.events.take();
        bool failed = false;
        for (const json& e : evs) {
            if (e["ev"] == "download" && e["state"] == "error") failed = contains(e["msg"], "404");
        }
        CHECK(failed);
        CHECK(json::parse(r.hub->connect_events()[0])["downloads"].empty());
    }

    // `models` rescans: a file copied in by hand appears.
    fs::copy_file(r.dir / "a-Q8_0.gguf", r.dir / "by-hand.gguf");
    r.cmd({{"cmd", "models"}});
    CHECK(has_file(r.events.last("models"), "by-hand.gguf"));
}

void test_downloads_disabled() {
    Rig r("ils_test_hub_nodl", /*downloads=*/false);
    CHECK_EQ(json::parse(r.hub->connect_events()[0])["download"], false);
    r.cmd({{"cmd", "download"}, {"repo", "user/repo"}, {"path", "x.gguf"}});
    CHECK(!error_msg(r.events.take(), "download").empty());
}

void test_load_paths() {
    Rig r("ils_test_hub_paths");
    // A model from another folder: listed by its file name, its VRAM counted.
    const fs::path elsewhere = fs::temp_directory_path() / "ils_test_hub_elsewhere";
    fs::remove_all(elsewhere);
    fs::create_directories(elsewhere);
    write_fixture_gguf(elsewhere / "far-Q8_0.gguf", family(7));

    r.hub->load_paths((elsewhere / "far-Q8_0.gguf").string(), "");
    const json m = json::parse(r.hub->connect_events()[0]);
    CHECK_EQ(m["loaded"]["a"], "far-Q8_0.gguf");
    CHECK(!has_file(m, "far-Q8_0.gguf"));
    CHECK_EQ(m["gpu"]["available"], kGpuFree + vram_of(elsewhere / "far-Q8_0.gguf"));
    CHECK_EQ(r.hello()["models"][0]["file"], "far-Q8_0.gguf");

    // A failure throws and leaves nothing loaded.
    bool threw = false;
    try {
        r.hub->load_paths((r.dir / "a-Q8_0.gguf").string(), (r.dir / "fail-Q4_0.gguf").string());
    } catch (const std::runtime_error&) {
        threw = true;
    }
    CHECK(threw);
    CHECK_EQ(r.backend.live_now(), 0);
    CHECK(json::parse(r.hub->connect_events()[0])["loaded"]["a"].is_null());
    fs::remove_all(elsewhere);
}

}  // namespace

int main() {
    test_start_empty_and_load_one();
    test_pairs_and_reuse();
    test_failures_and_names();
    test_delete();
    test_downloads();
    test_downloads_disabled();
    test_load_paths();
    return test_result();
}
