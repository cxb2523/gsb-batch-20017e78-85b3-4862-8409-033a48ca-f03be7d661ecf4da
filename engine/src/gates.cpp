// Gates: parsing, the per-gate trace and the final draw (gates.h).
#include "gates.h"

#include "model.h"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
#include <stdexcept>
#include <string>

namespace ils {

using json = nlohmann::ordered_json;

// ------------------------------------------------------------------ parsing

namespace {

[[noreturn]] void bad_gate(size_t i, const std::string& type, const std::string& what) {
    std::string msg = "gate " + std::to_string(i + 1);
    if (!type.empty()) msg += " (" + type + ")";
    throw std::runtime_error(msg + ": " + what);
}

// An integer parameter within [lo, INT32_MAX]; `def` if missing, unless required.
int32_t int_param(const json& g, size_t i, const std::string& type, const char* key, int32_t lo, bool required,
                  int32_t def) {
    const auto it = g.find(key);
    if (it == g.end()) {
        if (required) bad_gate(i, type, std::string("\"") + key + "\" is required");
        return def;
    }
    const std::string err = std::string("\"") + key + "\" must be an integer >= " + std::to_string(lo);
    if (it->is_number_unsigned()) {
        const uint64_t v = it->get<uint64_t>();
        if (v > static_cast<uint64_t>(std::numeric_limits<int32_t>::max()) || static_cast<int64_t>(v) < lo)
            bad_gate(i, type, err);
        return static_cast<int32_t>(v);
    }
    if (!it->is_number_integer()) bad_gate(i, type, err);
    const int64_t v = it->get<int64_t>();
    if (v < lo || v > std::numeric_limits<int32_t>::max()) bad_gate(i, type, err);
    return static_cast<int32_t>(v);
}

// A number that must stay finite as a float (llama.cpp takes floats), and
// satisfy `ok`. `def` if missing, unless required.
template <typename Ok>
double num_param(const json& g, size_t i, const std::string& type, const char* key, bool required, double def,
                 const char* range, Ok ok) {
    const auto it = g.find(key);
    if (it == g.end()) {
        if (required) bad_gate(i, type, std::string("\"") + key + "\" is required");
        return def;
    }
    const std::string err = std::string("\"") + key + "\" must be a number " + range;
    if (!it->is_number()) bad_gate(i, type, err);
    const double v = it->get<double>();
    if (!std::isfinite(v) || !std::isfinite(static_cast<float>(v)) || !ok(v)) bad_gate(i, type, err);
    return v;
}

}  // namespace

std::vector<GateSpec> parse_gates(const nlohmann::ordered_json& gates) {
    if (!gates.is_array()) throw std::runtime_error("\"gates\" must be an array");
    if (gates.size() > MAX_GATES)
        throw std::runtime_error("\"gates\" has " + std::to_string(gates.size()) + " gates; the maximum is " +
                                 std::to_string(MAX_GATES));
    std::vector<GateSpec> out;
    out.reserve(gates.size());
    for (size_t i = 0; i < gates.size(); ++i) {
        const json& g = gates[i];
        if (!g.is_object()) bad_gate(i, "", "must be an object");
        const auto t = g.find("type");
        if (t == g.end() || !t->is_string()) bad_gate(i, "", "\"type\" must be a string");
        GateSpec s;
        s.type = t->get<std::string>();
        const std::string& ty = s.type;
        // Parameters of other gate types are ignored: the web may keep them around.
        if (ty == "top_k") {
            s.k = int_param(g, i, ty, "k", 1, true, s.k);
        } else if (ty == "top_p") {
            s.p = num_param(g, i, ty, "p", true, s.p, "in (0, 1]", [](double v) { return v > 0 && v <= 1; });
        } else if (ty == "min_p") {
            s.p = num_param(g, i, ty, "p", true, s.p, "in [0, 1]", [](double v) { return v >= 0 && v <= 1; });
        } else if (ty == "temp") {
            s.t = num_param(g, i, ty, "t", true, s.t, ">= 0", [](double v) { return v >= 0; });
        } else if (ty == "penalties") {
            s.last_n = int_param(g, i, ty, "last_n", 0, false, s.last_n);
            // A repeat that rounds to 0 as a float would divide by zero.
            s.repeat = num_param(g, i, ty, "repeat", false, s.repeat, "> 0",
                                 [](double v) { return v > 0 && static_cast<float>(v) > 0; });
            const auto any = [](double) { return true; };
            s.frequency = num_param(g, i, ty, "frequency", false, s.frequency, "(finite)", any);
            s.presence = num_param(g, i, ty, "presence", false, s.presence, "(finite)", any);
        } else if (ty == "grammar") {
            const auto it = g.find("gbnf");
            if (it == g.end() || !it->is_string() || it->get_ref<const std::string&>().empty())
                bad_gate(i, ty, "\"gbnf\" must be a non-empty string");
            s.gbnf = it->get<std::string>();
        } else {
            bad_gate(i, "", "unknown type \"" + ty + "\"");
        }
        out.push_back(std::move(s));
    }
    return out;
}

// --------------------------------------------------------------------- draw

namespace {

uint64_t splitmix64(uint64_t x) {
    x += 0x9E3779B97F4A7C15ull;
    x = (x ^ (x >> 30)) * 0xBF58476D1CE4E5B9ull;
    x = (x ^ (x >> 27)) * 0x94D049BB133111EBull;
    return x ^ (x >> 31);
}

// Most likely first; ties go to the lower token id. A strict total order, so a
// partial sort gives the same prefix as a full one.
bool more_likely(const Weighted& a, const Weighted& b) {
    if (a.p != b.p) return a.p > b.p;
    return a.token < b.token;
}

// Walks dist[from, to), already in order, continuing the running sum `acc`.
// Returns the index where the sum exceeds u, or `to` if it never does.
size_t walk(const std::vector<Weighted>& dist, size_t from, size_t to, double u, double& acc) {
    for (size_t i = from; i < to; ++i) {
        acc += dist[i].p;
        if (u < acc) return i;
    }
    return to;
}

// The draw of gates.h, sorting only as far as needed: most of the mass is
// almost always in the first few candidates, and the final distribution can
// hold the whole vocabulary. Leaves at least the first min(n, PARTIAL)
// entries in order.
constexpr size_t PARTIAL = 256;

size_t draw_index(std::vector<Weighted>& dist, double u) {
    if (dist.empty()) throw std::runtime_error("draw from an empty distribution");
    const size_t n = dist.size();
    double acc = 0;
    if (n > PARTIAL) {
        std::partial_sort(dist.begin(), dist.begin() + PARTIAL, dist.end(), more_likely);
        const size_t i = walk(dist, 0, PARTIAL, u, acc);
        if (i < PARTIAL) return i;
        std::sort(dist.begin() + PARTIAL, dist.end(), more_likely);
        const size_t j = walk(dist, PARTIAL, n, u, acc);
        return j < n ? j : n - 1;
    }
    std::sort(dist.begin(), dist.end(), more_likely);
    const size_t i = walk(dist, 0, n, u, acc);
    return i < n ? i : n - 1;
}

}  // namespace

double draw_u(uint64_t seed, uint32_t depth) {
    const uint64_t x = splitmix64(splitmix64(seed) ^ depth);
    return static_cast<double>(x >> 11) * (1.0 / 9007199254740992.0);  // 53 bits, [0, 1)
}

int32_t draw(std::vector<Weighted>& dist, double u) { return dist[draw_index(dist, u)].token; }

// -------------------------------------------------------------------- chain

struct GateChain::Impl {
    std::vector<std::unique_ptr<Sampler>> samplers;
    std::vector<std::string> types;
    size_t position = 0;  // tokens accepted so far, for messages

    // Buffers reused between traces: the vocabulary is large.
    std::vector<TokenData> work;                // the array the gates work on
    std::vector<std::vector<TokenData>> snaps;  // per gate, what it left
    std::vector<double> snap_max, snap_sum;     // per gate, softmax over the finite logits
    std::vector<Weighted> final_dist;
    // Tracked candidates: slot[id] is valid when stamp[id] == gen.
    std::vector<uint32_t> stamp;
    std::vector<int32_t> slot;
    uint32_t gen = 0;

    void check_admitted(int32_t token) {
        for (size_t g = 0; g < samplers.size(); ++g)
            if (types[g] == "grammar" && !samplers[g]->admits(token))
                throw std::runtime_error("the grammar does not admit token " + std::to_string(token) +
                                         " at position " + std::to_string(position));
    }

    // Prompt tokens skip the grammar: it only constrains generated text.
    void give(int32_t token, bool generated) {
        if (generated) check_admitted(token);
        for (size_t g = 0; g < samplers.size(); ++g)
            if (generated || types[g] != "grammar") samplers[g]->accept(token);
        ++position;
    }
};

GateChain::GateChain() : impl_(std::make_unique<Impl>()) {}
GateChain::~GateChain() = default;
GateChain::GateChain(GateChain&&) noexcept = default;
GateChain& GateChain::operator=(GateChain&&) noexcept = default;

GateChain::GateChain(Model& model, const std::vector<GateSpec>& specs, const std::vector<int32_t>& path,
                     size_t prompt_len)
    : impl_(std::make_unique<Impl>()) {
    if (specs.size() > MAX_GATES) throw std::runtime_error("too many gates");
    for (const GateSpec& s : specs) {
        impl_->samplers.push_back(model.make_sampler(s));
        impl_->types.push_back(s.type);
    }
    for (size_t i = 0; i < path.size(); ++i) impl_->give(path[i], i >= prompt_len);
}

size_t GateChain::size() const { return impl_ ? impl_->samplers.size() : 0; }

const std::vector<Weighted>& GateChain::last_final() const { return impl_->final_dist; }

void GateChain::accept(int32_t token, bool generated) { impl_->give(token, generated); }

GateTrace GateChain::trace(const float* logits, size_t n_vocab, const std::vector<int32_t>& main, uint64_t seed,
                           uint32_t depth) {
    Impl& m = *impl_;
    GateTrace tr;
    if (main.empty()) throw std::runtime_error("trace without main candidates");
    m.final_dist.clear();
    const size_t n_gates = m.samplers.size();
    if (n_gates == 0) {
        tr.pick = main[0];
        return tr;
    }
    for (int32_t id : main)
        if (id < 0 || static_cast<size_t>(id) >= n_vocab) throw std::runtime_error("main candidate out of the vocabulary");

    // A copy of the whole vocabulary, as llama.cpp would build it.
    m.work.resize(n_vocab);
    for (size_t i = 0; i < n_vocab; ++i) m.work[i] = TokenData{static_cast<int32_t>(i), logits[i], 0.0f};
    TokenArray cur{m.work.data(), n_vocab, -1, false};

    m.snaps.resize(n_gates);
    m.snap_max.assign(n_gates, 0);
    m.snap_sum.assign(n_gates, 0);
    tr.survivors.assign(n_gates, 0);
    for (size_t g = 0; g < n_gates; ++g) {
        m.samplers[g]->apply(cur);
        // The sampler may have replaced `data` and shrunk `size`: reread both.
        std::vector<TokenData>& snap = m.snaps[g];
        snap.assign(cur.data, cur.data + cur.size);
        double mx = -std::numeric_limits<double>::infinity();
        uint32_t alive = 0;
        for (const TokenData& t : snap) {
            if (!std::isfinite(t.logit)) continue;
            ++alive;
            mx = std::max(mx, static_cast<double>(t.logit));
        }
        // Stop here: later samplers are not ready for an empty distribution
        // (llama.cpp's top_p aborts on one).
        if (alive == 0)
            throw std::runtime_error("no candidate survives gate " + std::to_string(g + 1) + " (" + m.types[g] + ")");
        double sum = 0;
        for (const TokenData& t : snap)
            if (std::isfinite(t.logit)) sum += std::exp(static_cast<double>(t.logit) - mx);
        tr.survivors[g] = alive;
        m.snap_max[g] = mx;
        m.snap_sum[g] = sum;
    }

    // The final distribution and the pick.
    const size_t last = n_gates - 1;
    for (const TokenData& t : m.snaps[last])
        if (std::isfinite(t.logit))
            m.final_dist.push_back({t.id, std::exp(static_cast<double>(t.logit) - m.snap_max[last]) / m.snap_sum[last]});
    tr.pick = m.final_dist[draw_index(m.final_dist, draw_u(seed, depth))].token;

    // Track main, then extra. A new generation invalidates the old slots, so a
    // trace that threw halfway leaves nothing behind.
    if (m.stamp.size() < n_vocab) {
        m.stamp.assign(n_vocab, 0);
        m.slot.assign(n_vocab, -1);
        m.gen = 0;
    }
    if (++m.gen == 0) {  // wrapped around: start again
        std::fill(m.stamp.begin(), m.stamp.end(), 0);
        m.gen = 1;
    }
    const auto tracked = [&m](int32_t id) { return m.stamp[id] == m.gen; };
    for (size_t i = 0; i < main.size(); ++i) {
        m.stamp[main[i]] = m.gen;
        m.slot[main[i]] = static_cast<int32_t>(i);
    }

    // Added candidates: the most likely of the final distribution outside
    // `main`. draw_index left at least its first PARTIAL entries in order,
    // and `main` cannot take more than a few of them.
    const size_t ordered = std::min(m.final_dist.size(), PARTIAL);
    const int32_t pick = tr.pick;
    bool pick_in = tracked(pick);
    for (size_t i = 0; i < ordered && tr.extra.size() < MAX_EXTRA; ++i) {
        const int32_t id = m.final_dist[i].token;
        if (tracked(id)) continue;
        tr.extra.push_back(id);
        if (id == pick) pick_in = true;
    }
    if (!pick_in) {
        // Less likely than every added one: it goes last.
        if (tr.extra.size() == MAX_EXTRA) tr.extra.pop_back();
        tr.extra.push_back(pick);
    }
    for (size_t i = 0; i < tr.extra.size(); ++i) {
        m.stamp[tr.extra[i]] = m.gen;
        m.slot[tr.extra[i]] = static_cast<int32_t>(main.size() + i);
    }

    // stage_p: the probability of every tracked candidate after every gate,
    // found by id since samplers reorder the array.
    const size_t width = main.size() + tr.extra.size();
    tr.stage_p.assign(n_gates * width, 0.0f);
    for (size_t g = 0; g < n_gates; ++g) {
        float* row = tr.stage_p.data() + g * width;
        for (const TokenData& t : m.snaps[g]) {
            if (t.id < 0 || static_cast<size_t>(t.id) >= n_vocab || !tracked(t.id) || !std::isfinite(t.logit)) continue;
            row[m.slot[t.id]] = static_cast<float>(std::exp(static_cast<double>(t.logit) - m.snap_max[g]) / m.snap_sum[g]);
        }
    }
    return tr;
}

}  // namespace ils
