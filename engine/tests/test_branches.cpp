// Branches with a real model on the GPU:
//   - branching, going back to the original path and continuing gives the
//     same text as never having branched;
//   - 20 placements on nodes already evaluated, checked by verify_seek, give
//     no mismatch and no approximate placement;
//   - the same with gates and a seed (the joint check of gates and branches).
// Run with a recurrent model that cannot trim its context (Qwen3.5) and with
// one that can (Gemma 4).
// Usage: test_branches <model.gguf>
#include "check.h"
#include "frames.h"
#include "log.h"
#include "model.h"
#include "session.h"

#include <nlohmann/json.hpp>

#include <chrono>
#include <cstdio>
#include <exception>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

using namespace ils;
using json = nlohmann::json;

namespace {

constexpr const char* PROMPT =
    "The history of computing is a long story of people trying to make machines "
    "do arithmetic faster than they could themselves. It begins, in most tellings, with";
constexpr uint32_t MAX_TOKENS = 96;
constexpr int PLACEMENTS = 20;
const auto TIMEOUT = std::chrono::seconds(90);

uint32_t u32(const uint8_t* p) {
    return uint32_t(p[0]) | uint32_t(p[1]) << 8 | uint32_t(p[2]) << 16 | uint32_t(p[3]) << 24;
}
uint16_t u16(const uint8_t* p) { return uint16_t(p[0] | p[1] << 8); }

struct NodeRec {
    uint32_t parent = NONE;
    uint32_t token = 0;
    uint8_t origin = 0;
};

// The tree and the cursor a log describes.
struct Seen {
    std::vector<NodeRec> nodes;                          // by node id
    std::map<uint32_t, std::vector<uint32_t>> candidates;  // EVAL tokens by node
    std::map<uint32_t, uint8_t> attr;                    // VOCAB
    uint32_t cursor = NONE;                              // A's
    size_t evals = 0;

    // Node ids from the root to `node`.
    std::vector<uint32_t> path(uint32_t node) const {
        std::vector<uint32_t> p;
        for (uint32_t n = node; n != NONE && n < nodes.size(); n = nodes[n].parent) p.insert(p.begin(), n);
        return p;
    }

    // The tokens the models or the user chose on the way to `node`.
    std::vector<uint32_t> generated(uint32_t node) const {
        std::vector<uint32_t> out;
        for (uint32_t n : path(node))
            if (nodes[n].origin != ORIGIN_PROMPT) out.push_back(nodes[n].token);
        return out;
    }
};

Seen read_log(const Log& log) {
    Seen s;
    const Bytes bytes = log.snapshot();
    std::vector<FrameView> frames;
    CHECK(split_frames(bytes, frames));
    for (const FrameView& f : frames) {
        const uint8_t* b = f.body;
        if (f.type == FrameType::Vocab) {
            const uint32_t count = u32(b);
            size_t off = 4;
            for (uint32_t i = 0; i < count && off + 7 <= f.length; ++i) {
                s.attr[u32(b + off)] = b[off + 4];
                off += 7 + u16(b + off + 5);
            }
        } else if (f.type == FrameType::Node) {
            const uint32_t id = u32(b);
            if (s.nodes.size() <= id) s.nodes.resize(id + 1);
            s.nodes[id] = {u32(b + 4), u32(b + 8), b[16]};
        } else if (f.type == FrameType::Eval) {
            const size_t n = size_t(b[5]) + b[6];  // n_raw + n_extra
            std::vector<uint32_t> tokens;
            for (size_t i = 0; i < n; ++i) tokens.push_back(u32(b + 24 + 8 * i));
            s.candidates[u32(b)] = tokens;
            ++s.evals;
        } else if (f.type == FrameType::Cursor) {
            s.cursor = u32(b);
        }
    }
    return s;
}

struct Events {
    std::mutex mu;
    std::vector<std::string> errors, warnings;
};

void post(Session& session, const json& cmd) {
    session.post(cmd.dump());
    CHECK(session.wait_idle(TIMEOUT));
}

void steps(Session& session, int n) {
    for (int i = 0; i < n; ++i) session.post(R"({"cmd":"step"})");
    CHECK(session.wait_idle(TIMEOUT));
}

// One scenario with `gates` (empty: the most likely token) and `seed`.
void scenario(const char* name, Session& session, const Log& log, Events& events, const json& gates, uint32_t seed) {
    json config = {{"max_tokens", MAX_TOKENS}, {"seed", seed}};
    if (!gates.empty()) config["gates"] = gates;
    const json start = {{"cmd", "start"}, {"prompt", PROMPT}, {"format", "raw"}, {"config", config}};
    const SeekStats before = session.seek_stats();

    // The reference: straight to the end.
    post(session, start);
    post(session, {{"cmd", "run"}});
    const Seen ref = read_log(log);
    const std::vector<uint32_t> want = ref.generated(ref.cursor);
    CHECK(want.size() >= 32);
    if (want.size() < 32) return;
    const int half = static_cast<int>(want.size() / 2);

    // Again: half of it, a branch from a quarter, a few steps there, back
    // to where the original path was left, and on to the end.
    post(session, start);
    steps(session, half);
    const Seen mid = read_log(log);
    const std::vector<uint32_t> p = mid.path(mid.cursor);
    const size_t prompt_len = p.size() - static_cast<size_t>(half);
    const size_t at = prompt_len - 1 + static_cast<size_t>(half / 2);  // the parent, in the path
    const uint32_t parent = p[at];
    const uint32_t taken = mid.nodes[p[at + 1]].token;
    uint32_t alt = NONE;
    CHECK(mid.candidates.count(parent));
    if (mid.candidates.count(parent)) {
        for (uint32_t t : mid.candidates.at(parent)) {
            if (t != taken && mid.attr.count(t) && mid.attr.at(t) == 0) {
                alt = t;
                break;
            }
        }
    }
    CHECK(alt != NONE);
    if (alt == NONE) return;

    const auto t0 = std::chrono::steady_clock::now();
    post(session, {{"cmd", "branch"}, {"node", parent}, {"token", alt}, {"slots", "A"}});
    steps(session, 1);
    const double branch_ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
    steps(session, 5);
    const Seen branched = read_log(log);
    CHECK(branched.cursor != mid.cursor);
    const std::vector<uint32_t> bp = branched.path(branched.cursor);
    CHECK(bp.size() > at + 1 && bp[at] == parent);
    if (bp.size() > at + 1) {
        CHECK_EQ(branched.nodes[bp[at + 1]].token, alt);
        CHECK_EQ(static_cast<int>(branched.nodes[bp[at + 1]].origin), static_cast<int>(ORIGIN_USER));
    }

    post(session, {{"cmd", "goto"}, {"node", mid.cursor}, {"slots", "A"}});
    post(session, {{"cmd", "run"}});
    const Seen done = read_log(log);
    CHECK(done.generated(done.cursor) == want);

    // Placements on nodes of the finished path that already have an EVAL.
    const std::vector<uint32_t> full = done.path(done.cursor);
    const size_t span = full.size() - prompt_len - 1;  // nodes with an EVAL after the prompt's last
    for (int i = 0; i < PLACEMENTS; ++i) {
        const size_t idx = prompt_len - 1 + (static_cast<size_t>(i) * 37 + 5) % span;
        post(session, {{"cmd", "goto"}, {"node", full[idx]}, {"slots", "A"}});
        steps(session, 1);
    }
    const Seen after = read_log(log);
    CHECK_EQ(after.nodes.size(), done.nodes.size());  // every step led to the child it led to before

    const SeekStats stats = session.seek_stats();
    CHECK(stats.verified - before.verified >= static_cast<uint64_t>(PLACEMENTS));
    CHECK_EQ(stats.mismatches, 0u);
    {
        std::lock_guard<std::mutex> lk(events.mu);
        CHECK(events.errors.empty());
        CHECK(events.warnings.empty());
    }
    std::printf("%s: %zu tokens, prompt of %zu; branch and first step in %.0f ms; %llu placements verified, %llu mismatches\n",
                name, want.size(), prompt_len, branch_ms,
                static_cast<unsigned long long>(stats.verified - before.verified),
                static_cast<unsigned long long>(stats.mismatches));
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 2) {
        std::fprintf(stderr, "usage: test_branches <model.gguf>\n");
        return 2;
    }
    std::unique_ptr<Model> model;
    try {
        LlamaOptions opts;
        opts.path = argv[1];
        model = load_llama_model(opts);
    } catch (const std::exception& e) {
        std::fprintf(stderr, "cannot load %s: %s\n", argv[1], e.what());
        return 1;
    }

    Log log;
    Events events;
    Session::Sinks sinks;
    sinks.event = [&](const std::string& ev) {
        std::lock_guard<std::mutex> lk(events.mu);
        std::fprintf(stderr, "event: %s\n", ev.c_str());
        const json j = json::parse(ev, nullptr, /*allow_exceptions=*/false);
        const std::string kind = j.is_object() ? j.value("ev", "") : "error";
        if (kind == "error") events.errors.push_back(ev);
        if (kind == "warning") events.warnings.push_back(ev);
    };
    SessionOptions options;
    options.verify_seek = true;
    {
        Session session(*model, nullptr, log, sinks, {}, options);
        session.post(R"({"cmd":"speed","tps":0})");

        scenario("most likely token", session, log, events, json::array(), 0);

        const json gates = json::array({{{"type", "penalties"}, {"repeat", 1.1}},
                                        {{"type", "top_k"}, {"k", 40}},
                                        {{"type", "top_p"}, {"p", 0.95}},
                                        {{"type", "temp"}, {"t", 0.8}}});
        scenario("gates, seed 1234", session, log, events, gates, 1234);
    }
    return test_result();
}
