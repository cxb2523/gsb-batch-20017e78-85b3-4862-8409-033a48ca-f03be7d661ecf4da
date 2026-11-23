// Gates without a model: the reference samplers against hand-computed cases,
// the per-gate trace over a small distribution worked out by hand, the
// parsing of CONFIG.gates, the final draw and the gate state along a path.
#include "check.h"
#include "fake_model.h"
#include "gate_cases.h"
#include "gates.h"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cmath>
#include <functional>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>

using namespace ils;
using ojson = nlohmann::ordered_json;

namespace {

// draw_u pinned: a change here changes every regenerated session.
const double DRAW_U_42_0 = 0.34329192209867343;
const double DRAW_U_42_7 = 0.08603176010658542;
const double DRAW_U_0_0 = 0.65244848637403219;

const float NEG_INF = -std::numeric_limits<float>::infinity();

// Byte tokens of the fake vocabulary.
int32_t byte(char c) { return FakeModel::BYTE0 + static_cast<unsigned char>(c); }

// Runs fn and returns the message of the std::runtime_error it throws, or
// "<no throw>".
std::string thrown(const std::function<void()>& fn) {
    try {
        fn();
    } catch (const std::runtime_error& e) {
        return e.what();
    }
    return "<no throw>";
}

bool contains(const std::string& s, const std::string& part) { return s.find(part) != std::string::npos; }

GateSpec spec(const char* json) { return parse_gates(ojson::parse(std::string("[") + json + "]")).at(0); }

std::vector<GateSpec> specs(const char* json) { return parse_gates(ojson::parse(json)); }

// The distribution of the trace tests: 'a' 2, 'b' 1, 'c' 0 and every other
// token -100 (alive, but with a probability that rounds to 0).
//   softmax: a 0.665241  b 0.244728  c 0.090031
std::vector<float> abc_logits(const FakeModel& m) {
    std::vector<float> l(m.n_vocab(), -100.0f);
    l[byte('a')] = 2;
    l[byte('b')] = 1;
    l[byte('c')] = 0;
    return l;
}

struct Run {
    GateTrace tr;
    size_t width = 0;
    float p(size_t gate, size_t i) const { return tr.stage_p[gate * width + i]; }
};

Run run(FakeModel& m, const std::vector<GateSpec>& g, const std::vector<int32_t>& main,
        const std::vector<int32_t>& path = {FakeModel::BOS}, size_t prompt_len = 1, uint64_t seed = 42,
        uint32_t depth = 1) {
    GateChain chain(m, g, path, prompt_len);
    const std::vector<float> l = abc_logits(m);
    Run r;
    r.tr = chain.trace(l.data(), l.size(), main, seed, depth);
    r.width = main.size() + r.tr.extra.size();
    CHECK_EQ(r.tr.survivors.size(), g.size());
    CHECK_EQ(r.tr.stage_p.size(), g.size() * r.width);
    double sum = 0;
    for (const Weighted& w : chain.last_final()) sum += w.p;
    CHECK_NEAR(sum, 1.0, 1e-9);
    return r;
}

void test_reference_cases() {
    FakeModel m;
    ils_test::run_gate_cases([&m](const GateSpec& s) { return m.make_sampler(s); });
}

// One gate at a time over the abc distribution; main = a, b, c.
void test_trace_single_gates() {
    FakeModel m;
    const int32_t a = byte('a'), b = byte('b'), c = byte('c');
    const std::vector<int32_t> main = {a, b, c};
    const uint32_t nv = m.n_vocab();
    const double eps = 1e-5;

    // Grammar: eliminates by leaving -inf in the array. Admits 'a', 'b' and
    // <eos> (EOG), so 3 survive although the array keeps the whole vocabulary.
    // a: e^2 / (e^2 + e^1), b: e^1 / (e^2 + e^1), c: 0.
    {
        const Run r = run(m, {spec(R"({"type":"grammar","gbnf":"ab"})")}, main);
        CHECK_EQ(r.tr.survivors[0], 3u);
        CHECK_NEAR(r.p(0, 0), 0.731059, eps);
        CHECK_NEAR(r.p(0, 1), 0.268941, eps);
        CHECK_EQ(r.p(0, 2), 0.0f);
        // <eos> survives outside main: an added candidate.
        CHECK(r.tr.extra == std::vector<int32_t>{FakeModel::EOS});
        CHECK(r.tr.pick == a || r.tr.pick == b);
    }
    // temp 0: one survivor, the rest at -inf.
    {
        const Run r = run(m, {spec(R"({"type":"temp","t":0})")}, main);
        CHECK_EQ(r.tr.survivors[0], 1u);
        CHECK_EQ(r.p(0, 0), 1.0f);
        CHECK_EQ(r.p(0, 1), 0.0f);
        CHECK_EQ(r.p(0, 2), 0.0f);
        CHECK_EQ(r.tr.pick, a);
        CHECK(r.tr.extra.empty());
    }
    // top_k 2, top_p 0.7 (0.665 + 0.245) and min_p 0.3 (2 + log 0.3 = 0.80)
    // all leave a and b.
    for (const char* g : {R"({"type":"top_k","k":2})", R"({"type":"top_p","p":0.7})", R"({"type":"min_p","p":0.3})"}) {
        const Run r = run(m, {spec(g)}, main);
        CHECK_EQ(r.tr.survivors[0], 2u);
        CHECK_NEAR(r.p(0, 0), 0.731059, eps);
        CHECK_NEAR(r.p(0, 1), 0.268941, eps);
        CHECK_EQ(r.p(0, 2), 0.0f);
        CHECK(r.tr.extra.empty());
    }
    // temp 2: logits 1, 0.5, 0; nothing eliminated. The added candidates are
    // the -50 tokens, tied: the lowest ids first.
    {
        const Run r = run(m, {spec(R"({"type":"temp","t":2})")}, main);
        CHECK_EQ(r.tr.survivors[0], nv);
        CHECK_NEAR(r.p(0, 0), 0.506480, eps);
        CHECK_NEAR(r.p(0, 1), 0.307196, eps);
        CHECK_NEAR(r.p(0, 2), 0.186324, eps);
        CHECK(r.tr.extra == (std::vector<int32_t>{0, 1, 2, 3, 4, 5, 6, 7}));
    }
    // penalties: the path has 'a' twice (and <s>, the prompt). a: 2 / 1.5.
    // e^1.3333 = 3.793668, e^1 = 2.718282, e^0 = 1.
    {
        const Run r = run(m, {spec(R"({"type":"penalties","repeat":1.5})")}, main, {FakeModel::BOS, a, a}, 1);
        CHECK_EQ(r.tr.survivors[0], nv);
        CHECK_NEAR(r.p(0, 0), 0.505019, eps);
        CHECK_NEAR(r.p(0, 1), 0.361862, eps);
        CHECK_NEAR(r.p(0, 2), 0.133120, eps);
    }
}

// Several gates: one row per gate, candidates followed by id.
void test_trace_chain() {
    FakeModel m;
    const int32_t a = byte('a'), b = byte('b'), c = byte('c');
    const double eps = 1e-5;
    const auto g = specs(R"([{"type":"penalties","repeat":1.5},{"type":"top_k","k":2},{"type":"temp","t":0}])");
    // main in another order than the probabilities: rows follow main.
    const Run r = run(m, g, {c, a, b}, {FakeModel::BOS, a, a}, 1);
    CHECK(r.tr.survivors == (std::vector<uint32_t>{m.n_vocab(), 2, 1}));
    CHECK_NEAR(r.p(0, 0), 0.133120, eps);
    CHECK_NEAR(r.p(0, 1), 0.505019, eps);
    CHECK_NEAR(r.p(0, 2), 0.361862, eps);
    // After top_k: a 1.3333 and b 1.
    CHECK_EQ(r.p(1, 0), 0.0f);
    CHECK_NEAR(r.p(1, 1), 0.582570, eps);
    CHECK_NEAR(r.p(1, 2), 0.417430, eps);
    CHECK_EQ(r.p(2, 1), 1.0f);
    CHECK_EQ(r.p(2, 2), 0.0f);
    CHECK_EQ(r.tr.pick, a);
    CHECK(r.tr.extra.empty());

    // The same trace twice: the same result.
    const Run again = run(m, g, {c, a, b}, {FakeModel::BOS, a, a}, 1);
    CHECK_EQ(again.tr.pick, r.tr.pick);
    CHECK(again.tr.stage_p == r.tr.stage_p);
}

void test_no_gates() {
    FakeModel m;
    const std::vector<float> l = abc_logits(m);
    std::vector<GateChain> chains;
    chains.emplace_back();
    chains.emplace_back(m, std::vector<GateSpec>{}, std::vector<int32_t>{FakeModel::BOS}, 1);
    for (GateChain& chain : chains) {
        CHECK_EQ(chain.size(), 0u);
        // The pick is main[0] even if it is not the most likely.
        const GateTrace tr = chain.trace(l.data(), l.size(), {byte('c'), byte('a')}, 42, 3);
        CHECK_EQ(tr.pick, byte('c'));
        CHECK(tr.extra.empty() && tr.survivors.empty() && tr.stage_p.empty());
        chain.accept(byte('a'), true);  // nothing to tell
    }
    CHECK_EQ(m.samplers_made, 0);
}

void test_extra() {
    FakeModel m;
    // The pick outside main: temp 0 leaves only 'a', main has only 'c'.
    {
        const Run r = run(m, {spec(R"({"type":"temp","t":0})")}, {byte('c')});
        CHECK_EQ(r.tr.pick, byte('a'));
        CHECK(r.tr.extra == std::vector<int32_t>{byte('a')});
        CHECK_EQ(r.p(0, 0), 0.0f);
        CHECK_EQ(r.p(0, 1), 1.0f);
    }
    // Twenty equal candidates (ids 10..29), main = {10}. A draw beyond 0.9
    // picks one of the last two, outside the 8 most likely: it takes the
    // last place, after the 7 most likely.
    {
        std::vector<float> l(m.n_vocab(), NEG_INF);
        for (int32_t t = 10; t < 30; ++t) l[t] = 0;
        uint32_t depth = 0;
        while (draw_u(7, depth) <= 0.905) ++depth;  // a fixed search: draw_u is deterministic
        GateChain chain(m, {spec(R"({"type":"temp","t":2})")}, {FakeModel::BOS}, 1);
        const GateTrace tr = chain.trace(l.data(), l.size(), {10}, 7, depth);
        CHECK_EQ(tr.survivors[0], 20u);
        CHECK(tr.pick == 28 || tr.pick == 29);
        CHECK(tr.extra == (std::vector<int32_t>{11, 12, 13, 14, 15, 16, 17, tr.pick}));
        CHECK_EQ(tr.stage_p.size(), 9u);
        for (float p : tr.stage_p) CHECK_NEAR(p, 0.05, 1e-6);
    }
    // Never more than 8, none of them in main.
    {
        const Run r = run(m, {spec(R"({"type":"penalties","repeat":1.2})")}, {byte('a'), 0, 1});
        CHECK_EQ(r.tr.extra.size(), MAX_EXTRA);
        for (int32_t t : r.tr.extra) CHECK(t != byte('a') && t != 0 && t != 1);
    }
}

void test_no_survivor() {
    FakeModel m;
    // The grammar admits 'z' and <eos>; both come at -inf.
    std::vector<float> l = abc_logits(m);
    l[byte('z')] = NEG_INF;
    l[FakeModel::EOS] = NEG_INF;
    GateChain chain(m, specs(R"([{"type":"grammar","gbnf":"z"},{"type":"top_p","p":0.9}])"), {FakeModel::BOS}, 1);
    const std::string msg = thrown([&] { chain.trace(l.data(), l.size(), {byte('a')}, 42, 1); });
    CHECK(contains(msg, "no candidate survives gate 1 (grammar)"));
    // The chain is still usable afterwards.
    l[byte('z')] = 5;
    CHECK_EQ(chain.trace(l.data(), l.size(), {byte('a')}, 42, 1).pick, byte('z'));
}

// The gate state along a path: penalties get every token, the grammar only
// the generated ones, each checked first.
void test_path_state() {
    FakeModel m;
    const int32_t a = byte('a'), c = byte('c'), x = byte('x');
    const auto g = specs(R"([{"type":"grammar","gbnf":"ab"},{"type":"penalties","repeat":1.1}])");
    {
        GateChain chain(m, g, {FakeModel::BOS, x, a}, 2);  // 'x' is prompt: the grammar never sees it
        CHECK_EQ(m.samplers_made, 2);
        using Acc = std::vector<std::pair<std::string, int32_t>>;
        CHECK(m.accepted == (Acc{{"penalties", FakeModel::BOS}, {"penalties", x}, {"grammar", a}, {"penalties", a}}));

        // A rejected token leaves the chain as it was.
        const std::string msg = thrown([&] { chain.accept(c, true); });
        CHECK(contains(msg, "the grammar does not admit token " + std::to_string(c) + " at position 3"));
        CHECK_EQ(m.accepted.size(), 4u);
        chain.accept(c, false);  // not generated: penalties only
        CHECK(m.accepted.back() == std::make_pair(std::string("penalties"), c));
        CHECK_EQ(m.accepted.size(), 5u);
        chain.accept(FakeModel::EOS, true);  // EOG: always admitted by the toy grammar
        CHECK_EQ(m.accepted.size(), 7u);
    }
    // A path the grammar rejects.
    {
        const std::string msg = thrown([&] { GateChain bad(m, g, {FakeModel::BOS, x, a, c}, 2); });
        CHECK(contains(msg, "does not admit token " + std::to_string(c) + " at position 3"));
    }
    // An invalid grammar.
    CHECK(contains(thrown([&] { GateChain bad(m, specs(R"([{"type":"grammar","gbnf":"!a"}])"), {0}, 1); }),
                   "invalid grammar"));
    // Moving keeps the gates.
    GateChain moved;
    moved = GateChain(m, g, {FakeModel::BOS}, 1);
    CHECK_EQ(moved.size(), 2u);
}

void test_parse() {
    const auto ok = specs(R"([
        {"type":"penalties","last_n":32,"repeat":1.1,"frequency":0.2,"presence":-0.5},
        {"type":"top_k","k":40},{"type":"top_p","p":0.95},{"type":"min_p","p":0.05},
        {"type":"temp","t":0.8},{"type":"grammar","gbnf":"root ::= \"a\""}])");
    CHECK_EQ(ok.size(), 6u);
    CHECK(ok[0].type == "penalties" && ok[0].last_n == 32);
    CHECK_NEAR(ok[0].repeat, 1.1, 1e-12);
    CHECK_NEAR(ok[0].frequency, 0.2, 1e-12);
    CHECK_NEAR(ok[0].presence, -0.5, 1e-12);
    CHECK(ok[1].type == "top_k" && ok[1].k == 40);
    CHECK_NEAR(ok[2].p, 0.95, 1e-12);
    CHECK(ok[3].type == "min_p");
    CHECK_NEAR(ok[3].p, 0.05, 1e-12);
    CHECK_NEAR(ok[4].t, 0.8, 1e-12);
    CHECK(ok[5].gbnf == "root ::= \"a\"");

    // Defaults of penalties.
    const GateSpec pen = spec(R"({"type":"penalties"})");
    CHECK(pen.last_n == 64 && pen.repeat == 1.0 && pen.frequency == 0.0 && pen.presence == 0.0);
    // Edges that are allowed; parameters of other types are ignored.
    CHECK(specs("[]").empty());
    CHECK_EQ(spec(R"({"type":"top_k","k":2147483647})").k, 2147483647);
    CHECK_EQ(spec(R"({"type":"top_p","p":1})").p, 1.0);
    CHECK_EQ(spec(R"({"type":"min_p","p":0})").p, 0.0);
    CHECK_EQ(spec(R"({"type":"min_p","p":1})").p, 1.0);
    CHECK_EQ(spec(R"({"type":"temp","t":0})").t, 0.0);
    CHECK_EQ(spec(R"({"type":"penalties","last_n":0})").last_n, 0);
    CHECK_EQ(spec(R"({"type":"top_k","k":3,"p":7})").k, 3);

    const auto temps = [](int n) {
        std::string s = "[";
        for (int i = 0; i < n; ++i) s += std::string(i ? "," : "") + R"({"type":"temp","t":1})";
        return s + "]";
    };
    CHECK_EQ(specs(temps(16).c_str()).size(), MAX_GATES);
    const std::string many = temps(17);

    const std::vector<std::pair<std::string, std::string>> bad = {
        {R"({"gates":[]})", "must be an array"},
        {many, "maximum is 16"},
        {R"([3])", "gate 1: must be an object"},
        {R"([{"k":3}])", "\"type\""},
        {R"([{"type":"top_q","p":1}])", "unknown type \"top_q\""},
        {R"([{"type":"temp","t":1},{"type":"top_k"}])", "gate 2 (top_k): \"k\" is required"},
        {R"([{"type":"top_k","k":0}])", "\"k\" must be an integer >= 1"},
        {R"([{"type":"top_k","k":1.5}])", "\"k\" must be"},
        {R"([{"type":"top_k","k":"3"}])", "\"k\" must be"},
        {R"([{"type":"top_k","k":2147483648}])", "\"k\" must be"},
        {R"([{"type":"top_p"}])", "\"p\" is required"},
        {R"([{"type":"top_p","p":0}])", "\"p\" must be a number in (0, 1]"},
        {R"([{"type":"top_p","p":1.01}])", "\"p\" must be"},
        {R"([{"type":"min_p","p":-0.1}])", "\"p\" must be a number in [0, 1]"},
        {R"([{"type":"min_p"}])", "\"p\" is required"},
        {R"([{"type":"temp"}])", "\"t\" is required"},
        {R"([{"type":"temp","t":-1}])", "\"t\" must be a number >= 0"},
        {R"([{"type":"temp","t":1e300}])", "\"t\" must be"},
        {R"([{"type":"grammar"}])", "\"gbnf\" must be a non-empty string"},
        {R"([{"type":"grammar","gbnf":""}])", "\"gbnf\""},
        {R"([{"type":"grammar","gbnf":3}])", "\"gbnf\""},
        {R"([{"type":"penalties","last_n":-1}])", "\"last_n\" must be an integer >= 0"},
        {R"([{"type":"penalties","repeat":0}])", "\"repeat\" must be a number > 0"},
        {R"([{"type":"penalties","repeat":1e-50}])", "\"repeat\""},
        {R"([{"type":"penalties","frequency":"x"}])", "\"frequency\""},
        {R"([{"type":"penalties","presence":null}])", "\"presence\""},
    };
    for (const auto& [json, want] : bad) {
        const std::string msg = thrown([&] { parse_gates(ojson::parse(json)); });
        if (!contains(msg, want)) std::fprintf(stderr, "  %s -> %s\n", json.c_str(), msg.c_str());
        CHECK(contains(msg, want));
    }
}

void test_draw() {
    // Sorted: 3 (0.5), 7 (0.3), 5 (0.2). The first where the sum exceeds u.
    const std::vector<Weighted> d = {{5, 0.2}, {3, 0.5}, {7, 0.3}};
    const std::vector<std::pair<double, int32_t>> cases = {{0.0, 3}, {0.49, 3}, {0.5, 7}, {0.79, 7}, {0.81, 5}, {0.9999, 5}};
    for (const auto& [u, want] : cases) {
        std::vector<Weighted> copy = d;
        CHECK_EQ(draw(copy, u), want);
    }
    // Ties go to the lower id.
    std::vector<Weighted> tie = {{9, 0.5}, {2, 0.5}};
    CHECK_EQ(draw(tie, 0.1), 2);
    // A sum that never exceeds u (rounding): the last one.
    std::vector<Weighted> short_sum = {{1, 0.6}, {2, 0.3}};
    CHECK_EQ(draw(short_sum, 0.95), 2);
    // More than 256 candidates: the partial sort, and beyond it.
    std::vector<Weighted> wide;
    for (int32_t t = 0; t < 1000; ++t) wide.push_back({999 - t, 0.001});
    std::vector<Weighted> w1 = wide;
    CHECK_EQ(draw(w1, 0.0105), 10);   // ties by id: token i at place i
    std::vector<Weighted> w2 = wide;
    CHECK_EQ(draw(w2, 0.7005), 700);  // past the first 256

    // draw_u: fixed values, so sessions can be regenerated.
    CHECK_EQ(draw_u(42, 0), draw_u(42, 0));
    CHECK(draw_u(42, 0) != draw_u(42, 1));
    CHECK(draw_u(42, 0) != draw_u(43, 0));
    CHECK_NEAR(draw_u(42, 0), DRAW_U_42_0, 1e-15);
    CHECK_NEAR(draw_u(42, 7), DRAW_U_42_7, 1e-15);
    CHECK_NEAR(draw_u(0, 0), DRAW_U_0_0, 1e-15);
    double mean = 0, lo = 1, hi = 0;
    for (uint32_t depth = 0; depth < 10000; ++depth) {
        const double u = draw_u(1234, depth);
        CHECK(u >= 0 && u < 1);
        mean += u / 10000;
        lo = std::min(lo, u);
        hi = std::max(hi, u);
    }
    CHECK_NEAR(mean, 0.5, 0.01);
    CHECK(lo < 0.001 && hi > 0.999);
}

}  // namespace

int main() {
    test_reference_cases();
    test_trace_single_gates();
    test_trace_chain();
    test_no_gates();
    test_extra();
    test_no_survivor();
    test_path_state();
    test_parse();
    test_draw();
    return test_result();
}
