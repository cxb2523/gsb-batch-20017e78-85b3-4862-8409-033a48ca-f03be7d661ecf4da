// The coordinator with the fake model: commands, steps, frame order, stop
// conditions, errors and pacing; with two fake models, the lockstep and free
// modes, the comparison and the `config` command; the gates in the steps,
// their state along the path and the all-or-nothing `config`; `branch` and
// `goto`, the approximate PAIR, --verify-seek, and the gates after a branch;
// the logit lens in HELLO and EVAL, with one model and with a pair.
#include "check.h"
#include "fake_model.h"
#include "frames.h"
#include "log.h"
#include "metrics.h"
#include "session.h"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

using namespace ils;
using json = nlohmann::json;
using namespace std::chrono_literals;

namespace {

// ------------------------------------------------------------ frame reading

uint32_t u32(const uint8_t* p) { return uint32_t(p[0]) | uint32_t(p[1]) << 8 | uint32_t(p[2]) << 16 | uint32_t(p[3]) << 24; }
float f32(const uint8_t* p) {
    const uint32_t u = u32(p);
    float f;
    std::memcpy(&f, &u, 4);
    return f;
}

// Frame views that keep their buffer alive.
struct Frames : std::vector<FrameView> {
    std::shared_ptr<const Bytes> keep;
};

Frames frames(Bytes b) {
    Frames out;
    out.keep = std::make_shared<const Bytes>(std::move(b));
    CHECK(split_frames(*out.keep, out));
    return out;
}

json body_json(const FrameView& f) { return json::parse(std::string(reinterpret_cast<const char*>(f.body), f.length)); }

NodeRec node_of(const FrameView& f) {
    return {u32(f.body), u32(f.body + 4), u32(f.body + 8), u32(f.body + 12), f.body[16]};
}

struct EvalView {
    uint32_t node;
    uint8_t slot, n_raw, n_extra, n_gates, pick, flags;
    float entropy, raw_mass, decode_ms;
    std::vector<Candidate> entries;
    std::vector<uint32_t> survivors;  // one per gate
    std::vector<float> stage_p;       // n_gates x entries
    std::vector<LensLayer> lens;      // empty without the EVAL_LENS flag
    float stage(size_t g, size_t i) const { return stage_p[g * entries.size() + i]; }
    uint32_t pick_token() const { return entries[pick].token; }
};

EvalView eval_of(const FrameView& f) {
    const uint8_t* b = f.body;
    EvalView e{u32(b), b[4], b[5], b[6], b[7], b[8], b[9], f32(b + 12), f32(b + 16), f32(b + 20), {}, {}, {}, {}};
    const size_t n = size_t(e.n_raw) + e.n_extra;
    for (size_t i = 0; i < n; ++i) e.entries.push_back({u32(b + 24 + 8 * i), f32(b + 28 + 8 * i)});
    size_t pos = 24 + 8 * n;
    for (int g = 0; g < e.n_gates; ++g, pos += 4) e.survivors.push_back(u32(b + pos));
    for (size_t i = 0; i < e.n_gates * n; ++i, pos += 4) e.stage_p.push_back(f32(b + pos));
    if (e.flags & EVAL_LENS) {
        const size_t n_lens = b[pos];
        pos += 4;
        for (size_t i = 0; i < n_lens; ++i, pos += 16) {
            e.lens.push_back({u32(b + pos), f32(b + pos + 4), f32(b + pos + 8), f32(b + pos + 12)});
        }
    }
    CHECK_EQ(pos, size_t(f.length));
    return e;
}

std::vector<VocabEntry> vocab_of(const FrameView& f) {
    std::vector<VocabEntry> out;
    const uint32_t n = u32(f.body);
    size_t pos = 4;
    for (uint32_t i = 0; i < n; ++i) {
        VocabEntry e;
        e.token = u32(f.body + pos);
        e.attr = f.body[pos + 4];
        const uint16_t len = uint16_t(f.body[pos + 5] | f.body[pos + 6] << 8);
        e.bytes.assign(reinterpret_cast<const char*>(f.body + pos + 7), len);
        out.push_back(e);
        pos += 7 + len;
    }
    return out;
}

// The batches of a log, one per append (a read of 1 byte returns one batch).
std::vector<Bytes> batches(const Log& log) {
    std::vector<Bytes> out;
    const uint64_t epoch = log.epoch();
    size_t offset = 0;
    for (;;) {
        Log::Chunk c = log.read(epoch, offset, 1);
        if (c.bytes.empty()) break;
        out.push_back(c.bytes);
        offset = c.next;
    }
    return out;
}

std::vector<FrameType> types(const Bytes& b) {
    std::vector<FrameType> out;
    for (const FrameView& f : frames(b)) out.push_back(f.type);
    return out;
}

struct PairView {
    uint32_t node;
    float js, kl_ab, kl_ba;
    uint32_t rank_a_in_b, rank_b_in_a;
    uint8_t flags;
};

PairView pair_of(const FrameView& f) {
    const uint8_t* b = f.body;
    return {u32(b), f32(b + 4), f32(b + 8), f32(b + 12), u32(b + 16), u32(b + 20), b[24]};
}

// The gates of an EVAL against the protocol contract: at most 8 added
// candidates, none of them a main one; survivors never grow; each row of
// stage_p is a part of a distribution; the pick is alive at the last gate.
void check_eval_gates(const EvalView& e, uint32_t n_vocab) {
    CHECK(e.n_extra <= 8);
    std::set<uint32_t> seen;
    for (const Candidate& c : e.entries) CHECK(seen.insert(c.token).second);
    for (const Candidate& c : e.entries) CHECK(c.p_raw >= 0 && c.p_raw <= 1);
    CHECK_EQ(e.survivors.size(), size_t(e.n_gates));
    CHECK_EQ(e.stage_p.size(), e.n_gates * e.entries.size());
    if (e.stage_p.size() != e.n_gates * e.entries.size()) return;
    for (size_t g = 0; g < e.n_gates; ++g) {
        CHECK(e.survivors[g] >= 1 && e.survivors[g] <= n_vocab);
        if (g > 0) CHECK(e.survivors[g] <= e.survivors[g - 1]);
        double sum = 0;
        for (size_t i = 0; i < e.entries.size(); ++i) {
            CHECK(e.stage(g, i) >= 0 && e.stage(g, i) <= 1.0001f);
            sum += e.stage(g, i);
        }
        CHECK(sum <= 1.0001);
    }
    if (e.n_gates > 0) CHECK(e.stage(e.n_gates - 1, e.pick) > 0);
    else CHECK_EQ(e.pick, 0);  // no gates: the most likely candidate
}

// Checks the rules every protocol log must follow on a whole log, and
// that every token goes in a VOCAB only once. With one model: slot A only, no
// B cursor and no PAIR. With two: an exact PAIR comes right after EVAL(A) and
// EVAL(B) of its node; an approximate one comes in the step of the later of
// the two EVALs (among the EVAL and PAIR frames right before it), never for a
// node with an exact PAIR, and its numbers are those of the two lists. Every
// EVAL has the gates of the CONFIG before it, and the lens section exactly
// when HELLO says the lens is on, with one entry per layer and every token
// in a VOCAB before.
void check_log_rules(const Bytes& log, int n_models = 1) {
    const Frames fs = frames(log);
    CHECK(fs.size() >= 2);
    if (fs.size() < 2) return;
    CHECK(fs[0].type == FrameType::Hello);
    CHECK(fs[1].type == FrameType::Config);
    const json hello = body_json(fs[0]);
    const uint32_t n_vocab = hello["n_vocab"];
    const bool lens_on = hello["lens"]["enabled"];
    const size_t n_lens = hello["lens"]["layers"].size();
    CHECK_EQ(lens_on, n_lens > 0);
    size_t n_gates = 0;  // of the CONFIG in force

    std::set<uint32_t> vocab;
    std::vector<NodeRec> nodes;
    std::map<std::pair<uint32_t, uint8_t>, EvalView> last_eval;  // (node, slot) -> its last EVAL
    std::set<uint32_t> exact;                                      // nodes with an exact PAIR
    bool model_nodes_seen = false;
    auto known_node = [&](uint32_t id) { return id < nodes.size(); };
    for (size_t i = 0; i < fs.size(); ++i) {
        const FrameView& f = fs[i];
        switch (f.type) {
            case FrameType::Hello:
                CHECK_EQ(i, 0u);
                break;
            case FrameType::Config:
                n_gates = body_json(f)["gates"].size();
                break;
            case FrameType::Vocab:
                for (const VocabEntry& e : vocab_of(f)) CHECK(vocab.insert(e.token).second);
                break;
            case FrameType::Node: {
                const NodeRec n = node_of(f);
                CHECK_EQ(n.id, nodes.size());
                CHECK(vocab.count(n.token));
                if (n.parent == NONE) {
                    CHECK_EQ(n.depth, 0u);
                } else {
                    CHECK(known_node(n.parent));
                    if (known_node(n.parent)) CHECK_EQ(n.depth, nodes[n.parent].depth + 1);
                }
                if (n.origin == ORIGIN_PROMPT) {
                    CHECK(!model_nodes_seen);  // the prompt is one chain, first
                    CHECK_EQ(n.parent, nodes.empty() ? NONE : static_cast<uint32_t>(nodes.size() - 1));
                } else {
                    model_nodes_seen = true;
                }
                nodes.push_back(n);
                break;
            }
            case FrameType::Eval: {
                const EvalView e = eval_of(f);
                CHECK(known_node(e.node));
                CHECK(n_models == 2 ? e.slot <= SLOT_B : e.slot == SLOT_A);
                CHECK_EQ(size_t(e.n_gates), n_gates);
                CHECK(e.pick < e.entries.size());
                for (const Candidate& c : e.entries) CHECK(vocab.count(c.token));
                check_eval_gates(e, n_vocab);
                CHECK_EQ(e.lens.size(), lens_on ? n_lens : 0);
                for (const LensLayer& l : e.lens) {
                    CHECK(vocab.count(l.top_id));
                    CHECK(l.top_p >= 0 && l.top_p <= 1 && l.answer_p >= 0 && l.answer_p <= l.top_p);
                    CHECK(l.entropy >= 0);
                }
                last_eval[{e.node, e.slot}] = e;
                break;
            }
            case FrameType::Cursor:
                CHECK(known_node(u32(f.body)));
                if (n_models == 2) CHECK(known_node(u32(f.body + 4)));
                else CHECK_EQ(u32(f.body + 4), NONE);
                break;
            case FrameType::Stop:
                CHECK(known_node(u32(f.body)));
                CHECK(n_models == 2 ? f.body[4] <= SLOT_BOTH : f.body[4] == SLOT_A);
                break;
            case FrameType::Pair: {
                CHECK_EQ(n_models, 2);
                const PairView p = pair_of(f);
                CHECK(known_node(p.node));
                CHECK(p.js >= 0 && p.js <= 1);
                CHECK(p.kl_ab >= 0 && p.kl_ba >= 0);
                if (p.flags & PAIR_APPROX) {
                    CHECK(!exact.count(p.node));
                    bool in_step = false;
                    for (size_t k = i; k-- > 0 && (fs[k].type == FrameType::Eval || fs[k].type == FrameType::Pair);)
                        if (fs[k].type == FrameType::Eval && eval_of(fs[k]).node == p.node) in_step = true;
                    CHECK(in_step);
                    const auto ia = last_eval.find({p.node, SLOT_A}), ib = last_eval.find({p.node, SLOT_B});
                    CHECK(ia != last_eval.end() && ib != last_eval.end());
                    if (ia == last_eval.end() || ib == last_eval.end()) break;
                    const EvalView &a = ia->second, &b = ib->second;
                    CHECK_EQ((p.flags & PAIR_SAME_PICK) != 0, a.pick_token() == b.pick_token());
                    CHECK_EQ((p.flags & PAIR_SAME_TOP) != 0, a.entries[0].token == b.entries[0].token);
                    const Comparison c = compare_candidates(a.entries, a.n_raw, b.entries, b.n_raw);
                    CHECK_EQ(p.js, static_cast<float>(c.js));
                    CHECK_EQ(p.kl_ab, static_cast<float>(c.kl_ab));
                    CHECK_EQ(p.kl_ba, static_cast<float>(c.kl_ba));
                    // A rank is the position among the other's main candidates, or unknown.
                    auto rank = [](const EvalView& in, uint32_t token) {
                        for (uint32_t r = 0; r < in.n_raw; ++r)
                            if (in.entries[r].token == token) return r;
                        return RANK_UNKNOWN;
                    };
                    CHECK_EQ(p.rank_a_in_b, rank(b, a.entries[0].token));
                    CHECK_EQ(p.rank_b_in_a, rank(a, b.entries[0].token));
                    break;
                }
                if (exact.count(p.node)) {
                    // Written again: a model evaluated the node once more and
                    // its pick changed the "same pick" bit.
                    bool in_step = false;
                    for (size_t k = i; k-- > 0 && (fs[k].type == FrameType::Eval || fs[k].type == FrameType::Pair);)
                        if (fs[k].type == FrameType::Eval && eval_of(fs[k]).node == p.node) in_step = true;
                    CHECK(in_step);
                    const auto ia = last_eval.find({p.node, SLOT_A}), ib = last_eval.find({p.node, SLOT_B});
                    CHECK(ia != last_eval.end() && ib != last_eval.end());
                    if (ia != last_eval.end() && ib != last_eval.end())
                        CHECK_EQ((p.flags & PAIR_SAME_PICK) != 0, ia->second.pick_token() == ib->second.pick_token());
                    break;
                }
                exact.insert(p.node);
                CHECK(i >= 2);
                if (i < 2) break;
                CHECK(fs[i - 2].type == FrameType::Eval && fs[i - 1].type == FrameType::Eval);
                if (fs[i - 2].type != FrameType::Eval || fs[i - 1].type != FrameType::Eval) break;
                const EvalView a = eval_of(fs[i - 2]), b = eval_of(fs[i - 1]);
                CHECK(a.slot == SLOT_A && b.slot == SLOT_B);
                CHECK(a.node == p.node && b.node == p.node);
                CHECK_EQ((p.flags & PAIR_SAME_PICK) != 0, a.entries[a.pick].token == b.entries[b.pick].token);
                CHECK_EQ((p.flags & PAIR_SAME_TOP) != 0, a.entries[0].token == b.entries[0].token);
                break;
            }
            default:
                break;
        }
    }
}

// The tokens of the nodes made by the model, in order.
std::vector<uint32_t> model_tokens(const Bytes& log) {
    std::vector<uint32_t> out;
    for (const FrameView& f : frames(log)) {
        if (f.type == FrameType::Node && node_of(f).origin == ORIGIN_MODEL) out.push_back(node_of(f).token);
    }
    return out;
}

// ------------------------------------------------------------------ sinks

struct Events {
    std::mutex mu;
    std::vector<json> list;
    int statuses = 0;

    Session::Sinks sinks() {
        return {[this](const std::string& s) {
                    std::lock_guard<std::mutex> lk(mu);
                    list.push_back(json::parse(s));
                },
                [this] {
                    std::lock_guard<std::mutex> lk(mu);
                    ++statuses;
                }};
    }
    std::vector<json> take() {
        std::lock_guard<std::mutex> lk(mu);
        std::vector<json> out;
        out.swap(list);
        return out;
    }
    int status_count() {
        std::lock_guard<std::mutex> lk(mu);
        return statuses;
    }
};

// One `error` event for command `cmd`, and nothing else.
bool one_error(Events& ev, const std::string& cmd) {
    const std::vector<json> l = ev.take();
    return l.size() == 1 && l[0].value("ev", "") == "error" && l[0].contains("cmd") && l[0].value("cmd", "?") == cmd &&
           l[0]["msg"].is_string() && !l[0]["msg"].get<std::string>().empty();
}

json start_cmd(const std::string& prompt, json config = nullptr) {
    json j = {{"cmd", "start"}, {"prompt", prompt}};
    if (!config.is_null()) j["config"] = config;
    return j;
}

void send(Session& s, const json& j) { s.post(j.dump()); }

bool idle(Session& s) { return s.wait_idle(10s); }

json config_cmd(const json& config) { return {{"cmd", "config"}, {"config", config}}; }

json gate(const char* type, json params = json::object()) {
    params["type"] = type;
    return params;
}

// The toy grammar of FakeModel admits the tokens made only of its bytes.
const std::string LOWER = " abcdefghijklmnopqrstuvwxyz";

std::vector<EvalView> evals(const Bytes& log) {
    std::vector<EvalView> out;
    for (const FrameView& f : frames(log))
        if (f.type == FrameType::Eval) out.push_back(eval_of(f));
    return out;
}

// The body of the last CONFIG of a log.
json last_config(const Bytes& log) {
    json c;
    for (const FrameView& f : frames(log))
        if (f.type == FrameType::Config) c = body_json(f);
    return c;
}

// The text of each token, from the VOCAB frames of a log.
std::map<uint32_t, std::string> texts(const Bytes& log) {
    std::map<uint32_t, std::string> out;
    for (const FrameView& f : frames(log))
        if (f.type == FrameType::Vocab)
            for (const VocabEntry& e : vocab_of(f)) out[e.token] = e.bytes;
    return out;
}

// The tokens from the root to `node`, from the NODE frames of a log.
std::vector<int32_t> path_to(const Bytes& log, uint32_t node) {
    std::map<uint32_t, NodeRec> nodes;
    for (const FrameView& f : frames(log))
        if (f.type == FrameType::Node) nodes[node_of(f).id] = node_of(f);
    std::vector<int32_t> out;
    for (uint32_t id = node; id != NONE && nodes.count(id); id = nodes[id].parent)
        out.insert(out.begin(), static_cast<int32_t>(nodes[id].token));
    return out;
}

// The tokens the gates of type `type` of a fake model have accepted, in order.
std::vector<int32_t> accepted_by(const FakeModel& m, const std::string& type) {
    std::vector<int32_t> out;
    for (const auto& [t, tok] : m.accepted)
        if (t == type) out.push_back(tok);
    return out;
}

// ------------------------------------------------------------------- tests

void test_stop_reason() {
    // prompt of 5 tokens: depths 0..4
    CHECK(!stop_reason(4, 5, ORIGIN_PROMPT, true, 100, 64));            // a prompt token never ends generation
    CHECK(stop_reason(5, 5, ORIGIN_MODEL, true, 100, 64) == StopReason::EndOfGeneration);
    CHECK(stop_reason(5, 5, ORIGIN_USER, true, 100, 64) == StopReason::EndOfGeneration);
    CHECK(stop_reason(4, 5, ORIGIN_PROMPT, false, 0, 64) == StopReason::MaxTokens);  // 0 generated >= 0
    CHECK(!stop_reason(4, 5, ORIGIN_PROMPT, false, 1, 64));
    CHECK(stop_reason(5, 5, ORIGIN_MODEL, false, 1, 64) == StopReason::MaxTokens);   // 1 generated
    CHECK(!stop_reason(5, 5, ORIGIN_MODEL, false, 2, 64));
    CHECK(stop_reason(24, 5, ORIGIN_MODEL, false, 20, 64) == StopReason::MaxTokens);
    CHECK(!stop_reason(23, 5, ORIGIN_MODEL, false, 20, 64));
    CHECK(stop_reason(64, 5, ORIGIN_MODEL, false, 1000, 64) == StopReason::ContextFull);
    CHECK(!stop_reason(63, 5, ORIGIN_MODEL, false, 1000, 64));
    CHECK(stop_reason(24, 5, ORIGIN_MODEL, true, 20, 10) == StopReason::EndOfGeneration);  // precedence
    CHECK(stop_reason(24, 5, ORIGIN_MODEL, false, 20, 10) == StopReason::MaxTokens);
}

void test_startup() {
    FakeModel model;
    Log log;
    Events ev;
    Session s(model, nullptr, log, ev.sinks());
    const Frames fs = frames(log.snapshot());
    CHECK_EQ(fs.size(), 2u);
    CHECK_EQ(batches(log).size(), 1u);
    CHECK(fs[0].type == FrameType::Hello && fs[0].t_ms == 0);
    CHECK(fs[1].type == FrameType::Config && fs[1].t_ms == 0);
    const json h = body_json(fs[0]);
    CHECK_EQ(h["protocol"], 1);
    CHECK_EQ(h["app"].get<std::string>(), std::string(ILS_APP_VERSION));
    CHECK_EQ(h["llama_cpp"].get<std::string>(), std::string("fake"));
    const std::string created = h["created"];
    CHECK(created.size() == 20 && created[4] == '-' && created[10] == 'T' && created[19] == 'Z');
    CHECK_EQ(h["n_vocab"], model.n_vocab());
    CHECK_EQ(h["n_raw"], 32);
    CHECK_EQ(h["models"].size(), 1u);
    CHECK_EQ(h["models"][0]["slot"].get<std::string>(), std::string("A"));
    CHECK_EQ(h["models"][0]["file"].get<std::string>(), std::string("fake.gguf"));
    CHECK_EQ(h["lens"]["enabled"].get<bool>(), false);  // the lens is off unless asked for
    CHECK(h["lens"]["layers"].empty());
    const json c = body_json(fs[1]);
    CHECK_EQ(c["max_tokens"], 256);
    CHECK_EQ(c["gates"].size(), 0u);
    const Status st = s.status();
    CHECK(st.state == RunState::Idle);
    CHECK_EQ(st.tps_limit, DEFAULT_TPS_LIMIT);
    CHECK_EQ(st.nodes, 0u);
    CHECK(model.n_vocab() >= 300);
}

void test_start_raw_and_step() {
    FakeModel model;
    Log log;
    Events ev;
    Session s(model, nullptr, log, ev.sinks());
    const uint64_t epoch0 = log.epoch();
    const int statuses0 = ev.status_count();

    send(s, start_cmd("Hello world. <s>caf\xC3\xA9", {{"max_tokens", 40}, {"seed", 7}}));
    CHECK(idle(s));
    CHECK(ev.take().empty());
    CHECK(ev.status_count() > statuses0);
    CHECK_EQ(log.epoch(), epoch0 + 1);
    CHECK(s.status().state == RunState::Paused);

    const std::vector<int32_t> tokens = model.tokenize_prompt("Hello world. <s>caf\xC3\xA9", false, "");
    CHECK_EQ(tokens[0], FakeModel::BOS);
    int bos = 0;
    for (int32_t t : tokens) bos += t == FakeModel::BOS;
    CHECK_EQ(bos, 2);  // raw: "<s>" in the text is parsed
    CHECK_EQ(s.status().nodes, tokens.size());

    // One batch: HELLO CONFIG VOCAB NODE x n CURSOR(p, NONE)
    const std::vector<Bytes> bs = batches(log);
    CHECK_EQ(bs.size(), 1u);
    const Frames fs = frames(log.snapshot());
    CHECK_EQ(fs.size(), 3 + tokens.size() + 1);
    CHECK(fs[0].type == FrameType::Hello);
    CHECK(fs[1].type == FrameType::Config);
    CHECK(fs[2].type == FrameType::Vocab);
    const json c = body_json(fs[1]);
    CHECK_EQ(c["max_tokens"], 40);
    CHECK_EQ(c["seed"], 7);
    std::set<int32_t> distinct(tokens.begin(), tokens.end());
    CHECK_EQ(vocab_of(fs[2]).size(), distinct.size());
    for (size_t i = 0; i < tokens.size(); ++i) {
        CHECK(fs[3 + i].type == FrameType::Node);
        const NodeRec n = node_of(fs[3 + i]);
        CHECK_EQ(n.id, i);
        CHECK_EQ(n.token, static_cast<uint32_t>(tokens[i]));
        CHECK_EQ(n.origin, ORIGIN_PROMPT);
    }
    const FrameView& cur = fs.back();
    CHECK(cur.type == FrameType::Cursor);
    const uint32_t p = static_cast<uint32_t>(tokens.size() - 1);
    CHECK_EQ(u32(cur.body), p);
    CHECK_EQ(u32(cur.body + 4), NONE);

    // A step: [VOCAB] EVAL(A, p) NODE(h) CURSOR(h, NONE)
    send(s, {{"cmd", "step"}});
    CHECK(idle(s));
    CHECK(ev.take().empty());
    CHECK(s.status().state == RunState::Paused);
    std::vector<Bytes> bs2 = batches(log);
    CHECK_EQ(bs2.size(), 2u);
    Frames step = frames(bs2.back());
    CHECK_EQ(step.size(), 4u);
    CHECK(step[0].type == FrameType::Vocab);
    CHECK(step[1].type == FrameType::Eval);
    CHECK(step[2].type == FrameType::Node);
    CHECK(step[3].type == FrameType::Cursor);
    const EvalView e = eval_of(step[1]);
    CHECK_EQ(e.node, p);
    CHECK_EQ(e.n_raw, 32);
    CHECK_EQ(e.n_extra, 0);
    CHECK_EQ(e.n_gates, 0);
    CHECK_EQ(e.pick, 0);
    CHECK(e.entropy > 0);
    double mass = 0;
    for (size_t i = 0; i < e.entries.size(); ++i) {
        mass += e.entries[i].p_raw;
        if (i > 0) CHECK(e.entries[i].p_raw <= e.entries[i - 1].p_raw);
    }
    CHECK_NEAR(e.raw_mass, mass, 1e-4);
    CHECK(e.raw_mass <= 1.0001);
    const NodeRec h = node_of(step[2]);
    CHECK_EQ(h.id, p + 1);
    CHECK_EQ(h.parent, p);
    CHECK_EQ(h.depth, p + 1);
    CHECK_EQ(h.origin, ORIGIN_MODEL);
    CHECK_EQ(h.token, e.entries[0].token);
    CHECK_EQ(h.token, static_cast<uint32_t>(model.script()[0]));
    CHECK_EQ(u32(step[3].body), h.id);
    CHECK_EQ(u32(step[3].body + 4), NONE);
    CHECK_EQ(s.status().nodes, tokens.size() + 1);

    // A second step: tokens already sent are not sent again.
    send(s, {{"cmd", "step"}});
    CHECK(idle(s));
    check_log_rules(log.snapshot());
}

void test_start_chat() {
    FakeModel model;
    Log log;
    Events ev;
    Session s(model, nullptr, log, ev.sinks());
    send(s, {{"cmd", "start"}, {"prompt", "<s>Hi"}, {"format", "chat"}, {"system", "Be brief."}});
    CHECK(idle(s));
    CHECK(ev.take().empty());
    const std::vector<int32_t> expected = model.tokenize_prompt("<s>Hi", true, "Be brief.");
    std::vector<uint32_t> got;
    for (const FrameView& f : frames(log.snapshot())) {
        if (f.type == FrameType::Node) got.push_back(node_of(f).token);
    }
    CHECK_EQ(got.size(), expected.size());
    for (size_t i = 0; i < got.size() && i < expected.size(); ++i) CHECK_EQ(got[i], static_cast<uint32_t>(expected[i]));
    CHECK_EQ(got.front(), static_cast<uint32_t>(FakeModel::BOS));
    CHECK_EQ(got[1], static_cast<uint32_t>(FakeModel::SYS));
    CHECK_EQ(got.back(), static_cast<uint32_t>(FakeModel::ASSISTANT));
    int bos = 0;
    for (uint32_t t : got) bos += t == FakeModel::BOS;
    CHECK_EQ(bos, 1);  // chat: "<s>" inside the user text is not parsed
    check_log_rules(log.snapshot());

    // Without "system" there is no system block.
    send(s, {{"cmd", "start"}, {"prompt", "Hi"}, {"format", "chat"}});
    CHECK(idle(s));
    const Frames fs = frames(log.snapshot());
    CHECK_EQ(node_of(fs[4]).token, static_cast<uint32_t>(FakeModel::USER));
}

void test_max_tokens() {
    FakeModel model;
    Log log;
    Events ev;
    Session s(model, nullptr, log, ev.sinks());
    send(s, {{"cmd", "speed"}, {"tps", 0}});
    send(s, start_cmd("The", {{"max_tokens", 20}}));
    send(s, {{"cmd", "run"}});
    CHECK(idle(s));
    CHECK(ev.take().empty());
    CHECK(s.status().state == RunState::Paused);
    const Bytes snap = log.snapshot();
    check_log_rules(snap);
    CHECK_EQ(model_tokens(snap).size(), 20u);

    // Every step batch: [VOCAB] EVAL NODE CURSOR [STOP], the last with STOP(max_tokens).
    const std::vector<Bytes> bs = batches(log);
    CHECK_EQ(bs.size(), 21u);
    for (size_t i = 1; i < bs.size(); ++i) {
        std::vector<FrameType> t = types(bs[i]);
        if (!t.empty() && t.front() == FrameType::Vocab) t.erase(t.begin());
        const bool last = i + 1 == bs.size();
        std::vector<FrameType> want = {FrameType::Eval, FrameType::Node, FrameType::Cursor};
        if (last) want.push_back(FrameType::Stop);
        CHECK(t == want);
    }
    const Frames last = frames(bs.back());
    const FrameView& stop = last.back();
    const uint32_t last_node = node_of(last[last.size() - 3]).id;
    CHECK_EQ(u32(stop.body), last_node);
    CHECK_EQ(stop.body[4], SLOT_A);
    CHECK_EQ(stop.body[5], static_cast<uint8_t>(StopReason::MaxTokens));

    // run and step fail: the cursor is on a stopped node.
    send(s, {{"cmd", "run"}});
    CHECK(idle(s));
    CHECK(one_error(ev, "run"));
    send(s, {{"cmd", "step"}});
    CHECK(idle(s));
    CHECK(one_error(ev, "step"));
    CHECK(log.snapshot() == snap);
    CHECK(s.status().state == RunState::Paused);
}

void test_end_of_generation() {
    FakeOptions o;
    o.eos_after = 5;
    FakeModel model(o);
    Log log;
    Events ev;
    Session s(model, nullptr, log, ev.sinks());
    send(s, {{"cmd", "speed"}, {"tps", 0}});
    send(s, start_cmd("Once"));
    send(s, {{"cmd", "run"}});
    CHECK(idle(s));
    const Bytes snap = log.snapshot();
    check_log_rules(snap);
    const std::vector<uint32_t> toks = model_tokens(snap);
    CHECK_EQ(toks.size(), 6u);
    CHECK_EQ(toks.back(), static_cast<uint32_t>(FakeModel::EOS));
    const Frames fs = frames(snap);
    CHECK(fs.back().type == FrameType::Stop);
    CHECK_EQ(fs.back().body[5], static_cast<uint8_t>(StopReason::EndOfGeneration));
    send(s, {{"cmd", "run"}});
    CHECK(idle(s));
    CHECK(one_error(ev, "run"));
}

void test_context_full() {
    FakeOptions o;
    o.n_ctx = 12;
    FakeModel model(o);
    Log log;
    Events ev;
    Session s(model, nullptr, log, ev.sinks());
    send(s, {{"cmd", "speed"}, {"tps", 0}});
    send(s, start_cmd(" the dog", {{"max_tokens", 1000}}));  // <s> " the" " dog"
    send(s, {{"cmd", "run"}});
    CHECK(idle(s));
    const Bytes snap = log.snapshot();
    check_log_rules(snap);
    const Frames fs = frames(snap);
    CHECK(fs.back().type == FrameType::Stop);
    CHECK_EQ(fs.back().body[5], static_cast<uint8_t>(StopReason::ContextFull));
    uint32_t max_depth = 0;
    for (const FrameView& f : fs) {
        if (f.type == FrameType::Node) max_depth = std::max(max_depth, node_of(f).depth);
    }
    CHECK_EQ(max_depth, 12u);
    CHECK(ev.take().empty());
}

void test_decode_failure() {
    FakeOptions o;
    o.fail_at_eval = 3;
    FakeModel model(o);
    Log log;
    Events ev;
    Session s(model, nullptr, log, ev.sinks());
    send(s, start_cmd("Hello"));
    send(s, {{"cmd", "step"}});
    send(s, {{"cmd", "step"}});
    CHECK(idle(s));
    CHECK(ev.take().empty());
    const Bytes before = log.snapshot();
    const uint64_t epoch = log.epoch();

    send(s, {{"cmd", "speed"}, {"tps", 0}});
    send(s, {{"cmd", "run"}});  // the third eval throws
    CHECK(idle(s));
    const std::vector<json> l = ev.take();
    CHECK_EQ(l.size(), 1u);
    if (!l.empty()) {
        CHECK_EQ(l[0]["ev"].get<std::string>(), std::string("error"));
        CHECK(!l[0].contains("cmd"));
    }
    CHECK(s.status().state == RunState::Paused);
    CHECK(log.snapshot() == before);
    CHECK_EQ(log.epoch(), epoch);

    // The next one works and continues from the same node.
    send(s, {{"cmd", "step"}});
    CHECK(idle(s));
    CHECK(ev.take().empty());
    CHECK_EQ(model_tokens(log.snapshot()).size(), 3u);
    check_log_rules(log.snapshot());
}

void test_determinism_and_epoch() {
    FakeModel model;
    Log log;
    Events ev;
    Session s(model, nullptr, log, ev.sinks());
    send(s, {{"cmd", "speed"}, {"tps", 0}});
    send(s, start_cmd("Tell me a story", {{"max_tokens", 30}}));
    send(s, {{"cmd", "run"}});
    CHECK(idle(s));
    const std::vector<uint32_t> first = model_tokens(log.snapshot());
    const uint64_t epoch = log.epoch();

    send(s, start_cmd("Tell me a story", {{"max_tokens", 30}}));
    CHECK(idle(s));
    CHECK_EQ(log.epoch(), epoch + 1);
    const Frames fs = frames(log.snapshot());
    CHECK(fs[0].type == FrameType::Hello);
    CHECK(model_tokens(log.snapshot()).empty());
    send(s, {{"cmd", "run"}});
    CHECK(idle(s));
    CHECK_EQ(first.size(), 30u);
    CHECK(model_tokens(log.snapshot()) == first);

    // Another model and session, same prompt: same tokens.
    FakeModel model2;
    Log log2;
    Session s2(model2, nullptr, log2);
    send(s2, {{"cmd", "speed"}, {"tps", 0}});
    send(s2, start_cmd("Tell me a story", {{"max_tokens", 30}}));
    send(s2, {{"cmd", "run"}});
    CHECK(idle(s2));
    CHECK(model_tokens(log2.snapshot()) == first);

    // The entropy moves: some positions are sure, some doubtful.
    float lo = 100, hi = 0;
    for (const FrameView& f : frames(log.snapshot())) {
        if (f.type != FrameType::Eval) continue;
        const EvalView e = eval_of(f);
        lo = std::min(lo, e.entries[0].p_raw);
        hi = std::max(hi, e.entries[0].p_raw);
    }
    CHECK(lo < 0.6f);
    CHECK(hi > 0.95f);
}

void test_speed_and_pacing() {
    FakeModel model;
    Log log;
    Events ev;
    Session s(model, nullptr, log, ev.sinks());
    send(s, {{"cmd", "speed"}, {"tps", 5}});
    CHECK(idle(s));
    CHECK_EQ(s.status().tps_limit, 5.0);
    send(s, {{"cmd", "speed"}, {"tps", -1}});
    CHECK(idle(s));
    CHECK(one_error(ev, "speed"));
    send(s, {{"cmd", "speed"}, {"tps", "fast"}});
    CHECK(idle(s));
    CHECK(one_error(ev, "speed"));
    send(s, {{"cmd", "speed"}});
    CHECK(idle(s));
    CHECK(one_error(ev, "speed"));
    CHECK_EQ(s.status().tps_limit, 5.0);

    // 20 tokens per second: 6 steps take at least 5 intervals of 50 ms.
    send(s, {{"cmd", "speed"}, {"tps", 20}});
    send(s, start_cmd("Go", {{"max_tokens", 6}}));
    CHECK(idle(s));
    auto t0 = std::chrono::steady_clock::now();
    send(s, {{"cmd", "run"}});
    CHECK(idle(s));
    const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
    CHECK(ms >= 240);
    CHECK(ms < 2000);
    CHECK_EQ(model_tokens(log.snapshot()).size(), 6u);

    // A command cuts the wait between two steps short.
    send(s, {{"cmd", "speed"}, {"tps", 0.5}});
    send(s, start_cmd("Go", {{"max_tokens", 100}}));
    send(s, {{"cmd", "step"}});
    CHECK(idle(s));
    send(s, {{"cmd", "run"}});  // the next step is due in 2 s
    std::this_thread::sleep_for(100ms);
    CHECK(s.status().state == RunState::Running);
    t0 = std::chrono::steady_clock::now();
    send(s, {{"cmd", "pause"}});
    CHECK(s.wait_idle(1000ms));
    CHECK(std::chrono::steady_clock::now() - t0 < 500ms);
    CHECK(s.status().state == RunState::Paused);
    CHECK_EQ(model_tokens(log.snapshot()).size(), 1u);

    // Measured speed and the status once a second while running.
    send(s, {{"cmd", "speed"}, {"tps", 40}});
    send(s, {{"cmd", "run"}});
    const int statuses = ev.status_count();
    std::this_thread::sleep_for(1300ms);
    const Status st = s.status();
    CHECK(st.state == RunState::Running);
    CHECK(st.tps >= 20 && st.tps <= 45);
    CHECK(ev.status_count() > statuses);
    send(s, {{"cmd", "pause"}});
    CHECK(idle(s));
    CHECK_EQ(s.status().tps, 0.0);
    CHECK(ev.take().empty());
}

void test_invalid_commands() {
    FakeOptions o;
    o.n_ctx = 8;
    FakeModel model(o);
    Log log;
    Events ev;
    Session s(model, nullptr, log, ev.sinks());
    const Bytes initial = log.snapshot();

    s.post("not json");
    CHECK(idle(s));
    CHECK(one_error(ev, ""));
    s.post("{\"nocmd\":1}");
    CHECK(idle(s));
    CHECK(one_error(ev, ""));
    for (const char* c : {"config", "branch", "goto", "bogus"}) {
        send(s, {{"cmd", c}});
        CHECK(idle(s));
        CHECK(one_error(ev, c));
    }
    for (const char* c : {"branch", "goto"}) {
        send(s, {{"cmd", c}, {"node", 0}, {"token", 7}});
        CHECK(idle(s));
        const std::vector<json> l = ev.take();
        CHECK(l.size() == 1 && l[0].value("msg", "") == "no prompt yet");
    }
    send(s, {{"cmd", "run"}});
    CHECK(idle(s));
    CHECK(one_error(ev, "run"));  // no prompt yet
    send(s, {{"cmd", "step"}});
    CHECK(idle(s));
    CHECK(one_error(ev, "step"));
    send(s, {{"cmd", "pause"}});  // harmless
    CHECK(idle(s));
    CHECK(ev.take().empty());

    send(s, {{"cmd", "start"}});
    CHECK(idle(s));
    CHECK(one_error(ev, "start"));
    send(s, {{"cmd", "start"}, {"prompt", "x"}, {"format", "xml"}});
    CHECK(idle(s));
    CHECK(one_error(ev, "start"));
    send(s, start_cmd("x", {{"max_tokens", -3}}));
    CHECK(idle(s));
    CHECK(one_error(ev, "start"));
    send(s, start_cmd("x", "nope"));
    CHECK(idle(s));
    CHECK(one_error(ev, "start"));
    // The prompt does not fit in the context (8): the log does not change.
    send(s, start_cmd("this prompt is far too long for it"));
    CHECK(idle(s));
    CHECK(one_error(ev, "start"));
    CHECK(log.snapshot() == initial);
    CHECK(s.status().state == RunState::Idle);

    // A valid session, then a start whose prefill fails: the session stays.
    send(s, start_cmd(" the dog"));
    send(s, {{"cmd", "step"}});
    CHECK(idle(s));
    CHECK(ev.take().empty());
    const Bytes session = log.snapshot();
    const uint64_t epoch = log.epoch();
    model.fail_prefill = true;
    send(s, start_cmd(" a cat"));
    CHECK(idle(s));
    CHECK(one_error(ev, "start"));
    CHECK(log.snapshot() == session);
    CHECK_EQ(log.epoch(), epoch);
    model.fail_prefill = false;
    send(s, {{"cmd", "step"}});
    CHECK(idle(s));
    CHECK(ev.take().empty());
    CHECK_EQ(model_tokens(log.snapshot()).size(), 2u);

    // Gates in the start: they go to CONFIG, with no event.
    send(s, start_cmd(" the", {{"gates", json::array({{{"type", "top_k"}, {"k", 40}}})}}));
    CHECK(idle(s));
    CHECK(ev.take().empty());
    CHECK(s.status().state == RunState::Paused);
    CHECK_EQ(body_json(frames(log.snapshot())[1])["gates"].size(), 1u);

    // An invalid gate or grammar fails the start: the session stays.
    const Bytes with_gates = log.snapshot();
    const uint64_t epoch2 = log.epoch();
    for (const json& gates : {json::array({{{"type", "grammar"}, {"gbnf", "!not a grammar"}}}),
                              json::array({{{"type", "top_k"}, {"k", 0}}}), json::array({{{"type", "bogus"}}}),
                              json("top_k")}) {
        send(s, start_cmd(" a cat", {{"gates", gates}}));
        CHECK(idle(s));
        CHECK(one_error(ev, "start"));
        CHECK(log.snapshot() == with_gates);
        CHECK_EQ(log.epoch(), epoch2);
    }
    send(s, {{"cmd", "step"}});
    CHECK(idle(s));
    CHECK(ev.take().empty());
    CHECK_EQ(model_tokens(log.snapshot()).size(), 1u);

    // max_tokens 0: the prompt's last node cannot continue, STOP at once.
    send(s, start_cmd(" the", {{"max_tokens", 0}}));
    CHECK(idle(s));
    const Frames fs = frames(log.snapshot());
    CHECK(fs.back().type == FrameType::Stop);
    CHECK_EQ(fs.back().body[5], static_cast<uint8_t>(StopReason::MaxTokens));
    check_log_rules(log.snapshot());
}

// ------------------------------------------------------------- two models

// The frame types of a batch without its leading VOCAB.
std::vector<FrameType> shape(const Bytes& batch) {
    std::vector<FrameType> t = types(batch);
    if (!t.empty() && t.front() == FrameType::Vocab) t.erase(t.begin());
    return t;
}

// (node_a, node_b) of the last CURSOR of a log.
std::pair<uint32_t, uint32_t> last_cursor(const Bytes& log) {
    std::pair<uint32_t, uint32_t> c{NONE, NONE};
    for (const FrameView& f : frames(log)) {
        if (f.type == FrameType::Cursor) c = {u32(f.body), u32(f.body + 4)};
    }
    return c;
}

FakeOptions variant_options(uint64_t variant, bool can_trim = true) {
    FakeOptions o;
    o.variant = variant;
    o.can_trim = can_trim;
    return o;
}

// Steps until the cursors are on different nodes (free mode). False if they never split.
bool step_until_split(Session& s, const Log& log, int max_steps = 60) {
    for (int i = 0; i < max_steps; ++i) {
        send(s, {{"cmd", "step"}});
        if (!idle(s)) return false;
        const auto c = last_cursor(log.snapshot());
        if (c.first != c.second) return true;
    }
    return false;
}

void test_pair_startup() {
    FakeModel a, b(variant_options(1));
    Log log;
    Events ev;
    Session s(a, &b, log, ev.sinks(), {"first warning", "second"});
    const Frames fs = frames(log.snapshot());
    CHECK_EQ(fs.size(), 2u);
    const json h = body_json(fs[0]);
    CHECK_EQ(h["models"].size(), 2u);
    CHECK_EQ(h["models"][0]["slot"].get<std::string>(), std::string("A"));
    CHECK_EQ(h["models"][1]["slot"].get<std::string>(), std::string("B"));
    CHECK_EQ(h["warnings"].size(), 2u);
    CHECK_EQ(h["warnings"][0].get<std::string>(), std::string("first warning"));
    const json c = body_json(fs[1]);
    CHECK_EQ(c["mode"].get<std::string>(), std::string("lockstep"));
    CHECK_EQ(c["driver"].get<std::string>(), std::string("A"));

    // start: ... CURSOR(p, p); with max_tokens 0, one STOP for both.
    send(s, start_cmd(" the dog"));
    CHECK(idle(s));
    CHECK(ev.take().empty());
    const auto cur = last_cursor(log.snapshot());
    CHECK_EQ(cur.first, 2u);
    CHECK_EQ(cur.second, 2u);
    // The warnings of the engine survive a new session.
    CHECK_EQ(body_json(frames(log.snapshot())[0])["warnings"].size(), 2u);
    send(s, start_cmd(" the dog", {{"max_tokens", 0}}));
    CHECK(idle(s));
    const Frames f2 = frames(log.snapshot());
    CHECK(f2.back().type == FrameType::Stop);
    CHECK_EQ(f2.back().body[4], SLOT_BOTH);
    CHECK(f2[f2.size() - 2].type == FrameType::Cursor);
    check_log_rules(log.snapshot(), 2);
    send(s, {{"cmd", "step"}});
    CHECK(idle(s));
    CHECK(one_error(ev, "step"));

    // A model without a vocabulary of A's size is refused.
    FakeOptions o;
    o.extra_piece = "!extra";
    FakeModel other(o);
    Log log2;
    bool thrown = false;
    try {
        Session bad(a, &other, log2);
    } catch (const std::invalid_argument&) {
        thrown = true;
    }
    CHECK(thrown);
}

void test_tokenizer_difference() {
    FakeModel a, b(variant_options(3));
    CHECK(!tokenizer_difference(a, b));
    FakeOptions o;
    o.extra_piece = " extra";
    FakeModel c(o);
    const auto d = tokenizer_difference(a, c);
    CHECK(d.has_value());
    if (d) CHECK(!d->empty());
}

// Lockstep: every step is EVAL(A) EVAL(B) PAIR NODE CURSOR(h, h), and the
// text follows the driver's pick.
void test_lockstep(const char* driver) {
    FakeModel a, b(variant_options(1));
    Log log;
    Events ev;
    Session s(a, &b, log, ev.sinks());
    send(s, {{"cmd", "speed"}, {"tps", 0}});
    send(s, start_cmd("Tell me a story", {{"max_tokens", 60}, {"driver", driver}}));
    send(s, {{"cmd", "run"}});
    CHECK(idle(s));
    CHECK(ev.take().empty());
    CHECK(s.status().state == RunState::Paused);
    const Bytes snap = log.snapshot();
    check_log_rules(snap, 2);
    CHECK_EQ(body_json(frames(snap)[1])["driver"].get<std::string>(), std::string(driver));
    const uint8_t driver_slot = std::string(driver) == "B" ? SLOT_B : SLOT_A;

    const std::vector<Bytes> bs = batches(log);
    CHECK_EQ(bs.size(), 61u);
    int disagreements = 0;
    for (size_t i = 1; i < bs.size(); ++i) {
        std::vector<FrameType> want = {FrameType::Eval, FrameType::Eval, FrameType::Pair, FrameType::Node,
                                       FrameType::Cursor};
        const bool last = i + 1 == bs.size();
        if (last) want.push_back(FrameType::Stop);
        CHECK(shape(bs[i]) == want);
        if (shape(bs[i]) != want) continue;
        Frames f = frames(bs[i]);
        if (f[0].type == FrameType::Vocab) f.erase(f.begin());
        const EvalView ea = eval_of(f[0]), eb = eval_of(f[1]);
        const PairView p = pair_of(f[2]);
        const NodeRec n = node_of(f[3]);
        const EvalView& drv = driver_slot == SLOT_A ? ea : eb;
        CHECK_EQ(n.token, drv.entries[drv.pick].token);
        CHECK_EQ(n.parent, ea.node);
        CHECK_EQ(u32(f[4].body), n.id);
        CHECK_EQ(u32(f[4].body + 4), n.id);
        CHECK(p.js > 0);  // the variant always moves the weights a little
        if (!(p.flags & PAIR_SAME_PICK)) ++disagreements;
        if (last) {
            CHECK_EQ(f[5].body[4], SLOT_BOTH);
            CHECK_EQ(f[5].body[5], static_cast<uint8_t>(StopReason::MaxTokens));
        }
    }
    CHECK(disagreements >= 2);
    CHECK(disagreements <= 30);

    // Driven by A, the text is what A alone writes.
    if (driver_slot == SLOT_A) {
        FakeModel alone;
        Log log1;
        Session s1(alone, nullptr, log1);
        send(s1, {{"cmd", "speed"}, {"tps", 0}});
        send(s1, start_cmd("Tell me a story", {{"max_tokens", 60}}));
        send(s1, {{"cmd", "run"}});
        CHECK(idle(s1));
        CHECK(model_tokens(log1.snapshot()) == model_tokens(snap));
    }
}

// Two identical models: no divergence at all, and free mode never splits.
void test_identity() {
    FakeModel a, b;
    Log log;
    Events ev;
    Session s(a, &b, log, ev.sinks());
    send(s, {{"cmd", "speed"}, {"tps", 0}});
    for (const char* mode : {"lockstep", "free"}) {
        send(s, start_cmd("Once upon a time", {{"max_tokens", 40}, {"mode", mode}}));
        send(s, {{"cmd", "run"}});
        CHECK(idle(s));
        CHECK(ev.take().empty());
        const Bytes snap = log.snapshot();
        check_log_rules(snap, 2);
        int pairs = 0;
        for (const FrameView& f : frames(snap)) {
            if (f.type == FrameType::Pair) {
                const PairView p = pair_of(f);
                CHECK_EQ(p.js, 0.0f);
                CHECK_EQ(p.kl_ab, 0.0f);
                CHECK_EQ(p.kl_ba, 0.0f);
                CHECK_EQ(p.rank_a_in_b, 0u);
                CHECK_EQ(p.rank_b_in_a, 0u);
                CHECK_EQ(p.flags, PAIR_SAME_TOP | PAIR_SAME_PICK);
                ++pairs;
            } else if (f.type == FrameType::Cursor) {
                CHECK_EQ(u32(f.body), u32(f.body + 4));
            } else if (f.type == FrameType::Stop) {
                CHECK_EQ(f.body[4], SLOT_BOTH);
            }
        }
        CHECK_EQ(pairs, 40);
        CHECK_EQ(model_tokens(snap).size(), 40u);
    }
}

// Free mode: the cursors split at the first different pick, with two NODEs,
// and there is no PAIR after that. Both stop at max_tokens on their own node.
void test_free_split() {
    FakeModel a, b(variant_options(1));
    Log log;
    Events ev;
    Session s(a, &b, log, ev.sinks());
    send(s, {{"cmd", "speed"}, {"tps", 0}});
    send(s, start_cmd("Tell me a story", {{"max_tokens", 40}, {"mode", "free"}}));
    send(s, {{"cmd", "run"}});
    CHECK(idle(s));
    CHECK(ev.take().empty());
    CHECK(s.status().state == RunState::Paused);
    const Bytes snap = log.snapshot();
    check_log_rules(snap, 2);
    CHECK_EQ(body_json(frames(snap)[1])["mode"].get<std::string>(), std::string("free"));

    const std::vector<Bytes> bs = batches(log);
    CHECK_EQ(bs.size(), 41u);
    bool split = false;
    for (size_t i = 1; i < bs.size(); ++i) {
        const std::vector<FrameType> t = shape(bs[i]);
        const bool last = i + 1 == bs.size();
        if (!split) {
            const bool two = t.size() >= 5 && t[3] == FrameType::Node && t[4] == FrameType::Node;
            if (two) {
                split = true;
                CHECK((std::vector<FrameType>(t.begin(), t.begin() + 6) ==
                       std::vector<FrameType>{FrameType::Eval, FrameType::Eval, FrameType::Pair, FrameType::Node,
                                              FrameType::Node, FrameType::Cursor}));
                Frames f = frames(bs[i]);
                if (f[0].type == FrameType::Vocab) f.erase(f.begin());
                const NodeRec na = node_of(f[3]), nb = node_of(f[4]);
                CHECK_EQ(na.parent, nb.parent);
                CHECK(na.token != nb.token);
                CHECK(!(pair_of(f[2]).flags & PAIR_SAME_PICK));
                CHECK_EQ(u32(f[5].body), na.id);
                CHECK_EQ(u32(f[5].body + 4), nb.id);
            } else {
                std::vector<FrameType> want = {FrameType::Eval, FrameType::Eval, FrameType::Pair, FrameType::Node,
                                               FrameType::Cursor};
                CHECK((std::vector<FrameType>(t.begin(), t.begin() + std::min<size_t>(5, t.size())) == want));
            }
        } else {
            std::vector<FrameType> want = {FrameType::Eval, FrameType::Eval, FrameType::Node, FrameType::Node,
                                           FrameType::Cursor};
            if (last) want.insert(want.end(), {FrameType::Stop, FrameType::Stop});
            CHECK(t == want);
        }
        if (last) {
            Frames f = frames(bs[i]);
            CHECK(f.size() >= 2);
            CHECK_EQ(f[f.size() - 2].body[4], SLOT_A);
            CHECK_EQ(f.back().body[4], SLOT_B);
        }
    }
    CHECK(split);
    send(s, {{"cmd", "run"}});
    CHECK(idle(s));
    CHECK(one_error(ev, "run"));
}

// Free mode: one model stops, the other goes on alone; the generation ends
// when both have stopped.
void test_free_one_stops() {
    FakeOptions oa, ob;
    oa.eos_after = 4;
    ob.eos_after = 9;
    FakeModel a(oa), b(ob);
    Log log;
    Events ev;
    Session s(a, &b, log, ev.sinks());
    send(s, {{"cmd", "speed"}, {"tps", 0}});
    send(s, start_cmd("Go", {{"mode", "free"}}));
    send(s, {{"cmd", "run"}});
    CHECK(idle(s));
    CHECK(ev.take().empty());
    CHECK(s.status().state == RunState::Paused);
    check_log_rules(log.snapshot(), 2);

    const std::vector<Bytes> bs = batches(log);
    // Steps 1-4 together, 5: A writes <eos> and stops, B splits off; 6-10 B alone.
    CHECK_EQ(bs.size(), 11u);
    uint32_t a_stop = NONE;
    for (size_t i = 1; i < bs.size(); ++i) {
        const std::vector<FrameType> t = shape(bs[i]);
        Frames f = frames(bs[i]);
        if (f[0].type == FrameType::Vocab) f.erase(f.begin());
        if (i <= 4) {
            CHECK((t == std::vector<FrameType>{FrameType::Eval, FrameType::Eval, FrameType::Pair, FrameType::Node,
                                               FrameType::Cursor}));
        } else if (i == 5) {
            CHECK((t == std::vector<FrameType>{FrameType::Eval, FrameType::Eval, FrameType::Pair, FrameType::Node,
                                               FrameType::Node, FrameType::Cursor, FrameType::Stop}));
            if (t.size() == 7) {
                a_stop = u32(f[5].body);
                CHECK_EQ(node_of(f[3]).token, static_cast<uint32_t>(FakeModel::EOS));
                CHECK_EQ(f[6].body[4], SLOT_A);
                CHECK_EQ(u32(f[6].body), a_stop);
                CHECK_EQ(f[6].body[5], static_cast<uint8_t>(StopReason::EndOfGeneration));
            }
        } else {
            std::vector<FrameType> want = {FrameType::Eval, FrameType::Node, FrameType::Cursor};
            if (i == 10) want.push_back(FrameType::Stop);
            CHECK(t == want);
            if (t != want) continue;
            CHECK_EQ(eval_of(f[0]).slot, SLOT_B);
            CHECK_EQ(u32(f[2].body), a_stop);  // A's cursor does not move
            if (i == 10) {
                CHECK_EQ(f[3].body[4], SLOT_B);
                CHECK_EQ(node_of(f[1]).token, static_cast<uint32_t>(FakeModel::EOS));
            }
        }
    }
    send(s, {{"cmd", "step"}});
    CHECK(idle(s));
    CHECK(one_error(ev, "step"));

    // Both stop on the same node: one STOP for both.
    FakeModel c(oa), d(oa);
    Log log2;
    Session s2(c, &d, log2);
    send(s2, {{"cmd", "speed"}, {"tps", 0}});
    send(s2, start_cmd("Go", {{"mode", "free"}}));
    send(s2, {{"cmd", "run"}});
    CHECK(idle(s2));
    const Frames f2 = frames(log2.snapshot());
    CHECK(f2.back().type == FrameType::Stop);
    CHECK_EQ(f2.back().body[4], SLOT_BOTH);
    int stops = 0;
    for (const FrameView& f : f2) stops += f.type == FrameType::Stop;
    CHECK_EQ(stops, 1);
}

// A failed eval of B: an error event, Paused, the log intact; then it goes on.
void test_pair_failure() {
    FakeOptions ob;
    ob.fail_at_eval = 3;
    FakeModel a, b(ob);
    Log log;
    Events ev;
    Session s(a, &b, log, ev.sinks());
    send(s, start_cmd("Hello"));
    send(s, {{"cmd", "step"}});
    send(s, {{"cmd", "step"}});
    CHECK(idle(s));
    CHECK(ev.take().empty());
    const Bytes before = log.snapshot();
    send(s, {{"cmd", "speed"}, {"tps", 0}});
    send(s, {{"cmd", "run"}});
    CHECK(idle(s));
    const std::vector<json> l = ev.take();
    CHECK_EQ(l.size(), 1u);
    if (!l.empty()) {
        CHECK_EQ(l[0]["ev"].get<std::string>(), std::string("error"));
        CHECK(!l[0].contains("cmd"));
    }
    CHECK(s.status().state == RunState::Paused);
    CHECK(log.snapshot() == before);
    send(s, {{"cmd", "step"}});
    CHECK(idle(s));
    CHECK(ev.take().empty());
    CHECK_EQ(model_tokens(log.snapshot()).size(), 3u);
    check_log_rules(log.snapshot(), 2);
}

void test_config_command() {
    // One model: no modes.
    {
        FakeModel a;
        Log log;
        Events ev;
        Session s(a, nullptr, log, ev.sinks());
        send(s, {{"cmd", "config"}, {"config", {{"mode", "free"}}}});
        CHECK(idle(s));
        const std::vector<json> l = ev.take();
        CHECK_EQ(l.size(), 1u);
        if (!l.empty()) CHECK_EQ(l[0]["msg"].get<std::string>(), std::string("needs two models"));
        CHECK_EQ(frames(log.snapshot()).size(), 2u);
        // start ignores mode and driver in silence.
        send(s, start_cmd("Hi", {{"mode", "free"}, {"driver", "B"}}));
        CHECK(idle(s));
        CHECK(ev.take().empty());
        const json c = body_json(frames(log.snapshot())[1]);
        CHECK_EQ(c["mode"].get<std::string>(), std::string("lockstep"));
        CHECK_EQ(c["driver"].get<std::string>(), std::string("A"));
    }

    FakeOptions ob = variant_options(1, /*can_trim=*/false);
    ob.snapshot_every = 0;  // no snapshots either: a placement off the context is approximate
    FakeModel a, b(ob);
    Log log;
    Events ev;
    Session s(a, &b, log, ev.sinks());

    // Invalid values: errors, nothing changes.
    const Bytes initial = log.snapshot();
    for (const json& bad : {json{{"cmd", "config"}}, json{{"cmd", "config"}, {"config", "free"}},
                            json{{"cmd", "config"}, {"config", {{"mode", "solo"}}}},
                            json{{"cmd", "config"}, {"config", {{"driver", "C"}}}},
                            json{{"cmd", "config"}, {"config", {{"driver", 1}}}}}) {
        send(s, bad);
        CHECK(idle(s));
        CHECK(one_error(ev, "config"));
    }
    send(s, start_cmd("Hi", {{"mode", "together"}}));
    CHECK(idle(s));
    CHECK(one_error(ev, "start"));
    CHECK(log.snapshot() == initial);

    // Before the first prompt: only the configuration changes.
    send(s, {{"cmd", "config"}, {"config", {{"mode", "free"}}}});
    CHECK(idle(s));
    CHECK(ev.take().empty());
    const Frames f0 = frames(log.snapshot());
    CHECK_EQ(f0.size(), 3u);
    CHECK(f0.back().type == FrameType::Config);
    CHECK_EQ(body_json(f0.back())["mode"].get<std::string>(), std::string("free"));
    CHECK(s.status().state == RunState::Idle);
    // A new session starts from the defaults.
    send(s, start_cmd("Tell me a story", {{"max_tokens", 200}}));
    CHECK(idle(s));
    CHECK_EQ(body_json(frames(log.snapshot())[1])["mode"].get<std::string>(), std::string("lockstep"));

    // A partial config: what it carries changes, the rest stays.
    send(s, {{"cmd", "config"}, {"config", {{"driver", "B"}, {"seed", 3}, {"gates", json::array()}}}});
    CHECK(idle(s));
    std::vector<json> l = ev.take();
    CHECK(l.empty());
    std::vector<Bytes> bs = batches(log);
    CHECK((types(bs.back()) == std::vector<FrameType>{FrameType::Config}));  // lockstep: the cursors are together
    const json c = body_json(frames(bs.back())[0]);
    CHECK_EQ(c["driver"].get<std::string>(), std::string("B"));
    CHECK_EQ(c["seed"], 3);
    CHECK_EQ(c["max_tokens"], 200);

    // Free, until the cursors split.
    send(s, {{"cmd", "config"}, {"config", {{"mode", "free"}}}});
    CHECK(idle(s));
    CHECK(ev.take().empty());
    CHECK(step_until_split(s, log));
    // One step more: B's context now holds a token that is not on A's path.
    // (Right at the split it would not: B has not decoded its own pick yet.)
    send(s, {{"cmd", "step"}});
    CHECK(idle(s));
    const auto split = last_cursor(log.snapshot());
    CHECK(split.first != split.second);

    // Back to lockstep driven by A: B joins A, and the next step places B
    // there (approximately: it cannot trim and has no snapshot) and the
    // generation continues.
    send(s, {{"cmd", "config"}, {"config", {{"mode", "lockstep"}, {"driver", "A"}}}});
    CHECK(idle(s));
    CHECK(ev.take().empty());
    bs = batches(log);
    CHECK((types(bs.back()) == std::vector<FrameType>{FrameType::Config, FrameType::Cursor}));
    const auto joined = last_cursor(log.snapshot());
    CHECK_EQ(joined.first, split.first);
    CHECK_EQ(joined.second, split.first);
    send(s, {{"cmd", "step"}});
    CHECK(idle(s));
    l = ev.take();
    CHECK_EQ(l.size(), 1u);
    if (!l.empty()) {
        CHECK_EQ(l[0]["ev"].get<std::string>(), std::string("warning"));
        const std::string msg = l[0]["msg"];
        CHECK(msg.find("model B") != std::string::npos);
        CHECK(msg.find("approximate") != std::string::npos);
        CHECK(msg.find(std::to_string(split.first)) != std::string::npos);
    }
    bs = batches(log);
    CHECK((shape(bs.back()) == std::vector<FrameType>{FrameType::Eval, FrameType::Eval, FrameType::Pair,
                                                       FrameType::Node, FrameType::Cursor}));
    // Now B's context follows the path again: no more warnings.
    send(s, {{"cmd", "step"}});
    CHECK(idle(s));
    CHECK(ev.take().empty());
    check_log_rules(log.snapshot(), 2);

    // The same while running: free, split, then lockstep driven by B.
    send(s, {{"cmd", "speed"}, {"tps", 200}});
    send(s, start_cmd("Tell me a story", {{"max_tokens", 1000}, {"mode", "free"}}));
    send(s, {{"cmd", "run"}});
    bool apart = false;
    for (int i = 0; i < 300 && !apart; ++i) {
        std::this_thread::sleep_for(10ms);
        const auto cur = last_cursor(log.snapshot());
        apart = cur.first != cur.second;
    }
    CHECK(apart);
    send(s, {{"cmd", "config"}, {"config", {{"mode", "lockstep"}, {"driver", "B"}}}});
    std::this_thread::sleep_for(150ms);
    CHECK(s.status().state == RunState::Running);
    send(s, {{"cmd", "pause"}});
    CHECK(idle(s));
    const Frames fr = frames(log.snapshot());
    size_t at = 0;
    for (size_t i = 0; i < fr.size(); ++i)
        if (fr[i].type == FrameType::Config) at = i;
    CHECK(at > 1);
    CHECK(at + 1 < fr.size() && fr[at + 1].type == FrameType::Cursor);
    if (at + 1 < fr.size()) CHECK_EQ(u32(fr[at + 1].body), u32(fr[at + 1].body + 4));
    int pairs_after = 0;
    for (size_t i = at; i < fr.size(); ++i) {
        if (fr[i].type == FrameType::Pair) ++pairs_after;
        if (fr[i].type == FrameType::Cursor) CHECK_EQ(u32(fr[i].body), u32(fr[i].body + 4));
    }
    CHECK(pairs_after >= 2);
    CHECK(ev.take().empty());  // A joined B's node, but A can trim: an exact placement
    check_log_rules(log.snapshot(), 2);
}

// Running in free mode, A stops; lockstep driven by A puts B on A's stopped
// node: nothing can step, so the session pauses.
void test_config_pauses() {
    FakeOptions oa;
    oa.eos_after = 3;
    FakeModel a(oa), b(variant_options(1));
    Log log;
    Events ev;
    Session s(a, &b, log, ev.sinks());
    send(s, {{"cmd", "speed"}, {"tps", 50}});
    send(s, start_cmd("Go", {{"max_tokens", 1000}, {"mode", "free"}}));
    send(s, {{"cmd", "run"}});
    bool a_stopped = false;
    for (int i = 0; i < 300 && !a_stopped; ++i) {
        std::this_thread::sleep_for(10ms);
        for (const FrameView& f : frames(log.snapshot()))
            if (f.type == FrameType::Stop && f.body[4] == SLOT_A) a_stopped = true;
    }
    CHECK(a_stopped);
    CHECK(s.status().state == RunState::Running);
    send(s, {{"cmd", "config"}, {"config", {{"mode", "lockstep"}, {"driver", "A"}}}});
    CHECK(idle(s));
    CHECK(s.status().state == RunState::Paused);
    const Frames fr = frames(log.snapshot());
    CHECK(fr.back().type == FrameType::Cursor);
    CHECK(fr[fr.size() - 2].type == FrameType::Config);
    const auto cur = last_cursor(log.snapshot());
    CHECK_EQ(cur.first, cur.second);
    send(s, {{"cmd", "run"}});
    CHECK(idle(s));
    CHECK(one_error(ev, "run"));
    check_log_rules(log.snapshot(), 2);
}

// ------------------------------------------------------------------- gates

// `config` with one model: every field but mode and driver. A failure changes
// nothing, not even the valid fields of the same command.
void test_config_one_model() {
    FakeModel model;
    Log log;
    Events ev;
    Session s(model, nullptr, log, ev.sinks());
    send(s, {{"cmd", "speed"}, {"tps", 0}});

    // Before the first prompt: only the configuration changes.
    send(s, config_cmd({{"seed", 5}}));
    CHECK(idle(s));
    CHECK(ev.take().empty());
    CHECK_EQ(frames(log.snapshot()).size(), 3u);
    CHECK_EQ(last_config(log.snapshot())["seed"], 5);
    for (const char* k : {"mode", "driver"}) {
        send(s, config_cmd({{k, "A"}, {"seed", 6}}));
        CHECK(idle(s));
        const std::vector<json> l = ev.take();
        CHECK_EQ(l.size(), 1u);
        if (!l.empty()) CHECK_EQ(l[0]["msg"].get<std::string>(), std::string("needs two models"));
    }
    CHECK_EQ(frames(log.snapshot()).size(), 3u);

    send(s, start_cmd(" the dog", {{"max_tokens", 3}}));
    send(s, {{"cmd", "run"}});
    CHECK(idle(s));
    CHECK(ev.take().empty());
    CHECK_EQ(model_tokens(log.snapshot()).size(), 3u);
    send(s, {{"cmd", "run"}});
    CHECK(idle(s));
    CHECK(one_error(ev, "run"));

    // A higher max_tokens lets the stopped path continue.
    send(s, config_cmd({{"max_tokens", 6}}));
    CHECK(idle(s));
    CHECK(ev.take().empty());
    CHECK((types(batches(log).back()) == std::vector<FrameType>{FrameType::Config}));
    json c = last_config(log.snapshot());
    CHECK_EQ(c["max_tokens"], 6);
    CHECK_EQ(c["seed"], 42);  // the start went back to the defaults
    send(s, {{"cmd", "run"}});
    CHECK(idle(s));
    CHECK(ev.take().empty());
    CHECK_EQ(model_tokens(log.snapshot()).size(), 6u);

    // Partial: the gates only.
    send(s, config_cmd({{"max_tokens", 100}}));
    send(s, config_cmd({{"gates", json::array({gate("top_k", {{"k", 5}})})}}));
    CHECK(idle(s));
    CHECK(ev.take().empty());
    c = last_config(log.snapshot());
    CHECK_EQ(c["gates"].size(), 1u);
    CHECK_EQ(c["gates"][0]["k"], 5);
    CHECK_EQ(c["max_tokens"], 100);

    // An unknown field: a warning, and the rest applies.
    send(s, config_cmd({{"seed", 9}, {"colour", "red"}}));
    CHECK(idle(s));
    const std::vector<json> l = ev.take();
    CHECK_EQ(l.size(), 1u);
    if (!l.empty()) {
        CHECK_EQ(l[0]["ev"].get<std::string>(), std::string("warning"));
        CHECK(l[0]["msg"].get<std::string>().find("colour") != std::string::npos);
    }
    CHECK_EQ(last_config(log.snapshot())["seed"], 9);

    // Errors. The last grammar is valid but rejects the text so far ("The quick brown...").
    const Bytes before = log.snapshot();
    for (const json& bad :
         {json{{"seed", 1}, {"max_tokens", -3}}, json{{"max_tokens", "x"}}, json{{"seed", -1}}, json{{"seed", 1.5}},
          json{{"seed", "x"}}, json{{"seed", 1}, {"gates", "top_k"}}, json{{"gates", json::array({gate("bogus")})}},
          json{{"gates", json::array({gate("top_k", {{"k", 0}})})}},
          json{{"gates", json::array({gate("top_p", {{"p", 0}})})}}, json{{"gates", json::array({gate("grammar")})}},
          json{{"gates", json::array({gate("grammar", {{"gbnf", "!bad"}})})}},
          json{{"seed", 1}, {"gates", json::array({gate("top_k", {{"k", 3}}), gate("grammar", {{"gbnf", LOWER}})})}}}) {
        send(s, config_cmd(bad));
        CHECK(idle(s));
        CHECK(one_error(ev, "config"));
        CHECK(log.snapshot() == before);
    }
    // The configuration in force is the one before the errors.
    send(s, {{"cmd", "step"}});
    CHECK(idle(s));
    CHECK(ev.take().empty());
    const std::vector<EvalView> es = evals(log.snapshot());
    CHECK_EQ(es.back().n_gates, 1);
    CHECK_EQ(model_tokens(log.snapshot()).size(), 7u);
    check_log_rules(log.snapshot());
}

// A complete `config` with two models; the CONFIG carries every parameter.
void test_config_full() {
    FakeModel a, b(variant_options(1));
    Log log;
    Events ev;
    Session s(a, &b, log, ev.sinks());
    send(s, {{"cmd", "speed"}, {"tps", 0}});
    send(s, start_cmd(" the dog"));
    const json gates = json::array({gate("penalties", {{"repeat", 1.3}}), gate("top_k", {{"k", 20}}),
                                    gate("top_p", {{"p", 0.9}}), gate("min_p", {{"p", 0.02}}),
                                    gate("temp", {{"t", 0.7}})});
    send(s, config_cmd({{"mode", "free"}, {"driver", "B"}, {"seed", 77}, {"max_tokens", 50}, {"gates", gates}}));
    CHECK(idle(s));
    CHECK(ev.take().empty());
    CHECK((types(batches(log).back()) == std::vector<FrameType>{FrameType::Config}));  // the cursors are together
    const json c = last_config(log.snapshot());
    CHECK_EQ(c["mode"].get<std::string>(), std::string("free"));
    CHECK_EQ(c["driver"].get<std::string>(), std::string("B"));
    CHECK_EQ(c["seed"], 77);
    CHECK_EQ(c["max_tokens"], 50);
    CHECK_EQ(c["gates"].size(), 5u);
    CHECK_EQ(c["gates"][0]["last_n"], 64);
    CHECK_EQ(c["gates"][0]["repeat"], 1.3);
    CHECK_EQ(c["gates"][0]["frequency"], 0.0);
    CHECK_EQ(c["gates"][4]["t"], 0.7);
    send(s, {{"cmd", "run"}});
    CHECK(idle(s));
    CHECK(ev.take().empty());
    CHECK(s.status().state == RunState::Paused);
    check_log_rules(log.snapshot(), 2);
    for (const EvalView& e : evals(log.snapshot())) CHECK_EQ(e.n_gates, 5);
}

// A grammar that does not admit the generated path: an error, and
// configuration, cursors and log as they were; the generation goes on. One
// that admits it is taken, and the text keeps to its bytes from then on.
void test_grammar_atomicity() {
    FakeModel a, b(variant_options(1));
    Log log;
    Events ev;
    Session s(a, &b, log, ev.sinks());
    send(s, start_cmd(" the dog", {{"max_tokens", 100}}));
    for (int i = 0; i < 5; ++i) send(s, {{"cmd", "step"}});
    CHECK(idle(s));
    CHECK(ev.take().empty());
    const Bytes before = log.snapshot();
    const uint32_t nodes = s.status().nodes;

    send(s, config_cmd({{"mode", "free"}, {"seed", 3}, {"gates", json::array({gate("grammar", {{"gbnf", LOWER}})})}}));
    CHECK(idle(s));
    CHECK(one_error(ev, "config"));
    CHECK(log.snapshot() == before);
    CHECK_EQ(s.status().nodes, nodes);
    send(s, {{"cmd", "step"}});
    CHECK(idle(s));
    CHECK(ev.take().empty());
    CHECK((shape(batches(log).back()) == std::vector<FrameType>{FrameType::Eval, FrameType::Eval, FrameType::Pair,
                                                                 FrameType::Node, FrameType::Cursor}));
    CHECK_EQ(last_config(log.snapshot())["mode"].get<std::string>(), std::string("lockstep"));
    CHECK_EQ(evals(log.snapshot()).back().n_gates, 0);

    // A grammar with every byte of the text so far, and the lowercase letters.
    std::string allowed = LOWER;
    std::map<uint32_t, std::string> text = texts(log.snapshot());
    for (uint32_t t : model_tokens(log.snapshot())) allowed += text[t];
    send(s, config_cmd({{"gates", json::array({gate("grammar", {{"gbnf", allowed}})})}}));
    CHECK(idle(s));
    CHECK(ev.take().empty());
    const size_t n = model_tokens(log.snapshot()).size();
    for (int i = 0; i < 20; ++i) send(s, {{"cmd", "step"}});
    CHECK(idle(s));
    CHECK(ev.take().empty());
    const Bytes snap = log.snapshot();
    check_log_rules(snap, 2);
    const std::vector<uint32_t> toks = model_tokens(snap);
    CHECK(toks.size() > n);
    text = texts(snap);
    for (size_t i = n; i < toks.size(); ++i) {
        if (toks[i] == FakeModel::EOS) continue;  // an end of generation is always admitted
        for (char ch : text[toks[i]]) CHECK(allowed.find(ch) != std::string::npos);
    }
}

// EVAL with gates: survivors after top_k, the last row of stage_p, the pick
// of temp 0 and of a final top_k of 1.
void test_eval_with_gates() {
    FakeModel model;
    Log log;
    Events ev;
    Session s(model, nullptr, log, ev.sinks());
    send(s, {{"cmd", "speed"}, {"tps", 0}});
    auto run = [&](const json& config) {
        send(s, start_cmd("Tell me a story", config));
        send(s, {{"cmd", "run"}});
        CHECK(idle(s));
        CHECK(ev.take().empty());
        const Bytes snap = log.snapshot();
        check_log_rules(snap);
        return evals(snap);
    };

    // A chain that ends in top_k of 6: every survivor is among the entries,
    // and the last row adds up to 1.
    std::vector<EvalView> es =
        run({{"max_tokens", 25}, {"gates", json::array({gate("temp", {{"t", 1.5}}), gate("top_k", {{"k", 6}})})}});
    CHECK_EQ(es.size(), 25u);
    int not_first = 0;
    for (const EvalView& e : es) {
        CHECK_EQ(e.n_gates, 2);
        if (e.n_gates != 2) continue;
        CHECK_EQ(e.survivors[0], model.n_vocab());  // temp eliminates nothing
        CHECK_EQ(e.survivors[1], 6u);
        double sum = 0;
        int alive = 0;
        for (size_t i = 0; i < e.entries.size(); ++i) {
            sum += e.stage(1, i);
            alive += e.stage(1, i) > 0;
        }
        CHECK_NEAR(sum, 1.0, 1e-4);
        CHECK_EQ(alive, 6);
        for (size_t i = 0; i < 6; ++i) CHECK(e.stage(1, i) > 0);  // the 6 most likely
        not_first += e.pick != 0;
    }
    CHECK(not_first > 0);  // a draw, not always the most likely

    // top_k after a gate that leaves fewer: it keeps those.
    es = run({{"max_tokens", 15}, {"gates", json::array({gate("top_p", {{"p", 0.5}}), gate("top_k", {{"k", 8}})})}});
    int fewer = 0;
    for (const EvalView& e : es) {
        if (e.n_gates != 2) continue;
        CHECK_EQ(e.survivors[1], std::min<uint32_t>(8, e.survivors[0]));
        fewer += e.survivors[0] < 8;
    }
    CHECK(fewer > 0);

    // temp 0, and top_k 1 as the last gate: the most likely of what the gates
    // before leave. Strong penalties change that order now and then.
    for (const json& last : {gate("temp", {{"t", 0}}), gate("top_k", {{"k", 1}})}) {
        es = run({{"max_tokens", 25},
                  {"gates", json::array({gate("penalties", {{"repeat", 3.0}}), gate("top_k", {{"k", 10}}), last})}});
        CHECK_EQ(es.size(), 25u);
        for (const EvalView& e : es) {
            if (e.n_gates != 3) continue;
            CHECK_EQ(e.survivors[2], 1u);
            CHECK_NEAR(e.stage(2, e.pick), 1.0, 1e-6);
            for (size_t i = 0; i < e.entries.size(); ++i) CHECK(e.stage(1, e.pick) >= e.stage(1, i));
        }
    }
}

// Same seed, prompt and configuration: the same text, in the same session
// or another one. Another seed with a high temperature: another text.
void test_gate_determinism() {
    const json gates = json::array({gate("top_k", {{"k", 50}}), gate("temp", {{"t", 2.5}})});
    auto text = [&](uint64_t seed, int times) {
        FakeModel model;
        Log log;
        Session s(model, nullptr, log);
        send(s, {{"cmd", "speed"}, {"tps", 0}});
        std::vector<uint32_t> first;
        for (int i = 0; i < times; ++i) {
            send(s, start_cmd("Tell me a story", {{"max_tokens", 30}, {"seed", seed}, {"gates", gates}}));
            send(s, {{"cmd", "run"}});
            CHECK(idle(s));
            if (i == 0) first = model_tokens(log.snapshot());
            else CHECK(model_tokens(log.snapshot()) == first);
        }
        return first;
    };
    const std::vector<uint32_t> first = text(1, 2);
    CHECK_EQ(first.size(), 30u);
    CHECK(text(1, 1) == first);
    CHECK(text(2, 1) != first);
}

// accept: penalties take the whole path, prompt included; a grammar only the
// generated tokens, and the text keeps to its bytes. No chain is rebuilt
// while the cursor follows its own steps.
void test_accept() {
    FakeModel model;
    Log log;
    Events ev;
    Session s(model, nullptr, log, ev.sinks());
    send(s, {{"cmd", "speed"}, {"tps", 0}});
    send(s, start_cmd(" the dog",
                      {{"max_tokens", 20}, {"gates", json::array({gate("penalties"), gate("grammar", {{"gbnf", LOWER}})})}}));
    send(s, {{"cmd", "run"}});
    CHECK(idle(s));
    CHECK(ev.take().empty());
    const Bytes snap = log.snapshot();
    check_log_rules(snap);

    std::vector<int32_t> generated;
    for (uint32_t t : model_tokens(snap)) generated.push_back(static_cast<int32_t>(t));
    CHECK(!generated.empty());
    std::vector<int32_t> all = model.tokenize_prompt(" the dog", false, "");
    all.insert(all.end(), generated.begin(), generated.end());
    CHECK(accepted_by(model, "penalties") == all);
    CHECK(accepted_by(model, "grammar") == generated);
    CHECK_EQ(model.samplers_made, 2);

    const std::map<uint32_t, std::string> text = texts(snap);
    for (int32_t t : generated) {
        if (model.attr(t) & ATTR_EOG) continue;
        for (char ch : text.at(static_cast<uint32_t>(t))) CHECK(LOWER.find(ch) != std::string::npos);
    }
}

// A gate that refuses the token of a step, and gates that leave no candidate:
// the step fails like a failed decode (an `error` without `cmd`, Paused, the
// log as it was), and the next step rebuilds the chain and goes on from the
// same node.
void test_gate_failures() {
    {
        FakeModel model;
        Log log;
        Events ev;
        Session s(model, nullptr, log, ev.sinks());
        send(s, start_cmd(" the dog", {{"max_tokens", 20},
                                       {"gates", json::array({gate("penalties"), gate("grammar", {{"gbnf", LOWER}})})}}));
        send(s, {{"cmd", "step"}});
        send(s, {{"cmd", "step"}});
        CHECK(idle(s));
        CHECK(ev.take().empty());
        CHECK_EQ(model.samplers_made, 2);
        const Bytes before = log.snapshot();

        model.refuse_admit_at = model.admits_asked + 1;  // the accept of the third step
        send(s, {{"cmd", "step"}});
        CHECK(idle(s));
        std::vector<json> l = ev.take();
        CHECK_EQ(l.size(), 1u);
        if (!l.empty()) {
            CHECK_EQ(l[0]["ev"].get<std::string>(), std::string("error"));
            CHECK(!l[0].contains("cmd"));
        }
        CHECK(s.status().state == RunState::Paused);
        CHECK(log.snapshot() == before);

        // The next step builds both samplers again from the path and works.
        model.accepted.clear();
        send(s, {{"cmd", "step"}});
        CHECK(idle(s));
        CHECK(ev.take().empty());
        CHECK_EQ(model.samplers_made, 4);
        const Bytes snap = log.snapshot();
        check_log_rules(snap);
        std::vector<int32_t> generated;
        for (uint32_t t : model_tokens(snap)) generated.push_back(static_cast<int32_t>(t));
        CHECK_EQ(generated.size(), 3u);
        // The new samplers were given the whole path, then the new token.
        std::vector<int32_t> all = model.tokenize_prompt(" the dog", false, "");
        all.insert(all.end(), generated.begin(), generated.end());
        CHECK(accepted_by(model, "penalties") == all);
        CHECK(accepted_by(model, "grammar") == generated);
    }
    {
        FakeModel model;
        Log log;
        Events ev;
        Session s(model, nullptr, log, ev.sinks());
        send(s, start_cmd(" the dog", {{"max_tokens", 20}, {"gates", json::array({gate("top_k", {{"k", 5}})})}}));
        send(s, {{"cmd", "step"}});
        CHECK(idle(s));
        CHECK(ev.take().empty());
        const Bytes before = log.snapshot();

        model.empty_apply_at = model.applies_done + 1;  // the trace of the second step
        send(s, {{"cmd", "step"}});
        CHECK(idle(s));
        const std::vector<json> l = ev.take();
        CHECK_EQ(l.size(), 1u);
        if (!l.empty()) {
            CHECK_EQ(l[0]["ev"].get<std::string>(), std::string("error"));
            CHECK(!l[0].contains("cmd"));
            CHECK(l[0]["msg"].get<std::string>().find("no candidate survives") != std::string::npos);
        }
        CHECK(s.status().state == RunState::Paused);
        CHECK(log.snapshot() == before);

        send(s, {{"cmd", "step"}});
        CHECK(idle(s));
        CHECK(ev.take().empty());
        CHECK_EQ(model_tokens(log.snapshot()).size(), 2u);
        check_log_rules(log.snapshot());
    }
}

// From free to lockstep with stateful gates: the chain of the model that
// joins is rebuilt for the driver's path; from then on both take the
// driver's pick, with no other rebuild.
void test_free_to_lockstep_gates() {
    FakeModel a, b(variant_options(1));
    Log log;
    Events ev;
    Session s(a, &b, log, ev.sinks());
    send(s, start_cmd("Tell me a story",
                      {{"max_tokens", 200}, {"mode", "free"}, {"gates", json::array({gate("penalties", {{"repeat", 1.2}})})}}));
    CHECK(idle(s));
    CHECK(step_until_split(s, log));
    CHECK(ev.take().empty());
    const auto split = last_cursor(log.snapshot());
    const size_t a_accepted = a.accepted.size(), b_accepted = b.accepted.size();
    const int a_made = a.samplers_made, b_made = b.samplers_made;

    send(s, config_cmd({{"mode", "lockstep"}, {"driver", "A"}}));
    CHECK(idle(s));
    CHECK(ev.take().empty());
    CHECK_EQ(a.accepted.size(), a_accepted);
    CHECK_EQ(a.samplers_made, a_made);
    CHECK_EQ(b.samplers_made, b_made + 1);
    std::vector<int32_t> rebuilt;
    for (size_t i = b_accepted; i < b.accepted.size(); ++i) {
        CHECK_EQ(b.accepted[i].first, std::string("penalties"));
        rebuilt.push_back(b.accepted[i].second);
    }
    CHECK(rebuilt == path_to(log.snapshot(), split.first));

    for (int i = 0; i < 3; ++i) send(s, {{"cmd", "step"}});
    CHECK(idle(s));
    CHECK(ev.take().empty());
    const auto cur = last_cursor(log.snapshot());
    CHECK_EQ(cur.first, cur.second);
    // Since the rebuild, B's chain has taken exactly the path it is on.
    const std::vector<int32_t> path = path_to(log.snapshot(), cur.first);
    std::vector<int32_t> since;
    for (size_t i = b_accepted; i < b.accepted.size(); ++i) since.push_back(b.accepted[i].second);
    CHECK(since == path);
    CHECK_EQ(a.accepted.back().second, path.back());
    CHECK_EQ(b.samplers_made, b_made + 1);
    check_log_rules(log.snapshot(), 2);
}

// A CONFIG halfway through: the EVALs after it carry the new gates.
void test_config_midsession() {
    FakeModel a, b(variant_options(1));
    Log log;
    Events ev;
    Session s(a, &b, log, ev.sinks());
    send(s, start_cmd("Tell me a story", {{"max_tokens", 100}, {"gates", json::array({gate("top_k", {{"k", 5}})})}}));
    for (int i = 0; i < 3; ++i) send(s, {{"cmd", "step"}});
    send(s, config_cmd({{"gates", json::array({gate("top_p", {{"p", 0.8}}), gate("temp", {{"t", 0.7}}),
                                                gate("min_p", {{"p", 0.05}})})}}));
    for (int i = 0; i < 3; ++i) send(s, {{"cmd", "step"}});
    CHECK(idle(s));
    CHECK(ev.take().empty());
    const Bytes snap = log.snapshot();
    check_log_rules(snap, 2);
    const std::vector<EvalView> es = evals(snap);
    CHECK_EQ(es.size(), 12u);
    for (size_t i = 0; i < es.size(); ++i) CHECK_EQ(es[i].n_gates, i < 6 ? 1 : 3);
}

// ------------------------------------------------------- branch and goto

json branch_cmd(uint32_t node, uint32_t token, const char* slots = nullptr) {
    json j = {{"cmd", "branch"}, {"node", node}, {"token", token}};
    if (slots) j["slots"] = slots;
    return j;
}

json goto_cmd(uint32_t node, const char* slots = nullptr) {
    json j = {{"cmd", "goto"}, {"node", node}};
    if (slots) j["slots"] = slots;
    return j;
}

// The message of the one `error` event for `cmd`; empty if there is not exactly one.
std::string error_msg(Events& ev, const std::string& cmd) {
    const std::vector<json> l = ev.take();
    if (l.size() != 1 || l[0].value("ev", "") != "error" || l[0].value("cmd", "?") != cmd) return "";
    return l[0].value("msg", "");
}

// The last EVAL of `node` by `slot` in a log.
EvalView eval_at(const Bytes& log, uint32_t node, uint8_t slot = SLOT_A) {
    EvalView found{};
    bool any = false;
    for (const EvalView& e : evals(log)) {
        if (e.node == node && e.slot == slot) {
            found = e;
            any = true;
        }
    }
    CHECK(any);
    return found;
}

// Two EVALs with the same numbers (all but the decoding time).
bool same_eval(const EvalView& x, const EvalView& y) {
    if (x.entries.size() != y.entries.size()) return false;
    for (size_t i = 0; i < x.entries.size(); ++i)
        if (x.entries[i].token != y.entries[i].token || x.entries[i].p_raw != y.entries[i].p_raw) return false;
    return x.n_raw == y.n_raw && x.n_extra == y.n_extra && x.pick == y.pick && x.entropy == y.entropy &&
           x.raw_mass == y.raw_mass && x.survivors == y.survivors && x.stage_p == y.stage_p;
}

uint32_t last_prompt_node(const std::string& prompt) {
    return static_cast<uint32_t>(FakeModel().tokenize_prompt(prompt, false, "").size() - 1);
}

// Invalid branch and goto commands: an error each, and nothing changes.
void test_branch_goto_errors() {
    FakeModel model;
    Log log;
    Events ev;
    Session s(model, nullptr, log, ev.sinks());
    send(s, start_cmd(" the dog", {{"max_tokens", 20}}));  // prompt: nodes 0 to 2
    send(s, {{"cmd", "step"}});
    send(s, {{"cmd", "step"}});
    CHECK(idle(s));
    CHECK(ev.take().empty());
    const Bytes before = log.snapshot();
    const uint32_t nodes = s.status().nodes;
    CHECK_EQ(nodes, 5u);
    const uint32_t nv = model.n_vocab();

    const std::vector<std::pair<json, std::string>> bad = {
        {json{{"cmd", "goto"}}, "\"node\""},
        {json{{"cmd", "goto"}, {"node", "3"}}, "\"node\""},
        {json{{"cmd", "goto"}, {"node", 3.5}}, "\"node\""},
        {json{{"cmd", "goto"}, {"node", -1}}, "unknown node -1"},
        {goto_cmd(99), "unknown node 99"},
        {goto_cmd(1), "prompt"},
        {goto_cmd(0), "prompt"},
        {branch_cmd(1, 7), "prompt"},  // the parent is inside the prompt
        {branch_cmd(99, 7), "unknown node 99"},
        {json{{"cmd", "branch"}, {"node", 3}}, "\"token\""},
        {json{{"cmd", "branch"}, {"node", 3}, {"token", -1}}, "\"token\""},
        {json{{"cmd", "branch"}, {"node", 3}, {"token", "a"}}, "\"token\""},
        {json{{"cmd", "branch"}, {"node", 3}, {"token", 2.0}}, "\"token\""},
        {branch_cmd(3, nv), "\"token\""},
        {goto_cmd(3, "B"), "no model B"},
        {branch_cmd(3, 7, "B"), "no model B"},
        {goto_cmd(3, "C"), "\"slots\""},
        {json{{"cmd", "goto"}, {"node", 3}, {"slots", 1}}, "\"slots\""},
    };
    for (const auto& [cmd, msg] : bad) {
        send(s, cmd);
        CHECK(idle(s));
        const std::string got = error_msg(ev, cmd["cmd"].get<std::string>());
        CHECK(!got.empty() && got.find(msg) != std::string::npos);
        if (got.find(msg) == std::string::npos) std::fprintf(stderr, "  %s -> \"%s\"\n", cmd.dump().c_str(), got.c_str());
        CHECK(log.snapshot() == before);
        CHECK_EQ(s.status().nodes, nodes);
    }

    // Valid: the last node of the prompt; "A" and "AB" with one model; the
    // node the cursor is already on (CURSOR all the same).
    send(s, goto_cmd(2, "AB"));
    CHECK(idle(s));
    CHECK(ev.take().empty());
    CHECK((types(batches(log).back()) == std::vector<FrameType>{FrameType::Cursor}));
    CHECK_EQ(last_cursor(log.snapshot()).first, 2u);
    send(s, goto_cmd(2));
    CHECK(idle(s));
    CHECK(ev.take().empty());
    CHECK((types(batches(log).back()) == std::vector<FrameType>{FrameType::Cursor}));
    send(s, branch_cmd(2, nv - 1, "A"));
    CHECK(idle(s));
    CHECK(ev.take().empty());
    CHECK((shape(batches(log).back()) == std::vector<FrameType>{FrameType::Node, FrameType::Cursor}));
    CHECK(s.status().state == RunState::Paused);
    check_log_rules(log.snapshot());
}

// branch with one model: NODE with origin 2 and CURSOR; the next step
// evaluates the new node; an existing child is reused; towards <eos>, STOP.
// The state does not change, unless nothing can step any more.
void test_branch_one_model() {
    FakeModel model;
    Log log;
    Events ev;
    Session s(model, nullptr, log, ev.sinks());
    send(s, start_cmd(" the dog", {{"max_tokens", 20}}));  // prompt: nodes 0 to 2
    for (int i = 0; i < 3; ++i) send(s, {{"cmd", "step"}});  // nodes 3 to 5, cursor on 5
    CHECK(idle(s));
    CHECK(ev.take().empty());
    const Bytes snap = log.snapshot();
    const EvalView e3 = eval_at(snap, 3);
    const uint32_t alt = e3.entries[1].token;  // no gates: the pick is entry 0
    CHECK(alt != e3.pick_token());

    send(s, branch_cmd(3, alt));
    CHECK(idle(s));
    CHECK(ev.take().empty());
    std::vector<Bytes> bs = batches(log);
    CHECK((types(bs.back()) == std::vector<FrameType>{FrameType::Node, FrameType::Cursor}));  // alt has a VOCAB
    Frames f = frames(bs.back());
    const NodeRec n = node_of(f[0]);
    CHECK_EQ(n.id, 6u);
    CHECK_EQ(n.parent, 3u);
    CHECK_EQ(n.token, alt);
    CHECK_EQ(n.depth, 4u);
    CHECK_EQ(n.origin, ORIGIN_USER);
    CHECK_EQ(u32(f[1].body), 6u);
    CHECK_EQ(u32(f[1].body + 4), NONE);
    CHECK_EQ(s.status().nodes, 7u);
    CHECK(s.status().state == RunState::Paused);

    // The next step evaluates the new node.
    send(s, {{"cmd", "step"}});
    CHECK(idle(s));
    CHECK(ev.take().empty());
    CHECK((shape(batches(log).back()) == std::vector<FrameType>{FrameType::Eval, FrameType::Node, FrameType::Cursor}));
    CHECK_EQ(evals(log.snapshot()).back().node, 6u);

    // Children that exist: no NODE, and the branch keeps its origin.
    send(s, branch_cmd(3, e3.pick_token()));
    CHECK(idle(s));
    CHECK((types(batches(log).back()) == std::vector<FrameType>{FrameType::Cursor}));
    CHECK_EQ(last_cursor(log.snapshot()).first, 4u);
    send(s, branch_cmd(3, alt));
    CHECK(idle(s));
    CHECK((types(batches(log).back()) == std::vector<FrameType>{FrameType::Cursor}));
    CHECK_EQ(last_cursor(log.snapshot()).first, 6u);
    CHECK(ev.take().empty());

    // Towards <eos>: STOP, and run fails.
    send(s, branch_cmd(5, FakeModel::EOS));
    CHECK(idle(s));
    CHECK(ev.take().empty());
    bs = batches(log);
    CHECK((shape(bs.back()) == std::vector<FrameType>{FrameType::Node, FrameType::Cursor, FrameType::Stop}));
    f = frames(bs.back());
    const NodeRec eos = node_of(f[f.size() - 3]);
    CHECK_EQ(eos.token, static_cast<uint32_t>(FakeModel::EOS));
    CHECK_EQ(eos.origin, ORIGIN_USER);
    CHECK_EQ(u32(f.back().body), eos.id);
    CHECK_EQ(f.back().body[4], SLOT_A);
    CHECK_EQ(f.back().body[5], static_cast<uint8_t>(StopReason::EndOfGeneration));
    send(s, {{"cmd", "run"}});
    CHECK(idle(s));
    CHECK(one_error(ev, "run"));
    CHECK(s.status().state == RunState::Paused);
    check_log_rules(log.snapshot());

    // Running: the generation goes on along the branch.
    const uint32_t alt4 = eval_at(snap, 4).entries[1].token;
    send(s, {{"cmd", "speed"}, {"tps", 50}});
    send(s, goto_cmd(5));
    send(s, {{"cmd", "run"}});
    std::this_thread::sleep_for(60ms);
    CHECK(s.status().state == RunState::Running);
    send(s, branch_cmd(4, alt4));
    std::this_thread::sleep_for(150ms);
    CHECK(s.status().state == RunState::Running);
    send(s, {{"cmd", "pause"}});
    CHECK(idle(s));
    CHECK(ev.take().empty());
    uint32_t branched = NONE;
    for (const FrameView& fr : frames(log.snapshot())) {
        if (fr.type != FrameType::Node) continue;
        const NodeRec r = node_of(fr);
        if (r.parent == 4 && r.token == alt4 && r.origin == ORIGIN_USER) branched = r.id;
    }
    CHECK(branched != NONE);
    bool evaluated = false;
    for (const EvalView& e : evals(log.snapshot())) evaluated = evaluated || e.node == branched;
    CHECK(evaluated);

    // Running onto a node that cannot continue: paused.
    send(s, {{"cmd", "run"}});
    send(s, branch_cmd(5, FakeModel::EOS));  // exists: CURSOR and STOP
    CHECK(idle(s));
    CHECK(s.status().state == RunState::Paused);
    CHECK(ev.take().empty());
    CHECK((types(batches(log).back()) == std::vector<FrameType>{FrameType::Cursor, FrameType::Stop}));
    check_log_rules(log.snapshot());
}

// goto back to an evaluated node: the same EVAL and the same child. Branching,
// going back to the original path and going on gives the text of a session
// that never branched.
void test_goto_same_text() {
    const std::string prompt = "Tell me a story";
    const uint32_t P = last_prompt_node(prompt);
    FakeModel ref;
    Log rlog;
    Session r(ref, nullptr, rlog);
    send(r, {{"cmd", "speed"}, {"tps", 0}});
    send(r, start_cmd(prompt, {{"max_tokens", 12}}));
    send(r, {{"cmd", "run"}});
    CHECK(idle(r));
    const Bytes rsnap = rlog.snapshot();
    const std::vector<uint32_t> want = model_tokens(rsnap);
    const std::vector<EvalView> rev = evals(rsnap);
    CHECK_EQ(want.size(), 12u);
    CHECK_EQ(rev.size(), 12u);

    FakeModel model;
    Log log;
    Events ev;
    Session s(model, nullptr, log, ev.sinks());
    send(s, {{"cmd", "speed"}, {"tps", 0}});
    send(s, start_cmd(prompt, {{"max_tokens", 12}}));
    for (int i = 0; i < 4; ++i) send(s, {{"cmd", "step"}});  // cursor on P + 4
    send(s, goto_cmd(P + 2));
    CHECK(idle(s));
    CHECK((types(batches(log).back()) == std::vector<FrameType>{FrameType::Cursor}));
    send(s, {{"cmd", "step"}});
    CHECK(idle(s));
    CHECK(ev.take().empty());
    CHECK((shape(batches(log).back()) == std::vector<FrameType>{FrameType::Eval, FrameType::Cursor}));
    std::vector<EvalView> es = evals(log.snapshot());
    CHECK_EQ(es.size(), 5u);
    CHECK_EQ(es.back().node, P + 2);
    CHECK(same_eval(es.back(), es[2]));
    CHECK_EQ(last_cursor(log.snapshot()).first, P + 3);

    // A branch, three steps on it, then back to where the text was.
    send(s, branch_cmd(P + 3, es[3].entries[1].token));
    for (int i = 0; i < 3; ++i) send(s, {{"cmd", "step"}});
    send(s, goto_cmd(P + 4));
    CHECK(idle(s));
    const size_t before = evals(log.snapshot()).size();
    send(s, {{"cmd", "run"}});
    CHECK(idle(s));
    CHECK(ev.take().empty());
    const Bytes snap = log.snapshot();
    check_log_rules(snap);
    std::vector<int32_t> expected = model.tokenize_prompt(prompt, false, "");
    for (uint32_t t : want) expected.push_back(static_cast<int32_t>(t));
    CHECK(path_to(snap, last_cursor(snap).first) == expected);
    es = evals(snap);
    CHECK_EQ(es.size() - before, 8u);
    for (size_t i = before; i < es.size(); ++i) CHECK(same_eval(es[i], rev[4 + i - before]));
}

// Two models. Lockstep: whatever "slots" says, both move. Free: only those
// asked for; a model alone on a node the other evaluated earlier gets an
// approximate PAIR, unless the node has an exact one.
void test_branch_two_models() {
    const std::string prompt = "Tell me a story";
    const uint32_t P = last_prompt_node(prompt);
    {
        FakeModel a, b(variant_options(1));
        Log log;
        Events ev;
        Session s(a, &b, log, ev.sinks());
        send(s, start_cmd(prompt, {{"max_tokens", 50}}));
        send(s, {{"cmd", "step"}});
        send(s, {{"cmd", "step"}});
        CHECK(idle(s));
        CHECK(ev.take().empty());
        const Bytes before = log.snapshot();
        send(s, goto_cmd(P));  // two models: "slots" is required
        CHECK(idle(s));
        CHECK(error_msg(ev, "goto").find("\"slots\"") != std::string::npos);
        send(s, goto_cmd(P, "BA"));
        CHECK(idle(s));
        CHECK(one_error(ev, "goto"));
        CHECK(log.snapshot() == before);

        send(s, goto_cmd(P, "A"));
        CHECK(idle(s));
        CHECK(ev.take().empty());
        CHECK((types(batches(log).back()) == std::vector<FrameType>{FrameType::Cursor}));
        CHECK((last_cursor(log.snapshot()) == std::pair<uint32_t, uint32_t>{P, P}));
        const uint32_t alt = eval_at(log.snapshot(), P + 1, SLOT_A).entries[1].token;
        send(s, branch_cmd(P + 1, alt, "B"));
        CHECK(idle(s));
        CHECK(ev.take().empty());
        CHECK((shape(batches(log).back()) == std::vector<FrameType>{FrameType::Node, FrameType::Cursor}));
        const auto cur = last_cursor(log.snapshot());
        CHECK_EQ(cur.first, cur.second);
        CHECK_EQ(cur.first, s.status().nodes - 1);
        send(s, {{"cmd", "step"}});
        CHECK(idle(s));
        CHECK(ev.take().empty());
        CHECK((shape(batches(log).back()) == std::vector<FrameType>{FrameType::Eval, FrameType::Eval, FrameType::Pair,
                                                                     FrameType::Node, FrameType::Cursor}));
        check_log_rules(log.snapshot(), 2);
    }
    {
        FakeModel a, b(variant_options(1));
        Log log;
        Events ev;
        Session s(a, &b, log, ev.sinks());
        send(s, start_cmd(prompt, {{"max_tokens", 50}, {"mode", "free"}}));
        send(s, {{"cmd", "step"}});  // both evaluate P: an exact PAIR
        CHECK(idle(s));
        const auto c1 = last_cursor(log.snapshot());

        // B back to P: only B moves; P has an exact PAIR, so no PAIR there.
        send(s, goto_cmd(P, "B"));
        CHECK(idle(s));
        CHECK((types(batches(log).back()) == std::vector<FrameType>{FrameType::Cursor}));
        CHECK((last_cursor(log.snapshot()) == std::pair<uint32_t, uint32_t>{c1.first, P}));
        send(s, {{"cmd", "step"}});
        CHECK(idle(s));
        std::vector<FrameType> t = shape(batches(log).back());
        CHECK(std::count(t.begin(), t.end(), FrameType::Pair) == 0);
        std::vector<EvalView> es = evals(batches(log).back());
        CHECK(es.size() == 2 && es[0].node == c1.first && es[1].node == P);
        const auto c2 = last_cursor(log.snapshot());

        // B to the node A evaluated alone: an approximate PAIR in B's step.
        send(s, goto_cmd(c1.first, "B"));
        CHECK(idle(s));
        CHECK((last_cursor(log.snapshot()) == std::pair<uint32_t, uint32_t>{c2.first, c1.first}));
        send(s, {{"cmd", "step"}});
        CHECK(idle(s));
        CHECK(ev.take().empty());
        t = shape(batches(log).back());
        CHECK(t.size() >= 3 && t[0] == FrameType::Eval && t[1] == FrameType::Eval && t[2] == FrameType::Pair);
        CHECK(std::count(t.begin(), t.end(), FrameType::Pair) == 1);
        PairView p{};
        for (const FrameView& f : frames(batches(log).back()))
            if (f.type == FrameType::Pair) p = pair_of(f);
        CHECK_EQ(p.node, c1.first);
        CHECK(p.flags & PAIR_APPROX);
        CHECK(p.js > 0);  // the numbers against the two lists: check_log_rules

        // "AB" moves both.
        send(s, goto_cmd(P, "AB"));
        CHECK(idle(s));
        CHECK((last_cursor(log.snapshot()) == std::pair<uint32_t, uint32_t>{P, P}));
        CHECK(ev.take().empty());
        check_log_rules(log.snapshot(), 2);
    }
}

// An exact PAIR is written again, with its "same pick" bit corrected, when a
// model evaluates the node once more and picks another token (a new seed).
void test_exact_pair_same_pick_refreshed() {
    const std::string prompt = "Tell me a story";
    const uint32_t P = last_prompt_node(prompt);
    FakeModel a, b(variant_options(1));
    Log log;
    Events ev;
    Session s(a, &b, log, ev.sinks());
    const json gates = json::array({{{"type", "temp"}, {"t", 1.5}}});
    send(s, start_cmd(prompt, {{"max_tokens", 200}, {"mode", "free"}, {"seed", 1}, {"gates", gates}}));
    send(s, {{"cmd", "step"}});  // both evaluate P: an exact PAIR
    CHECK(idle(s));
    PairView first{};
    for (const FrameView& f : frames(batches(log).back()))
        if (f.type == FrameType::Pair) first = pair_of(f);
    CHECK_EQ(first.node, P);
    CHECK(!(first.flags & PAIR_APPROX));
    bool same = (first.flags & PAIR_SAME_PICK) != 0;
    const uint32_t pick_a = eval_at(log.snapshot(), P, SLOT_A).pick_token();

    int rewritten = 0;
    for (uint32_t seed = 2; seed < 40; ++seed) {
        send(s, {{"cmd", "config"}, {"config", {{"seed", seed}}}});
        send(s, goto_cmd(P, "B"));
        send(s, {{"cmd", "step"}});
        CHECK(idle(s));
        uint32_t pick_b = 0;
        std::vector<PairView> pairs;
        for (const FrameView& f : frames(batches(log).back())) {
            if (f.type == FrameType::Eval && eval_of(f).node == P) pick_b = eval_of(f).pick_token();
            if (f.type == FrameType::Pair && pair_of(f).node == P) pairs.push_back(pair_of(f));
        }
        const bool now = pick_a == pick_b;
        if (now == same) {
            CHECK(pairs.empty());
            continue;
        }
        CHECK_EQ(pairs.size(), 1u);
        if (pairs.size() == 1) {
            CHECK(!(pairs[0].flags & PAIR_APPROX));
            CHECK_EQ((pairs[0].flags & PAIR_SAME_PICK) != 0, now);
            CHECK_EQ(pairs[0].js, first.js);
            CHECK_EQ(pairs[0].kl_ab, first.kl_ab);
            CHECK_EQ(pairs[0].rank_a_in_b, first.rank_a_in_b);
        }
        same = now;
        ++rewritten;
    }
    CHECK(rewritten >= 1);
    CHECK(ev.take().empty());
    check_log_rules(log.snapshot(), 2);
}

// A fake model whose numbers drift once told to: a re-evaluation that does
// not give back the first EVAL, for --verify-seek.
class DriftModel : public FakeModel {
public:
    std::atomic<bool> drift{false};
    void eval(const std::vector<int32_t>& path, EvalOutput& out) override {
        FakeModel::eval(path, out);
        if (drift)
            for (size_t t = 0; t < out.logits.size(); ++t) out.logits[t] += 0.3f * static_cast<float>(t % 5);
    }
};

// --verify-seek: exact re-evaluations are checked and counted; a difference
// is a warning and a mismatch.
void test_verify_seek() {
    const std::string prompt = "Tell me a story";
    const uint32_t P = last_prompt_node(prompt);
    {
        FakeModel model;
        Log log;
        Events ev;
        Session s(model, nullptr, log, ev.sinks(), {}, SessionOptions{true});
        send(s, start_cmd(prompt, {{"max_tokens", 100}}));
        for (int i = 0; i < 10; ++i) send(s, {{"cmd", "step"}});  // P to P + 9 evaluated
        CHECK(idle(s));
        CHECK_EQ(s.seek_stats().verified, 0u);
        const Bytes snap = log.snapshot();
        for (uint32_t i = 0; i < 20; ++i) {
            if (i % 2 == 0) {
                send(s, goto_cmd(P + (i * 3) % 10));
            } else {
                const uint32_t parent = P + i % 9;  // to a child that has been evaluated
                send(s, branch_cmd(parent, eval_at(snap, parent).pick_token()));
            }
            send(s, {{"cmd", "step"}});
        }
        CHECK(idle(s));
        CHECK(ev.take().empty());
        const SeekStats st = s.seek_stats();
        CHECK_EQ(st.verified, 20u);
        CHECK_EQ(st.mismatches, 0u);
        check_log_rules(log.snapshot());

        // Without the option nothing is counted.
        FakeModel m2;
        Log log2;
        Session s2(m2, nullptr, log2);
        send(s2, start_cmd(prompt));
        send(s2, {{"cmd", "step"}});
        send(s2, goto_cmd(P));
        send(s2, {{"cmd", "step"}});
        CHECK(idle(s2));
        CHECK_EQ(s2.seek_stats().verified, 0u);
    }
    {
        DriftModel model;
        Log log;
        Events ev;
        Session s(model, nullptr, log, ev.sinks(), {}, SessionOptions{true});
        send(s, start_cmd(prompt));
        for (int i = 0; i < 3; ++i) send(s, {{"cmd", "step"}});
        CHECK(idle(s));
        model.drift = true;
        send(s, goto_cmd(P + 1));
        send(s, {{"cmd", "step"}});
        CHECK(idle(s));
        const std::vector<json> l = ev.take();
        CHECK_EQ(l.size(), 1u);
        if (!l.empty()) {
            CHECK_EQ(l[0]["ev"].get<std::string>(), std::string("warning"));
            CHECK_EQ(l[0]["msg"].get<std::string>(), "seek mismatch at node " + std::to_string(P + 1));
        }
        CHECK_EQ(s.seek_stats().verified, 1u);
        CHECK_EQ(s.seek_stats().mismatches, 1u);
    }
    {
        // Two models in lockstep: each model is checked; the warning names it.
        FakeModel a;
        DriftModel b;
        Log log;
        Events ev;
        Session s(a, &b, log, ev.sinks(), {}, SessionOptions{true});
        send(s, start_cmd(prompt));
        for (int i = 0; i < 3; ++i) send(s, {{"cmd", "step"}});
        send(s, goto_cmd(P, "A"));
        send(s, {{"cmd", "step"}});
        CHECK(idle(s));
        CHECK(ev.take().empty());
        CHECK_EQ(s.seek_stats().verified, 2u);
        b.drift = true;
        send(s, goto_cmd(P + 2, "AB"));
        send(s, {{"cmd", "step"}});
        CHECK(idle(s));
        const std::vector<json> l = ev.take();
        CHECK_EQ(l.size(), 1u);
        if (!l.empty())
            CHECK_EQ(l[0]["msg"].get<std::string>(), "model B: seek mismatch at node " + std::to_string(P + 2));
        CHECK_EQ(s.seek_stats().verified, 4u);
        CHECK_EQ(s.seek_stats().mismatches, 1u);
        check_log_rules(log.snapshot(), 2);
    }
}

// Gates and branches together: with penalties, a
// grammar and a seeded draw, the EVALs after a branch or a goto are those of
// a session that generated the same path straight on, whose chain only ever
// took the next token. A branch to a token the grammar refuses changes nothing.
void test_gates_after_branch() {
    const std::string prompt = " the dog";
    const uint32_t P = last_prompt_node(prompt);
    const uint32_t m = P + 3;  // where the branch goes off
    const json gates = json::array({gate("penalties", {{"repeat", 1.3}, {"presence", 0.4}}),
                                    gate("grammar", {{"gbnf", LOWER}}), gate("temp", {{"t", 1.5}})});
    const uint64_t seed = 11;
    const json cfg = {{"max_tokens", 100}, {"seed", seed}, {"gates", gates}};

    // Straight on, 12 steps: EVALs of P to P + 11.
    FakeModel rm;
    Log rlog;
    Events rev_ev;
    Session r(rm, nullptr, rlog, rev_ev.sinks());
    send(r, start_cmd(prompt, cfg));
    for (int i = 0; i < 12; ++i) send(r, {{"cmd", "step"}});
    CHECK(idle(r));
    CHECK(rev_ev.take().empty());
    const std::vector<EvalView> ref = evals(rlog.snapshot());
    CHECK_EQ(ref.size(), 12u);
    if (ref.size() != 12) return;

    // Straight on too, but with another seed for the step at m: another
    // token there, and the chain untouched (a seed alone rebuilds nothing).
    uint32_t alt = 0;
    std::vector<EvalView> alt_ref;
    for (uint64_t s2 = 100; s2 < 200 && alt_ref.empty(); ++s2) {
        FakeModel am;
        Log alog;
        Events aev;
        Session as(am, nullptr, alog, aev.sinks());
        send(as, start_cmd(prompt, cfg));
        for (int i = 0; i < 3; ++i) send(as, {{"cmd", "step"}});
        send(as, config_cmd({{"seed", s2}}));
        send(as, {{"cmd", "step"}});
        send(as, config_cmd({{"seed", seed}}));
        for (int i = 0; i < 5; ++i) send(as, {{"cmd", "step"}});
        CHECK(idle(as));
        CHECK(aev.take().empty());
        const std::vector<EvalView> es = evals(alog.snapshot());
        if (es.size() != 9 || es[3].pick_token() == ref[3].pick_token()) continue;
        alt = es[3].pick_token();
        alt_ref.assign(es.begin() + 4, es.end());
    }
    CHECK(!alt_ref.empty());
    if (alt_ref.empty()) return;

    FakeModel model;
    Log log;
    Events ev;
    Session s(model, nullptr, log, ev.sinks());
    send(s, start_cmd(prompt, cfg));
    for (int i = 0; i < 6; ++i) send(s, {{"cmd", "step"}});  // cursor on P + 6
    CHECK(idle(s));
    CHECK(ev.take().empty());

    // A token the grammar refuses: an error; no node, cursor or frame changes.
    const Bytes before = log.snapshot();
    const uint32_t nodes = s.status().nodes;
    send(s, branch_cmd(m, FakeModel::BYTE0 + 'X'));
    CHECK(idle(s));
    CHECK(one_error(ev, "branch"));
    CHECK(log.snapshot() == before);
    CHECK_EQ(s.status().nodes, nodes);
    send(s, {{"cmd", "step"}});  // from the same cursor, with the same chain
    CHECK(idle(s));
    CHECK(ev.take().empty());
    std::vector<EvalView> es = evals(log.snapshot());
    CHECK(es.back().node == P + 6 && same_eval(es.back(), ref[6]));

    // The branch, five steps on it: as straight on.
    send(s, branch_cmd(m, alt));
    for (int i = 0; i < 5; ++i) send(s, {{"cmd", "step"}});
    CHECK(idle(s));
    CHECK(ev.take().empty());
    es = evals(log.snapshot());
    CHECK_EQ(es.size(), 12u);
    for (size_t i = 0; i < 5 && i + 7 < es.size(); ++i) CHECK(same_eval(es[7 + i], alt_ref[i]));

    // Back to the original path: as straight on.
    send(s, goto_cmd(P + 7));
    for (int i = 0; i < 4; ++i) send(s, {{"cmd", "step"}});
    CHECK(idle(s));
    CHECK(ev.take().empty());
    es = evals(log.snapshot());
    CHECK_EQ(es.size(), 16u);
    CHECK_EQ(es[12].node, P + 7);
    for (size_t i = 12; i < es.size(); ++i) CHECK(same_eval(es[i], ref[7 + (i - 12)]));
    check_log_rules(log.snapshot());
}

}  // namespace

// ------------------------------------------------------------- logit lens

FakeOptions lens_options(uint64_t variant = 0, int32_t n_layer = 4) {
    FakeOptions o = variant_options(variant);
    o.lens = true;
    o.n_layer = n_layer;
    return o;
}

// The HELLO of a log: lens on with these layers, or off.
void check_hello_lens(const Bytes& log, const std::vector<int32_t>& layers) {
    const json h = body_json(frames(log)[0]);
    CHECK_EQ(h["lens"]["enabled"].get<bool>(), !layers.empty());
    CHECK(h["lens"]["layers"].get<std::vector<int32_t>>() == layers);
}

// One model with the lens: HELLO announces it (and keeps announcing it after
// a new start), every EVAL has one entry per layer, every token of the lens
// has its VOCAB first (check_log_rules), and the answer is the model's most
// likely token, not the pick of the gates.
void test_lens_one_model() {
    FakeOptions o = lens_options();
    o.lens_warning = "lens note";
    FakeModel model(o);
    Log log;
    Events ev;
    Session s(model, nullptr, log, ev.sinks(), {"engine warning"});
    check_hello_lens(log.snapshot(), {0, 1, 2, 3});
    const json h = body_json(frames(log.snapshot())[0]);
    CHECK(h["warnings"] == json::array({"engine warning", "lens note"}));
    CHECK_EQ(model.lens_disabled, 0);

    send(s, {{"cmd", "speed"}, {"tps", 0}});
    send(s, start_cmd("Tell me a story",
                      {{"max_tokens", 40}, {"seed", 3}, {"gates", {gate("top_k", {{"k", 8}}), gate("temp", {{"t", 2.0}})}}}));
    send(s, {{"cmd", "run"}});
    CHECK(idle(s));
    CHECK(ev.take().empty());
    const Bytes snap = log.snapshot();
    check_log_rules(snap);
    check_hello_lens(snap, {0, 1, 2, 3});
    const std::vector<EvalView> es = evals(snap);
    CHECK_EQ(es.size(), 40u);
    int outside = 0, pick_not_top = 0;
    for (const EvalView& e : es) {
        CHECK(e.flags & EVAL_LENS);
        CHECK_EQ(e.lens.size(), 4u);
        if (e.lens.size() != 4) continue;
        const LensLayer& last = e.lens.back();
        CHECK_EQ(last.top_id, e.entries[0].token);
        CHECK_NEAR(last.answer_p, e.entries[0].p_raw, 1e-5);
        CHECK_NEAR(last.entropy, e.entropy, 1e-4);
        for (size_t i = 1; i < e.lens.size(); ++i) CHECK(e.lens[i].answer_p > e.lens[i - 1].answer_p);
        for (const LensLayer& l : e.lens) {
            bool candidate = false;
            for (const Candidate& c : e.entries) candidate = candidate || c.token == l.top_id;
            if (!candidate) ++outside;
        }
        if (e.pick != 0) ++pick_not_top;
    }
    CHECK(outside > 0);       // the VOCAB path for tokens that are not candidates is used
    CHECK(pick_not_top > 0);  // and the answer was entries[0] even then
}

// Two models: the same layers turn the lens on for both; different numbers
// of layers, or a model without the lens, turn it off with a warning, and
// then no EVAL carries the section.
void test_lens_pair() {
    {
        FakeModel a(lens_options()), b(lens_options(1));
        Log log;
        Events ev;
        Session s(a, &b, log, ev.sinks());
        check_hello_lens(log.snapshot(), {0, 1, 2, 3});
        CHECK(body_json(frames(log.snapshot())[0])["warnings"].empty());
        send(s, {{"cmd", "speed"}, {"tps", 0}});
        send(s, start_cmd("Tell me a story", {{"max_tokens", 20}}));
        send(s, {{"cmd", "run"}});
        CHECK(idle(s));
        CHECK(ev.take().empty());
        const Bytes snap = log.snapshot();
        check_log_rules(snap, 2);
        const std::vector<EvalView> es = evals(snap);
        CHECK_EQ(es.size(), 40u);
        for (const EvalView& e : es) CHECK_EQ(e.lens.size(), 4u);
    }
    struct Case {
        FakeOptions a, b;
        const char* why;
    };
    FakeOptions plain_b = variant_options(1);
    const Case cases[] = {
        {lens_options(0, 4), lens_options(1, 12), "A has 4 layers and B has 12"},
        {lens_options(0, 4), plain_b, "do not project the same layers"},
        {variant_options(0), lens_options(1), "do not project the same layers"},
    };
    for (const Case& c : cases) {
        FakeModel a(c.a), b(c.b);
        Log log;
        Events ev;
        Session s(a, &b, log, ev.sinks(), {"first"});
        check_hello_lens(log.snapshot(), {});
        const json w = body_json(frames(log.snapshot())[0])["warnings"];
        CHECK_EQ(w.size(), 2u);
        if (w.size() == 2) {
            CHECK_EQ(w[0].get<std::string>(), std::string("first"));
            const std::string msg = w[1];
            CHECK(msg.rfind("logit lens off: ", 0) == 0);
            CHECK(msg.find(c.why) != std::string::npos);
        }
        CHECK(a.lens_layers().empty() && b.lens_layers().empty());
        CHECK_EQ(a.lens_disabled, 1);
        CHECK_EQ(b.lens_disabled, 1);
        send(s, {{"cmd", "speed"}, {"tps", 0}});
        send(s, start_cmd("Tell me a story", {{"max_tokens", 10}}));
        send(s, {{"cmd", "run"}});
        CHECK(idle(s));
        CHECK(ev.take().empty());
        const Bytes snap = log.snapshot();
        check_log_rules(snap, 2);
        check_hello_lens(snap, {});
        for (const EvalView& e : evals(snap)) CHECK(e.lens.empty() && !(e.flags & EVAL_LENS));
    }
    {
        // Neither has the lens: no warning.
        FakeModel a, b(variant_options(1));
        Log log;
        Session s(a, &b, log);
        check_hello_lens(log.snapshot(), {});
        CHECK(body_json(frames(log.snapshot())[0])["warnings"].empty());
    }
}

int main() {
    test_stop_reason();
    test_startup();
    test_start_raw_and_step();
    test_start_chat();
    test_max_tokens();
    test_end_of_generation();
    test_context_full();
    test_decode_failure();
    test_determinism_and_epoch();
    test_speed_and_pacing();
    test_invalid_commands();
    test_pair_startup();
    test_tokenizer_difference();
    test_lockstep("A");
    test_lockstep("B");
    test_identity();
    test_free_split();
    test_free_one_stops();
    test_pair_failure();
    test_config_command();
    test_config_pauses();
    test_config_one_model();
    test_config_full();
    test_grammar_atomicity();
    test_eval_with_gates();
    test_gate_determinism();
    test_accept();
    test_gate_failures();
    test_free_to_lockstep_gates();
    test_config_midsession();
    test_branch_goto_errors();
    test_branch_one_model();
    test_goto_same_text();
    test_branch_two_models();
    test_exact_pair_same_pick_refreshed();
    test_verify_seek();
    test_gates_after_branch();
    test_lens_one_model();
    test_lens_pair();
    return test_result();
}
