#include "session.h"

#include "gates.h"
#include "metrics.h"
#include "tree.h"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <condition_variable>
#include <cstdio>
#include <ctime>
#include <deque>
#include <exception>
#include <future>
#include <limits>
#include <mutex>
#include <stdexcept>
#include <thread>
#include <unordered_map>
#include <unordered_set>

namespace ils {

namespace {

using Clock = std::chrono::steady_clock;
using json = nlohmann::ordered_json;

std::string utc_now_iso8601() {
    const std::time_t t = std::time(nullptr);
    std::tm tm{};
#ifdef _WIN32
    gmtime_s(&tm, &t);
#else
    gmtime_r(&t, &tm);
#endif
    char buf[32];
    std::strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%SZ", &tm);
    return buf;
}

std::string dump(const json& j) { return j.dump(-1, ' ', false, json::error_handler_t::replace); }

std::string error_event(const std::string& cmd, const std::string& msg, bool with_cmd = true) {
    json j;
    j["ev"] = "error";
    if (with_cmd) j["cmd"] = cmd;
    j["msg"] = msg;
    return dump(j);
}

std::string warning_event(const std::string& msg) {
    json j;
    j["ev"] = "warning";
    j["msg"] = msg;
    return dump(j);
}

const char* reason_text(StopReason r) {
    switch (r) {
        case StopReason::EndOfGeneration: return "end of generation";
        case StopReason::MaxTokens: return "max_tokens reached";
        case StopReason::ContextFull: return "context full";
    }
    return "stopped";
}

// A command failure: becomes an `error` event carrying the command name.
struct CommandError : std::runtime_error {
    using std::runtime_error::runtime_error;
};

const char* slot_name(int slot) { return slot == 0 ? "A" : "B"; }

// Runs fa() here and, if `both`, fb() at the same time on a helper thread:
// each model decodes on its own thread, so the two decodings overlap.
// Rethrows A's exception first, then B's.
template <class FA, class FB>
void run_pair(bool both, FA&& fa, FB&& fb) {
    if (!both) {
        fa();
        return;
    }
    std::future<void> b = std::async(std::launch::async, std::forward<FB>(fb));
    try {
        fa();
    } catch (...) {
        b.wait();  // B uses the caller's data: never leave it running
        throw;
    }
    b.get();
}

}  // namespace

const char* to_string(RunState s) {
    switch (s) {
        case RunState::Idle: return "idle";
        case RunState::Running: return "running";
        case RunState::Paused: return "paused";
    }
    return "idle";
}

std::optional<StopReason> stop_reason(uint32_t depth, uint32_t prompt_len, uint8_t origin, bool is_eog,
                                      uint32_t max_tokens, uint32_t n_ctx) {
    if (origin != ORIGIN_PROMPT && is_eog) return StopReason::EndOfGeneration;
    uint32_t generated = 0;
    if (origin != ORIGIN_PROMPT && depth + 1 > prompt_len) generated = depth + 1 - prompt_len;
    if (generated >= max_tokens) return StopReason::MaxTokens;
    if (depth >= n_ctx) return StopReason::ContextFull;
    return std::nullopt;
}

std::optional<std::string> tokenizer_difference(const Model& a, const Model& b) {
    const uint32_t n = a.n_vocab();
    if (n != b.n_vocab()) {
        return "A has " + std::to_string(n) + " tokens and B has " + std::to_string(b.n_vocab());
    }
    for (uint32_t i = 0; i < n; ++i) {
        const int32_t t = static_cast<int32_t>(i);
        if (a.piece(t) != b.piece(t)) return "token " + std::to_string(i) + " has a different text";
        if (a.attr(t) != b.attr(t)) return "token " + std::to_string(i) + " has different attributes";
    }
    return std::nullopt;
}

struct Session::Impl {
    Model* models[2] = {nullptr, nullptr};
    int n_models = 1;
    Log& log;
    Sinks sinks;
    const SessionOptions options;
    uint32_t n_vocab = 0;
    uint32_t n_ctx[2] = {0, 0};
    size_t n_lens = 0;  // layers of the logit lens in every EVAL; 0: off (HELLO lens)

    // Shared with other threads, under `mu`.
    mutable std::mutex mu;
    std::condition_variable cv;
    std::deque<std::string> queue;
    bool stopping = false;
    bool busy = false;  // a command or a step is being run
    RunState state = RunState::Idle;
    double tps = 0;
    double tps_limit = DEFAULT_TPS_LIMIT;
    uint32_t nodes = 0;
    SeekStats seek;

    // Coordinator thread only.
    Hello hello;
    Config config;
    Tree tree;
    uint32_t cursor[2] = {NONE, NONE};  // B's stays NONE with one model
    uint32_t prompt_len = 0;
    // Each model's gates, with the state of the path to chain_node[s]. When
    // that is not the model's cursor (NONE: the state is unknown, after a
    // failed accept) the chain is rebuilt before the model steps.
    GateChain chains[2];
    uint32_t chain_node[2] = {NONE, NONE};
    std::unordered_set<int32_t> sent_vocab;  // tokens already in a VOCAB of this log
    // The candidates of the last EVAL each model wrote for each node, for the
    // approximate PAIR (compare_candidates, metrics.h) and for
    // --verify-seek; and the nodes that have an exact PAIR. Emptied by `start`.
    struct Stored {
        std::vector<Candidate> entries;  // main candidates, then the added ones
        size_t n_main = 0;
        int32_t pick_token = 0;
    };
    std::unordered_map<uint32_t, Stored> stored[2];
    std::unordered_map<uint32_t, PairRec> exact_pair;
    Clock::time_point session_start;
    bool has_last_step = false;
    Clock::time_point last_step_start;
    Clock::time_point next_tick;
    std::deque<Clock::time_point> step_times;  // ends of the steps of the last second

    std::thread thread;

    Impl(Model& a, Model* b, Log& l, Sinks s, SessionOptions o) : log(l), sinks(std::move(s)), options(o) {
        models[0] = &a;
        models[1] = b;
        n_models = b ? 2 : 1;
    }

    uint32_t t_ms() const {
        const auto d = std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - session_start);
        return static_cast<uint32_t>(std::min<int64_t>(d.count(), std::numeric_limits<uint32_t>::max()));
    }

    void emit(const std::string& ev) {
        if (sinks.event) sinks.event(ev);
    }

    void notify_status() {
        if (sinks.status_changed) sinks.status_changed();
    }

    void set_state(RunState s) {
        std::lock_guard<std::mutex> lk(mu);
        state = s;
        if (s != RunState::Running) tps = 0;
        nodes = static_cast<uint32_t>(tree.size());
    }

    RunState get_state() const {
        std::lock_guard<std::mutex> lk(mu);
        return state;
    }

    std::optional<StopReason> stop_at(int slot, uint32_t id) const {
        const Node& n = tree.at(id);
        const bool eog = (models[slot]->attr(n.token) & ATTR_EOG) != 0;
        return stop_reason(n.depth, prompt_len, n.origin, eog, config.max_tokens, n_ctx[slot]);
    }

    bool lockstep() const { return n_models == 2 && config.mode == "lockstep"; }
    int driver() const { return config.driver == "B" ? 1 : 0; }

    // The slots that can step from their cursors. In lockstep both cursors
    // are on the same node and stop together: both or neither.
    void active_slots(bool active[2]) const {
        for (int s = 0; s < 2; ++s) active[s] = s < n_models && cursor[s] != NONE && !stop_at(s, cursor[s]);
        if (lockstep() && !(active[0] && active[1])) active[0] = active[1] = false;
    }

    bool can_step() const {
        bool active[2];
        active_slots(active);
        return active[0] || active[1];
    }

    // Appends a VOCAB with the tokens of `tokens` not sent yet in this log.
    // A and B share the tokenizer: A's texts serve both.
    void add_vocab(Bytes& batch, uint32_t t, const std::vector<int32_t>& tokens) {
        std::vector<VocabEntry> entries;
        for (int32_t tok : tokens) {
            if (!sent_vocab.insert(tok).second) continue;
            entries.push_back({static_cast<uint32_t>(tok), models[0]->attr(tok), models[0]->piece(tok)});
        }
        if (!entries.empty()) write_vocab(batch, t, entries);
    }

    void write_node_rec(Bytes& batch, uint32_t t, const Node& n) {
        write_node(batch, t, {n.id, n.parent, static_cast<uint32_t>(n.token), n.depth, n.origin});
    }

    void write_cursors(Bytes& batch, uint32_t t) { write_cursor(batch, t, cursor[0], n_models == 2 ? cursor[1] : NONE); }

    // ------------------------------------------------------------------ gates

    // A new chain of `specs` for model `s`, with the state it has after
    // `path` (penalties see the whole path, grammar only the generated
    // tokens). Touches nothing: callers build every chain they need first
    // and replace the old ones only when none has thrown, so a command that
    // fails (invalid grammar, a grammar that rejects the path) changes nothing.
    GateChain make_chain(int s, const std::vector<GateSpec>& specs, const std::vector<int32_t>& path,
                         size_t plen) const {
        try {
            return GateChain(*models[s], specs, path, plen);
        } catch (const std::exception& e) {
            if (n_models == 2) throw CommandError(std::string("model ") + slot_name(s) + ": " + e.what());
            throw;
        }
    }

    // The chain of model `s` for the path to `node` of the current tree
    // (NONE: an empty path, which only checks that the gates can be built).
    // Used by `config`, `goto` and the step.
    GateChain build_chain(int s, const std::vector<GateSpec>& specs, uint32_t node) const {
        return make_chain(s, specs, node == NONE ? std::vector<int32_t>() : tree.path_tokens(node), prompt_len);
    }

    // Replaces the chain of model `s` by one built for `node`.
    void set_chain(int s, GateChain&& chain, uint32_t node) {
        chains[s] = std::move(chain);
        chain_node[s] = node;
    }

    // --------------------------------------------------------------- commands

    void handle(const std::string& text) {
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
            if (cmd == "start") {
                cmd_start(j);
            } else if (cmd == "run") {
                check_can_step();
                if (get_state() != RunState::Running) {
                    next_tick = Clock::now() + std::chrono::seconds(1);
                    step_times.clear();
                    set_state(RunState::Running);
                    notify_status();
                }
            } else if (cmd == "step") {
                check_can_step();
                if (do_step()) {
                    set_state(RunState::Paused);
                    notify_status();
                }
            } else if (cmd == "pause") {
                if (get_state() == RunState::Running) {
                    set_state(RunState::Paused);
                    notify_status();
                }
            } else if (cmd == "speed") {
                const auto t = j.find("tps");
                if (t == j.end() || !t->is_number() || !(t->get<double>() >= 0) ||
                    t->get<double>() > 1e6) {
                    throw CommandError("\"tps\" must be a number >= 0");
                }
                {
                    std::lock_guard<std::mutex> lk(mu);
                    tps_limit = t->get<double>();
                }
                notify_status();
            } else if (cmd == "config") {
                cmd_config(j);
            } else if (cmd == "branch") {
                cmd_branch(j);
            } else if (cmd == "goto") {
                cmd_goto(j);
            } else {
                throw CommandError("unknown command");
            }
        } catch (const std::exception& e) {
            emit(error_event(cmd, e.what()));
        }
    }

    void check_can_step() {
        if (cursor[0] == NONE) throw CommandError("no prompt yet");
        if (can_step()) return;
        std::string msg = "cannot continue";
        for (int s = 0; s < n_models; ++s) {
            if (auto r = stop_at(s, cursor[s])) {
                msg += std::string(s == 0 ? ": " : "; ");
                if (n_models == 2) msg += std::string("model ") + slot_name(s) + " ";
                msg += "from node " + std::to_string(cursor[s]) + ": " + reason_text(*r);
            }
        }
        throw CommandError(msg);
    }

    // Reads "mode" and "driver" of a config object into `cfg`. Strict: any
    // other value is an error.
    static void parse_mode_driver(const json& c, Config& cfg) {
        if (const auto m = c.find("mode"); m != c.end()) {
            if (!m->is_string() || (*m != "lockstep" && *m != "free"))
                throw CommandError("\"mode\" must be \"lockstep\" or \"free\"");
            cfg.mode = m->get<std::string>();
        }
        if (const auto d = c.find("driver"); d != c.end()) {
            if (!d->is_string() || (*d != "A" && *d != "B")) throw CommandError("\"driver\" must be \"A\" or \"B\"");
            cfg.driver = d->get<std::string>();
        }
    }

    // Reads "max_tokens", "seed" and "gates" of a config object into `cfg`.
    // Strict: any wrong value is an error. A null "gates" is no "gates".
    // Returns whether the object has "gates".
    static bool parse_settings(const json& c, Config& cfg) {
        if (const auto m = c.find("max_tokens"); m != c.end()) {
            if (!m->is_number_integer() || m->get<int64_t>() < 0 ||
                m->get<int64_t>() > std::numeric_limits<uint32_t>::max()) {
                throw CommandError("\"max_tokens\" must be an integer >= 0");
            }
            cfg.max_tokens = static_cast<uint32_t>(m->get<int64_t>());
        }
        if (const auto s = c.find("seed"); s != c.end()) {
            if (!s->is_number_unsigned()) throw CommandError("\"seed\" must be an integer >= 0");
            cfg.seed = s->get<uint64_t>();
        }
        const auto g = c.find("gates");
        if (g == c.end() || g->is_null()) return false;
        cfg.gates = parse_gates(*g);
        return true;
    }

    void cmd_start(const json& j) {
        const auto p = j.find("prompt");
        if (p == j.end() || !p->is_string()) throw CommandError("\"prompt\" is required");
        bool chat = false;
        if (const auto f = j.find("format"); f != j.end()) {
            if (*f == "chat") chat = true;
            else if (*f != "raw") throw CommandError("\"format\" must be \"raw\" or \"chat\"");
        }
        std::string system;
        if (const auto s = j.find("system"); s != j.end() && !s->is_null()) {
            if (!s->is_string()) throw CommandError("\"system\" must be a string");
            if (chat) system = s->get<std::string>();
        }

        Config cfg;  // defaults, then what the command sets
        if (const auto c = j.find("config"); c != j.end() && !c->is_null()) {
            if (!c->is_object()) throw CommandError("\"config\" must be an object");
            parse_settings(*c, cfg);
            if (n_models == 2) parse_mode_driver(*c, cfg);  // one model: no modes, ignored
        }

        std::vector<int32_t> tokens;
        try {
            tokens = models[0]->tokenize_prompt(p->get<std::string>(), chat, system);
        } catch (const std::exception& e) {
            throw CommandError(std::string("cannot tokenize the prompt: ") + e.what());
        }
        if (tokens.empty()) throw CommandError("the prompt has no tokens");
        for (int s = 0; s < n_models; ++s) {
            if (tokens.size() > n_ctx[s]) {
                throw CommandError("the prompt has " + std::to_string(tokens.size()) + " tokens; the context" +
                                   (n_models == 2 ? std::string(" of model ") + slot_name(s) : std::string()) +
                                   " holds " + std::to_string(n_ctx[s]));
            }
        }
        // The gates with the prompt's path (penalties take it, a grammar does
        // not), before anything changes: an invalid grammar fails the start
        // and the old session stays.
        GateChain built[2];
        for (int s = 0; s < n_models; ++s) built[s] = make_chain(s, cfg.gates, tokens, tokens.size());

        const std::vector<int32_t> head(tokens.begin(), tokens.end() - 1);
        try {
            run_pair(n_models == 2, [&] { models[0]->prefill(head); }, [&] { models[1]->prefill(head); });
        } catch (const std::exception& e) {
            throw CommandError(std::string("cannot decode the prompt: ") + e.what());
        }

        // Nothing can fail from here on: the new session replaces the old one.
        config = cfg;
        tree.clear();
        sent_vocab.clear();
        for (auto& m : stored) m.clear();
        exact_pair.clear();
        prompt_len = static_cast<uint32_t>(tokens.size());
        session_start = Clock::now();
        hello.created = utc_now_iso8601();

        Bytes batch;
        write_hello(batch, 0, hello);
        write_config(batch, 0, config);
        add_vocab(batch, 0, tokens);
        uint32_t parent = NONE;
        for (int32_t tok : tokens) {
            const Node& n = tree.child_or_create(parent, tok, ORIGIN_PROMPT);
            write_node_rec(batch, 0, n);
            parent = n.id;
        }
        cursor[0] = parent;
        cursor[1] = n_models == 2 ? parent : NONE;
        for (int s = 0; s < 2; ++s) set_chain(s, std::move(built[s]), cursor[s]);
        write_cursors(batch, 0);
        write_stops(batch, 0, {true, n_models == 2});
        log.reset(batch);

        set_state(RunState::Paused);
        notify_status();
    }

    // The `config` command: changes the fields it carries and keeps the rest.
    // Mode and driver need two models. All or nothing: the new chains are
    // built before anything changes. Moving a cursor decodes nothing: the
    // model is placed in the next step.
    void cmd_config(const json& j) {
        const auto c = j.find("config");
        if (c == j.end() || !c->is_object()) throw CommandError("\"config\" must be an object");
        if (n_models != 2 && (c->contains("mode") || c->contains("driver"))) throw CommandError("needs two models");
        Config cfg = config;
        parse_mode_driver(*c, cfg);
        const bool new_gates = parse_settings(*c, cfg);

        std::string ignored;
        for (auto it = c->begin(); it != c->end(); ++it) {
            const std::string& k = it.key();
            if (k == "mode" || k == "driver" || k == "seed" || k == "max_tokens" || k == "gates") continue;
            ignored += (ignored.empty() ? "\"" : ", \"") + k + "\"";
        }

        // From free to lockstep: the model that does not drive joins the driver.
        uint32_t next[2] = {cursor[0], cursor[1]};
        if (n_models == 2 && cfg.mode == "lockstep" && cursor[0] != cursor[1]) {
            const int d = cfg.driver == "B" ? 1 : 0;
            next[1 - d] = cursor[d];
        }
        const bool moved = next[0] != cursor[0] || next[1] != cursor[1];

        // New gates: both chains, for the path of each cursor (before the
        // first prompt, an empty path: only the grammar is checked). A moved
        // cursor: its chain, for its new node.
        std::optional<GateChain> built[2];
        for (int s = 0; s < n_models; ++s)
            if (new_gates || next[s] != cursor[s]) built[s] = build_chain(s, cfg.gates, next[s]);

        // Nothing can fail from here on.
        config = cfg;
        for (int s = 0; s < n_models; ++s)
            if (built[s]) set_chain(s, std::move(*built[s]), next[s]);
        cursor[0] = next[0];
        cursor[1] = next[1];
        if (!ignored.empty()) emit(warning_event("unknown " + ignored + " ignored"));

        const uint32_t t = t_ms();
        Bytes batch;
        write_config(batch, t, config);
        if (moved) write_cursors(batch, t);
        log.append(batch);

        if (get_state() == RunState::Running && !can_step()) {
            set_state(RunState::Paused);
            notify_status();
        }
    }

    // ------------------------------------------------------- branch and goto

    // The "node" of a branch or a goto: an existing node not above the last
    // node of the prompt (a cursor never goes back inside the prompt).
    uint32_t parse_node(const json& j) const {
        const auto it = j.find("node");
        if (it == j.end() || !it->is_number_integer()) throw CommandError("\"node\" must be an integer");
        if (!it->is_number_unsigned() || it->get<uint64_t>() >= tree.size())
            throw CommandError("unknown node " + it->dump());
        const uint32_t id = static_cast<uint32_t>(it->get<uint64_t>());
        if (tree.at(id).depth + 1 < prompt_len)
            throw CommandError("node " + std::to_string(id) + " is inside the prompt, before its last node");
        return id;
    }

    // The slots a branch or a goto moves. With one model, A ("slots" may be
    // missing; "B" is an error). With two, "slots" is required, and lockstep
    // always moves both.
    std::array<bool, 2> parse_slots(const json& j) const {
        const auto it = j.find("slots");
        if (it == j.end() && n_models == 1) return {true, false};
        if (it == j.end() || !it->is_string() || (*it != "A" && *it != "B" && *it != "AB"))
            throw CommandError("\"slots\" must be \"A\", \"B\" or \"AB\"");
        if (n_models == 1) {
            if (*it == "B") throw CommandError("there is no model B");
            return {true, false};
        }
        if (lockstep()) return {true, true};
        return {*it != "B", *it != "A"};
    }

    // Moves the cursors of `moved` to `node`, with the chains built for it,
    // and appends CURSOR and the STOPs to `batch`. Then appends the batch and,
    // if nothing can step any more, pauses. Nothing here can fail.
    void move_cursors(std::array<bool, 2> moved, uint32_t node, std::optional<GateChain> (&built)[2],
                      Bytes& batch, uint32_t t) {
        for (int s = 0; s < n_models; ++s) {
            if (!moved[s]) continue;
            set_chain(s, std::move(*built[s]), node);
            cursor[s] = node;
        }
        write_cursors(batch, t);
        write_stops(batch, t, moved);
        log.append(batch);
        {
            std::lock_guard<std::mutex> lk(mu);
            nodes = static_cast<uint32_t>(tree.size());
        }
        if (get_state() == RunState::Running && !can_step()) {
            set_state(RunState::Paused);
            notify_status();
        }
    }

    // `branch`: under `node`, the child with `token` (created with origin 2
    // if it does not exist). All or nothing: the chains for the new path are
    // built first, so a grammar that does not admit it fails the command
    // before the node is created. Moving a cursor decodes nothing.
    void cmd_branch(const json& j) {
        if (cursor[0] == NONE) throw CommandError("no prompt yet");
        const uint32_t parent = parse_node(j);
        // A non-negative integer is unsigned in a parsed JSON; a negative one is not.
        const auto tk = j.find("token");
        if (tk == j.end() || !tk->is_number_unsigned() || tk->get<uint64_t>() >= n_vocab)
            throw CommandError("\"token\" must be an integer from 0 to " + std::to_string(n_vocab - 1));
        const int32_t token = static_cast<int32_t>(tk->get<uint64_t>());
        const std::array<bool, 2> moved = parse_slots(j);

        std::vector<int32_t> path = tree.path_tokens(parent);
        path.push_back(token);
        std::optional<GateChain> built[2];
        for (int s = 0; s < n_models; ++s)
            if (moved[s]) built[s] = make_chain(s, config.gates, path, prompt_len);

        // Nothing can fail from here on.
        bool created = false;
        const Node& child = tree.child_or_create(parent, token, ORIGIN_USER, &created);
        const uint32_t t = t_ms();
        Bytes batch;
        add_vocab(batch, t, {token});
        if (created) write_node_rec(batch, t, child);
        move_cursors(moved, child.id, built, batch, t);
    }

    // `goto`: to an existing node, the same way. A goto to the node the
    // cursor is already on is valid: its chain is rebuilt and CURSOR emitted.
    void cmd_goto(const json& j) {
        if (cursor[0] == NONE) throw CommandError("no prompt yet");
        const uint32_t node = parse_node(j);
        const std::array<bool, 2> moved = parse_slots(j);
        std::optional<GateChain> built[2];
        for (int s = 0; s < n_models; ++s)
            if (moved[s]) built[s] = build_chain(s, config.gates, node);
        Bytes batch;
        move_cursors(moved, node, built, batch, t_ms());
    }

    // STOP frames for the slots in `moved` whose cursor cannot continue. With
    // two models on the same node (always in lockstep), one STOP for both.
    void write_stops(Bytes& batch, uint32_t t, std::array<bool, 2> moved) {
        std::optional<StopReason> r[2];
        for (int s = 0; s < n_models; ++s)
            if (moved[s]) r[s] = stop_at(s, cursor[s]);
        if (n_models == 1) {
            if (r[0]) write_stop(batch, t, cursor[0], SLOT_A, *r[0]);
            return;
        }
        if (moved[0] && moved[1] && cursor[0] == cursor[1] && (r[0] || r[1])) {
            // Lockstep stops both even if only one cannot go on (contexts of different sizes).
            if ((r[0] && r[1]) || lockstep()) {
                write_stop(batch, t, cursor[0], SLOT_BOTH, r[0] ? *r[0] : *r[1]);
                return;
            }
        }
        for (int s = 0; s < 2; ++s)
            if (r[s]) write_stop(batch, t, cursor[s], s == 0 ? SLOT_A : SLOT_B, *r[s]);
    }

    // ------------------------------------------------------------------ step

    // The EVAL of model `s` at its cursor: the main candidates, then the
    // added ones, with what its gates did. Checks the trace against the
    // contract, so that writing the frame cannot fail once the step goes on.
    // Called from the model's own thread: it only reads shared state.
    EvalRec eval_record(int s, const Analysis& an, const EvalOutput& out, const GateTrace& tr) const {
        EvalRec e;
        e.node = cursor[s];
        e.slot = s == 0 ? SLOT_A : SLOT_B;
        e.entropy = static_cast<float>(an.entropy_bits);
        e.raw_mass = static_cast<float>(an.top_mass);
        e.decode_ms = static_cast<float>(out.decode_ms);
        if (tr.extra.size() > MAX_EXTRA) throw std::runtime_error("too many added candidates");
        e.entries.reserve(an.top.size() + tr.extra.size());
        for (const TopCandidate& c : an.top) e.entries.push_back({static_cast<uint32_t>(c.token), static_cast<float>(c.p)});
        for (int32_t tok : tr.extra) {
            if (tok < 0 || static_cast<uint32_t>(tok) >= n_vocab) throw std::runtime_error("added candidate out of range");
            // p_raw of a token outside the main ones: the softmax of its logit.
            const double p = std::exp(static_cast<double>(out.logits[tok]) - an.log_norm);
            e.entries.push_back({static_cast<uint32_t>(tok), static_cast<float>(p)});
        }
        e.n_extra = static_cast<uint8_t>(tr.extra.size());
        const auto it = std::find_if(e.entries.begin(), e.entries.end(),
                                     [&](const Candidate& c) { return c.token == static_cast<uint32_t>(tr.pick); });
        if (it == e.entries.end()) throw std::runtime_error("the pick is not among the candidates");
        e.pick = static_cast<uint8_t>(it - e.entries.begin());
        if (tr.survivors.size() != chains[s].size() || tr.stage_p.size() != tr.survivors.size() * e.entries.size())
            throw std::runtime_error("inconsistent gate trace");
        e.survivors = tr.survivors;
        e.stage_p = tr.stage_p;
        // The logit lens, when on and captured in this step.
        if (n_lens > 0 && !out.lens.empty()) {
            if (out.lens.size() != n_lens) throw std::runtime_error("the logit lens has the wrong number of layers");
            for (const LensLayer& l : out.lens)
                if (l.top_id >= n_vocab) throw std::runtime_error("logit lens token out of range");
            e.lens = out.lens;
        }
        return e;
    }

    static PairRec pair_record(uint32_t node, const Comparison& c, bool same_pick, bool approx) {
        PairRec pr;
        pr.node = node;
        pr.js = static_cast<float>(c.js);
        pr.kl_ab = static_cast<float>(c.kl_ab);
        pr.kl_ba = static_cast<float>(c.kl_ba);
        pr.rank_a_in_b = c.rank_a_in_b;
        pr.rank_b_in_a = c.rank_b_in_a;
        if (c.same_top) pr.flags |= PAIR_SAME_TOP;
        if (same_pick) pr.flags |= PAIR_SAME_PICK;
        if (approx) pr.flags |= PAIR_APPROX;
        return pr;
    }

    // One step from the cursors. On failure: an
    // `error` event without `cmd`, Paused, and the log as it was. Returns
    // false if the step failed or nothing could step.
    bool do_step() {
        bool active[2];
        active_slots(active);
        if (!active[0] && !active[1]) {
            set_state(RunState::Paused);
            notify_status();
            return false;
        }
        const auto start = Clock::now();
        has_last_step = true;
        last_step_start = start;

        EvalOutput out[2];
        EvalRec rec[2];
        int32_t pick[2] = {0, 0};
        std::vector<int32_t> path[2];
        const bool same_node = active[0] && active[1] && cursor[0] == cursor[1];
        std::optional<Comparison> cmp;
        // --verify-seek, per model: whether a stored EVAL was checked, and
        // whether it differed. Set on each model's thread, read afterwards.
        bool verified[2] = {false, false}, mismatch[2] = {false, false};
        try {
            for (int s = 0; s < 2; ++s) {
                if (!active[s]) continue;
                path[s] = tree.path_tokens(cursor[s]);
                // A chain that is not on the cursor's path (after a failed
                // accept): built again from the path.
                if (chain_node[s] != cursor[s]) set_chain(s, make_chain(s, config.gates, path[s], prompt_len), cursor[s]);
            }
            // Each model on its own thread: decoding, analysis and gates.
            auto eval_slot = [&](int s) {
                models[s]->eval(path[s], out[s]);
                if (out[s].logits.size() != n_vocab) throw std::runtime_error("wrong number of logits");
                const Analysis an = analyze(out[s].logits.data(), n_vocab, std::min<uint32_t>(N_RAW, n_vocab));
                if (an.top.empty()) throw std::runtime_error("no valid probability in the distribution");
                if (options.verify_seek && !out[s].approximate) {
                    // Each thread reads only its own model's map.
                    const auto it = stored[s].find(cursor[s]);
                    if (it != stored[s].end()) {
                        verified[s] = true;
                        for (const Candidate& c : it->second.entries) {
                            const double l = out[s].logits[c.token];
                            const float p = static_cast<float>(std::exp(l - an.log_norm));  // as in the EVAL
                            if (std::fabs(static_cast<double>(p) - c.p_raw) > 1e-4) mismatch[s] = true;
                        }
                    }
                }
                std::vector<int32_t> main;
                main.reserve(an.top.size());
                for (const TopCandidate& c : an.top) main.push_back(c.token);
                const GateTrace tr = chains[s].trace(out[s].logits.data(), n_vocab, main, config.seed,
                                                     static_cast<uint32_t>(path[s].size() - 1));
                rec[s] = eval_record(s, an, out[s], tr);
                pick[s] = tr.pick;
            };
            if (active[0]) run_pair(active[1], [&] { eval_slot(0); }, [&] { eval_slot(1); });
            else eval_slot(1);
            if (same_node) cmp = compare(out[0].logits.data(), out[1].logits.data(), n_vocab);

            // The gates take the token that enters each model's text before
            // anything is written: if one refuses it, the step fails with the
            // log intact. Until the step is done the chains are off their
            // cursors' paths, so a failure leaves them to be rebuilt.
            for (int s = 0; s < 2; ++s)
                if (active[s]) chain_node[s] = NONE;
            for (int s = 0; s < 2; ++s)
                if (active[s]) chains[s].accept(lockstep() ? pick[driver()] : pick[s], true);
        } catch (const std::exception& e) {
            emit(error_event("", std::string("step failed: ") + e.what(), false));
            set_state(RunState::Paused);
            notify_status();
            return false;
        }

        const uint32_t t = t_ms();
        Bytes batch;
        std::vector<int32_t> used;
        for (int s = 0; s < 2; ++s)
            if (active[s]) {
                for (const Candidate& c : rec[s].entries) used.push_back(static_cast<int32_t>(c.token));
                for (const LensLayer& l : rec[s].lens) used.push_back(static_cast<int32_t>(l.top_id));
            }
        add_vocab(batch, t, used);
        for (int s = 0; s < 2; ++s)
            if (active[s]) write_eval(batch, t, rec[s]);

        const uint32_t evaluated[2] = {cursor[0], cursor[1]};
        if (cmp) {
            const PairRec pr = pair_record(cursor[0], *cmp, pick[0] == pick[1], false);
            write_pair(batch, t, pr);
            exact_pair[cursor[0]] = pr;
        }
        // A model alone on a node the other evaluated in an earlier step (after
        // a branch or a goto): an approximate PAIR from the two stored lists,
        // unless the node already has an exact one. The numbers of an exact
        // PAIR do not depend on the configuration, but its "same pick" bit
        // does: if the new pick changes it, the exact PAIR is written again
        // with the bit corrected.
        for (int s = 0; s < 2; ++s) {
            if (!active[s] || same_node) continue;
            const auto it = stored[1 - s].find(evaluated[s]);
            if (it == stored[1 - s].end()) continue;
            if (const auto ex = exact_pair.find(evaluated[s]); ex != exact_pair.end()) {
                const bool same = pick[s] == it->second.pick_token;
                if (same != ((ex->second.flags & PAIR_SAME_PICK) != 0)) {
                    ex->second.flags ^= PAIR_SAME_PICK;
                    write_pair(batch, t, ex->second);
                }
                continue;
            }
            const Stored mine{rec[s].entries, rec[s].entries.size() - rec[s].n_extra, pick[s]};
            const Stored& a = s == 0 ? mine : it->second;
            const Stored& b = s == 0 ? it->second : mine;
            const Comparison c = compare_candidates(a.entries, a.n_main, b.entries, b.n_main);
            write_pair(batch, t, pair_record(evaluated[s], c, a.pick_token == b.pick_token, true));
        }
        for (int s = 0; s < 2; ++s) {
            if (!active[s]) continue;
            const size_t n_main = rec[s].entries.size() - rec[s].n_extra;
            stored[s][evaluated[s]] = Stored{std::move(rec[s].entries), n_main, pick[s]};
        }

        if (lockstep()) {
            // The text follows the driver's pick; the other's is only in its EVAL.
            bool created = false;
            const Node& child = tree.child_or_create(cursor[0], pick[driver()], ORIGIN_MODEL, &created);
            if (created) write_node_rec(batch, t, child);
            cursor[0] = cursor[1] = child.id;
        } else {
            // Each model follows its own pick; the same pick from the same node
            // is the same child, so the cursors stay together.
            for (int s = 0; s < 2; ++s) {
                if (!active[s]) continue;
                bool created = false;
                const Node& child = tree.child_or_create(cursor[s], pick[s], ORIGIN_MODEL, &created);
                if (created) write_node_rec(batch, t, child);
                cursor[s] = child.id;
            }
        }
        for (int s = 0; s < 2; ++s)
            if (active[s]) chain_node[s] = cursor[s];  // the chains took the token of the new node
        write_cursors(batch, t);
        write_stops(batch, t, {active[0], active[1]});
        log.append(batch);

        for (int s = 0; s < 2; ++s) {
            if (active[s] && out[s].approximate) {
                emit(warning_event(std::string("model ") + slot_name(s) + ": approximate placement at node " +
                                   std::to_string(evaluated[s]) + " (context rebuilt in batches)"));
            }
        }
        for (int s = 0; s < 2; ++s) {
            if (!verified[s]) continue;
            if (mismatch[s]) {
                emit(warning_event((n_models == 2 ? std::string("model ") + slot_name(s) + ": " : std::string()) +
                                   "seek mismatch at node " + std::to_string(evaluated[s])));
            }
            std::lock_guard<std::mutex> lk(mu);
            ++seek.verified;
            if (mismatch[s]) ++seek.mismatches;
        }

        const auto end = Clock::now();
        step_times.push_back(end);
        {
            std::lock_guard<std::mutex> lk(mu);
            nodes = static_cast<uint32_t>(tree.size());
        }
        if (!can_step()) {
            set_state(RunState::Paused);
            notify_status();
        }
        return true;
    }

    // Once a second while running: refresh the measured speed and tell the server.
    void tick() {
        const auto now = Clock::now();
        while (!step_times.empty() && now - step_times.front() > std::chrono::seconds(1)) step_times.pop_front();
        {
            std::lock_guard<std::mutex> lk(mu);
            tps = state == RunState::Running ? static_cast<double>(step_times.size()) : 0;
        }
        next_tick = now + std::chrono::seconds(1);
        notify_status();
    }

    // ------------------------------------------------------------------ loop

    void loop() {
        std::unique_lock<std::mutex> lk(mu);
        for (;;) {
            if (stopping) return;
            if (!queue.empty()) {
                const std::string cmd = std::move(queue.front());
                queue.pop_front();
                busy = true;
                lk.unlock();
                handle(cmd);
                lk.lock();
                busy = false;
                cv.notify_all();
                continue;
            }
            if (state != RunState::Running) {
                cv.wait(lk);
                continue;
            }
            const auto now = Clock::now();
            if (now >= next_tick) {
                lk.unlock();
                tick();
                lk.lock();
                continue;
            }
            Clock::time_point due = now;
            if (tps_limit > 0 && has_last_step) {
                due = last_step_start + std::chrono::duration_cast<Clock::duration>(
                                            std::chrono::duration<double>(1.0 / tps_limit));
            }
            if (now >= due) {
                busy = true;
                lk.unlock();
                do_step();
                lk.lock();
                busy = false;
                cv.notify_all();
                continue;
            }
            cv.wait_until(lk, std::min(due, next_tick));  // a command cuts the wait short
        }
    }
};

Session::Session(Model& a, Model* b, Log& log, Sinks sinks, std::vector<std::string> warnings,
                 SessionOptions options)
    : impl_(std::make_unique<Impl>(a, b, log, std::move(sinks), options)) {
    Impl& s = *impl_;
    if (b && b->n_vocab() != a.n_vocab()) throw std::invalid_argument("A and B have different vocabularies");
    s.n_vocab = a.n_vocab();
    s.hello.app = ILS_APP_VERSION;
    s.hello.llama_cpp = a.library_version();
    s.hello.created = utc_now_iso8601();
    s.hello.n_vocab = s.n_vocab;
    s.hello.n_raw = std::min<uint32_t>(N_RAW, s.n_vocab);
    for (int i = 0; i < s.n_models; ++i) {
        s.n_ctx[i] = s.models[i]->n_ctx();
        ModelInfo info = s.models[i]->info();
        info.slot = slot_name(i);
        s.hello.models.push_back(info);
    }
    s.hello.warnings = std::move(warnings);

    // The logit lens: one list of layers for both models (HELLO.lens).
    // A pair whose layers differ turns it off, with a warning.
    const std::vector<int32_t> layers = a.lens_layers();
    bool lens = !layers.empty();
    if (b && (lens || !b->lens_layers().empty())) {
        const int32_t la = a.info().n_layer, lb = b->info().n_layer;
        std::string why;
        if (la != lb) {
            why = "A has " + std::to_string(la) + " layers and B has " + std::to_string(lb);
        } else if (b->lens_layers() != layers) {
            why = "A and B do not project the same layers";
        }
        if (!why.empty()) {
            lens = false;
            s.hello.warnings.push_back("logit lens off: " + why + ", and the lens needs the same layers in both");
            std::fprintf(stderr, "warning: %s\n", s.hello.warnings.back().c_str());
        }
    }
    if (lens) {
        s.hello.lens_enabled = true;
        s.hello.lens_layers = layers;
        s.n_lens = layers.size();
        for (int i = 0; i < s.n_models; ++i)
            for (const std::string& w : s.models[i]->lens_warnings()) s.hello.warnings.push_back(w);
    } else {
        for (int i = 0; i < s.n_models; ++i) s.models[i]->disable_lens();
    }
    s.session_start = Clock::now();

    Bytes batch;
    write_hello(batch, 0, s.hello);
    write_config(batch, 0, s.config);
    log.reset(batch);

    s.thread = std::thread([this] { impl_->loop(); });
}

Session::~Session() {
    {
        std::lock_guard<std::mutex> lk(impl_->mu);
        impl_->stopping = true;
    }
    impl_->cv.notify_all();
    if (impl_->thread.joinable()) impl_->thread.join();
}

void Session::post(const std::string& command_json) {
    {
        std::lock_guard<std::mutex> lk(impl_->mu);
        impl_->queue.push_back(command_json);
    }
    impl_->cv.notify_all();
}

Status Session::status() const {
    std::lock_guard<std::mutex> lk(impl_->mu);
    Status s;
    s.state = impl_->state;
    s.tps = impl_->tps;
    s.tps_limit = impl_->tps_limit;
    s.nodes = impl_->nodes;
    return s;
}

SeekStats Session::seek_stats() const {
    std::lock_guard<std::mutex> lk(impl_->mu);
    return impl_->seek;
}

bool Session::wait_idle(std::chrono::milliseconds timeout) {
    std::unique_lock<std::mutex> lk(impl_->mu);
    return impl_->cv.wait_for(lk, timeout, [&] {
        return impl_->queue.empty() && !impl_->busy && impl_->state != RunState::Running;
    });
}

}  // namespace ils
