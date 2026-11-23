// Small hand-computed cases for one sampler at a time: top_k, top_p, min_p,
// temp (also t = 0) and penalties, neutral values included. test_gates runs
// them on the reference samplers of fake_gates.h and test_fidelity on the
// llama.cpp ones, so both are held to the same numbers.
#pragma once

#include "check.h"
#include "gates.h"

#include <cmath>
#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <vector>

namespace ils_test {

// An array of candidates with ids 0..n-1, as the trace builds it.
struct Cands {
    std::vector<ils::TokenData> buf;
    ils::TokenArray cur{};

    explicit Cands(const std::vector<float>& logits) {
        for (size_t i = 0; i < logits.size(); ++i) buf.push_back({static_cast<int32_t>(i), logits[i], 0.0f});
        cur = {buf.data(), buf.size(), -1, false};
    }
    Cands& apply(ils::Sampler& s) {
        s.apply(cur);
        return *this;
    }
    // id -> logit of what is still in the array.
    std::map<int32_t, float> kept() const {
        std::map<int32_t, float> m;
        for (size_t i = 0; i < cur.size; ++i) m[cur.data[i].id] = cur.data[i].logit;
        return m;
    }
    bool has(int32_t id) const { return kept().count(id) == 1; }
};

inline bool same_logits(const std::map<int32_t, float>& got, const std::map<int32_t, float>& want) {
    if (got.size() != want.size()) return false;
    for (const auto& [id, l] : want) {
        const auto it = got.find(id);
        if (it == got.end()) return false;
        if (std::isinf(l) || std::isinf(it->second)) {
            if (l != it->second) return false;
        } else if (std::fabs(l - it->second) > 1e-5) {
            return false;
        }
    }
    return true;
}

inline void run_gate_cases(const std::function<std::unique_ptr<ils::Sampler>(const ils::GateSpec&)>& make) {
    using ils::GateSpec;
    const auto gate = [&make](GateSpec s) { return make(s); };
    const float inf = INFINITY;

    // ---- top_k: the k highest logits, sorted; fewer if there are fewer.
    {
        GateSpec s;
        s.type = "top_k";
        s.k = 2;
        Cands c({1, 3, 2, 0});
        c.apply(*gate(s));
        CHECK(same_logits(c.kept(), {{1, 3.0f}, {2, 2.0f}}));
        CHECK(c.cur.sorted);
        CHECK_EQ(c.cur.data[0].id, 1);

        s.k = 10;
        Cands all({1, 3, 2, 0});
        all.apply(*gate(s));
        CHECK_EQ(all.cur.size, 4u);

        // On a sorted array it only cuts.
        s.k = 3;
        Cands c2({1, 3, 2, 0});
        c2.apply(*gate(s));
        s.k = 1;
        c2.apply(*gate(s));
        CHECK(same_logits(c2.kept(), {{1, 3.0f}}));
    }

    // ---- top_p: the most likely until their sum reaches p (min_keep 1).
    {
        GateSpec s;
        s.type = "top_p";
        const std::vector<float> l = {std::log(0.2f), std::log(0.5f), std::log(0.3f)};
        s.p = 0.6;  // 0.5 + 0.3
        Cands c(l);
        c.apply(*gate(s));
        CHECK_EQ(c.cur.size, 2u);
        CHECK(c.has(1) && c.has(2));
        CHECK(c.cur.sorted);

        s.p = 0.4;  // 0.5 alone
        Cands one(l);
        one.apply(*gate(s));
        CHECK(same_logits(one.kept(), {{1, l[1]}}));

        s.p = 1.0;  // neutral
        Cands all(l);
        all.apply(*gate(s));
        CHECK(same_logits(all.kept(), {{0, l[0]}, {1, l[1]}, {2, l[2]}}));
        CHECK(!all.cur.sorted);

        // More than 1024 unsorted candidates: llama.cpp sorts only the first
        // 256, then everything if p is not reached within them.
        // Token 1999: logit 10, token 3: logit 9, the other 1998: logit 0.
        std::vector<float> big(2000, 0.0f);
        big[1999] = 10;
        big[3] = 9;
        const double e10 = std::exp(10.0), e9 = std::exp(9.0), sum = e10 + e9 + 1998;
        s.p = 0.9;  // the two big ones hold 0.9378
        Cands b1(big);
        b1.apply(*gate(s));
        CHECK_EQ(b1.cur.size, 2u);
        CHECK(b1.has(1999) && b1.has(3));
        // Halfway between 600 and 601 of the small ones: 2 + 601 kept.
        s.p = (e10 + e9 + 600.5) / sum;
        Cands b2(big);
        b2.apply(*gate(s));
        CHECK_EQ(b2.cur.size, 603u);
        CHECK(b2.has(1999) && b2.has(3));
    }

    // ---- min_p: logit >= max + log(p), in logit space.
    {
        GateSpec s;
        s.type = "min_p";
        const std::vector<float> l = {2.0f, 1.5f, 1.0f, -1.0f};
        s.p = 0.5;  // 2 + log(0.5) = 1.307
        Cands c(l);
        c.apply(*gate(s));
        CHECK(same_logits(c.kept(), {{0, 2.0f}, {1, 1.5f}}));
        CHECK(!c.cur.sorted);  // unsorted input: filtered in place, order kept
        CHECK_EQ(c.cur.data[0].id, 0);

        s.p = 1.0;
        Cands top(l);
        top.apply(*gate(s));
        CHECK(same_logits(top.kept(), {{0, 2.0f}}));

        s.p = 0.0;  // neutral
        Cands all(l);
        all.apply(*gate(s));
        CHECK_EQ(all.cur.size, 4u);

        // Sorted input (after top_k): the sorted way, same result.
        GateSpec k;
        k.type = "top_k";
        k.k = 3;
        s.p = 0.5;
        Cands sorted(l);
        sorted.apply(*gate(k)).apply(*gate(s));
        CHECK(same_logits(sorted.kept(), {{0, 2.0f}, {1, 1.5f}}));
    }

    // ---- temp: logits divided by t; t = 0 keeps the first maximum and
    // leaves the rest at -inf without shrinking the array.
    {
        GateSpec s;
        s.type = "temp";
        s.t = 2.0;
        Cands c({2.0f, -1.0f, 0.5f});
        c.apply(*gate(s));
        CHECK(same_logits(c.kept(), {{0, 1.0f}, {1, -0.5f}, {2, 0.25f}}));

        s.t = 0.5;
        Cands sharp({2.0f, -1.0f});
        sharp.apply(*gate(s));
        CHECK(same_logits(sharp.kept(), {{0, 4.0f}, {1, -2.0f}}));

        s.t = 1.0;  // neutral
        Cands same({2.0f, -1.0f});
        same.apply(*gate(s));
        CHECK(same_logits(same.kept(), {{0, 2.0f}, {1, -1.0f}}));

        s.t = 0.0;
        Cands greedy({1.0f, 3.0f, 3.0f, 2.0f});
        greedy.apply(*gate(s));
        CHECK_EQ(greedy.cur.size, 4u);
        CHECK(same_logits(greedy.kept(), {{0, -inf}, {1, 3.0f}, {2, -inf}, {3, -inf}}));
    }

    // ---- penalties: over the last last_n accepted tokens, a positive logit
    // is divided by `repeat` and a negative one multiplied, then
    // count * frequency + presence is subtracted.
    {
        GateSpec s;
        s.type = "penalties";
        s.last_n = 3;
        s.repeat = 2;
        s.frequency = 0.5;
        s.presence = 1;
        auto p = gate(s);
        for (int32_t t : {1, 2, 2, 3}) p->accept(t);  // window: 2, 2, 3
        Cands c({1.0f, 2.0f, 4.0f, -1.0f});
        c.cur.sorted = true;
        c.apply(*p);
        // 2: 4 / 2 - (2 * 0.5 + 1) = 0     3: -1 * 2 - (0.5 + 1) = -3.5
        CHECK(same_logits(c.kept(), {{0, 1.0f}, {1, 2.0f}, {2, 0.0f}, {3, -3.5f}}));
        CHECK(!c.cur.sorted);

        // Only the last token counts with last_n = 1.
        GateSpec s1;
        s1.type = "penalties";
        s1.last_n = 1;
        s1.repeat = 2;
        auto p1 = gate(s1);
        p1->accept(1);
        p1->accept(2);
        Cands c1({1.0f, 2.0f, 4.0f});
        c1.apply(*p1);
        CHECK(same_logits(c1.kept(), {{0, 1.0f}, {1, 2.0f}, {2, 2.0f}}));

        // Neutral: everything at its neutral value, or last_n = 0.
        GateSpec n;
        n.type = "penalties";
        GateSpec n0 = s;
        n0.last_n = 0;
        for (const GateSpec& spec : {n, n0}) {
            auto q = gate(spec);
            for (int32_t t : {0, 1, 1}) q->accept(t);
            Cands cn({1.0f, 2.0f});
            cn.apply(*q);
            CHECK(same_logits(cn.kept(), {{0, 1.0f}, {1, 2.0f}}));
        }
    }
}

}  // namespace ils_test
