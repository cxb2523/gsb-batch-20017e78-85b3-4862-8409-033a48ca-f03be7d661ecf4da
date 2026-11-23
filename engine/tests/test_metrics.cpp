// Softmax, entropy, candidate selection and the comparisons against
// distributions worked out by hand.
#include "check.h"
#include "metrics.h"

#include <cmath>
#include <limits>
#include <vector>

using namespace ils;

namespace {

std::vector<float> logs(std::vector<double> p) {
    std::vector<float> l;
    for (double x : p) l.push_back(x > 0 ? static_cast<float>(std::log(x)) : -std::numeric_limits<float>::infinity());
    return l;
}

Comparison cmp(const std::vector<float>& a, const std::vector<float>& b) {
    CHECK_EQ(a.size(), b.size());
    return compare(a.data(), b.data(), a.size());
}

// JS, KL and cross ranks against pairs worked out by hand (powers of two).
void test_compare() {
    const float inf = std::numeric_limits<float>::infinity();
    const float nan = std::numeric_limits<float>::quiet_NaN();
    const double l3 = std::log2(3.0);

    // A = {1/2, 1/4, 1/8, 1/8}, B = {1/4, 1/2, 1/8, 1/8}: M = {3/8, 3/8, 1/8, 1/8}.
    {
        const Comparison c = cmp(logs({0.5, 0.25, 0.125, 0.125}), logs({0.25, 0.5, 0.125, 0.125}));
        CHECK_NEAR(c.kl_ab, 0.25, 1e-6);  // 1/2 log2 2 + 1/4 log2 1/2
        CHECK_NEAR(c.kl_ba, 0.25, 1e-6);
        CHECK_NEAR(c.js, 1.25 - 0.75 * l3, 1e-6);
        CHECK(!c.same_top);
        CHECK_EQ(c.rank_a_in_b, 1u);
        CHECK_EQ(c.rank_b_in_a, 1u);
    }

    // Identical logits: exactly 0, same top, ranks 0. Also on a large vocabulary.
    {
        std::vector<float> l(50000);
        for (size_t i = 0; i < l.size(); ++i) l[i] = static_cast<float>(std::sin(i * 0.37) * 12.0);
        const Comparison c = cmp(l, l);
        CHECK_EQ(c.js, 0.0);
        CHECK_EQ(c.kl_ab, 0.0);
        CHECK_EQ(c.kl_ba, 0.0);
        CHECK(c.same_top);
        CHECK_EQ(c.rank_a_in_b, 0u);
        CHECK_EQ(c.rank_b_in_a, 0u);
        const std::vector<float> z = {-inf, 2.0f, 2.0f, nan};
        const Comparison d = cmp(z, z);
        CHECK_EQ(d.js, 0.0);
        CHECK_EQ(d.kl_ab, 0.0);
        CHECK_EQ(d.kl_ba, 0.0);
        CHECK(d.same_top);
    }

    // A gives 0 to a token B gives 1/4: KL(B||A) is infinite, KL(A||B) and JS are not.
    // A = {1/2, 1/2, 0}, B = {1/2, 1/4, 1/4}, M = {1/2, 3/8, 1/8}.
    {
        const Comparison c = cmp(logs({0.5, 0.5, 0}), logs({0.5, 0.25, 0.25}));
        CHECK_NEAR(c.kl_ab, 0.5, 1e-6);
        CHECK(std::isinf(c.kl_ba) && c.kl_ba > 0);
        CHECK_NEAR(c.js, 0.75 - 0.375 * l3, 1e-6);
        CHECK(c.js <= 1.0);
        CHECK(c.same_top);  // A's tie between 0 and 1 goes to token 0
        CHECK_EQ(c.rank_a_in_b, 0u);
        CHECK_EQ(c.rank_b_in_a, 0u);
        const Comparison r = cmp(logs({0.5, 0.25, 0.25}), logs({0.5, 0.5, 0}));
        CHECK(std::isinf(r.kl_ab));
        CHECK_NEAR(r.kl_ba, 0.5, 1e-6);
        CHECK_NEAR(r.js, c.js, 1e-12);  // symmetric
    }

    // Both give 0 to the same token (-inf in one, NaN in the other): it adds nothing.
    // A = {0, 1/2, 1/2}, B = {0, 3/4, 1/4}.
    {
        std::vector<float> b = logs({0, 0.75, 0.25});
        b[0] = nan;
        const Comparison c = cmp(logs({0, 0.5, 0.5}), b);
        CHECK_NEAR(c.kl_ab, 1 - 0.5 * l3, 1e-6);
        CHECK_NEAR(c.kl_ba, 0.75 * l3 - 1, 1e-6);
        CHECK(std::isfinite(c.js) && c.js > 0 && c.js < 1);
        CHECK(c.same_top);
    }

    // Disjoint supports: JS = 1 bit, both KL infinite.
    {
        const Comparison c = cmp({0.0f, -inf}, {-inf, 0.0f});
        CHECK_NEAR(c.js, 1.0, 1e-12);
        CHECK(c.js <= 1.0);
        CHECK(std::isinf(c.kl_ab) && std::isinf(c.kl_ba));
        CHECK(!c.same_top);
        CHECK_EQ(c.rank_a_in_b, 1u);
        CHECK_EQ(c.rank_b_in_a, 1u);
    }

    // Cross ranks with ties: higher logit first, then lower token id.
    {
        // A's top is token 1 (tied with 2). In B, tokens 3 and 0 go before it.
        // B's top is token 3; in A, tokens 0, 1 and 2 go before it.
        const Comparison c = cmp({1, 3, 3, 0}, {2, 2, 2, 5});
        CHECK(!c.same_top);
        CHECK_EQ(c.rank_a_in_b, 2u);
        CHECK_EQ(c.rank_b_in_a, 3u);
        // A flat B: its top is token 0, and token 1 is behind it.
        const Comparison d = cmp({1, 3, 3, 0}, {2, 2, 2, 2});
        CHECK_EQ(d.rank_a_in_b, 1u);
        CHECK_EQ(d.rank_b_in_a, 2u);
        CHECK(!d.same_top);
    }

    // A shift of every logit changes nothing.
    {
        const std::vector<float> a = {1.0f, 2.5f, -3.0f, 0.5f};
        std::vector<float> b = a;
        for (float& x : b) x += 40.0f;
        const Comparison c = cmp(a, b);
        CHECK_NEAR(c.js, 0.0, 1e-6);
        CHECK_NEAR(c.kl_ab, 0.0, 1e-5);
        CHECK(c.same_top);
    }

    // Degenerate input: a neutral comparison, never NaN.
    {
        const Comparison c = cmp({-inf, -inf}, {0.0f, 1.0f});
        CHECK_EQ(c.js, 0.0);
        CHECK_EQ(c.kl_ab, 0.0);
        CHECK_EQ(c.kl_ba, 0.0);
        const Comparison d = cmp({0.0f, 1.0f}, {nan, nan});
        CHECK_EQ(d.js, 0.0);
        const Comparison e = compare(nullptr, nullptr, 0);
        CHECK_EQ(e.js, 0.0);
    }
}

// KL and JS in bits over cells given by hand (the reference for compare_candidates).
double kl_bits(const std::vector<double>& p, const std::vector<double>& q) {
    double s = 0;
    for (size_t i = 0; i < p.size(); ++i)
        if (p[i] > 0) s += p[i] * std::log2(p[i] / q[i]);
    return s;
}
double js_bits(const std::vector<double>& p, const std::vector<double>& q) {
    std::vector<double> m;
    for (size_t i = 0; i < p.size(); ++i) m.push_back(0.5 * (p[i] + q[i]));
    return 0.5 * kl_bits(p, m) + 0.5 * kl_bits(q, m);
}

// The approximate comparison over the stored candidates: common tokens plus
// one rest cell per model, its floor, the ranks and the edge cases.
void test_compare_candidates() {
    const double l3 = std::log2(3.0);
    using C = std::vector<Candidate>;

    // Common 1 and 2; 3 only in A and 4 only in B fall into the rests.
    // Cells A = {1/2, 1/4, rest 1/4}, B = {1/4, 1/2, rest 1/4}: as in test_compare.
    {
        const C a = {{1, 0.5f}, {2, 0.25f}, {3, 0.125f}};
        const C b = {{2, 0.5f}, {1, 0.25f}, {4, 0.125f}};
        const Comparison c = compare_candidates(a, 3, b, 3);
        CHECK_NEAR(c.kl_ab, 0.25, 1e-9);
        CHECK_NEAR(c.kl_ba, 0.25, 1e-9);
        CHECK_NEAR(c.js, 1.25 - 0.75 * l3, 1e-9);
        CHECK(!c.same_top);
        CHECK_EQ(c.rank_a_in_b, 1u);
        CHECK_EQ(c.rank_b_in_a, 1u);
        const Comparison r = compare_candidates(b, 3, a, 3);  // swapped
        CHECK_NEAR(r.js, c.js, 1e-12);
    }

    // A's top is only among B's added candidates: it counts as a cell, but its
    // rank is unknown; B's top is not in A at all. Cells A = {0.6, rest 0.4},
    // B = {0.1, rest 0.9}.
    {
        const C a = {{1, 0.6f}, {2, 0.3f}};
        const C b = {{3, 0.5f}, {4, 0.3f}, {1, 0.1f}};
        const Comparison c = compare_candidates(a, 2, b, 2);
        const std::vector<double> pa = {0.6, 0.4}, pb = {0.1, 0.9};
        CHECK_NEAR(c.kl_ab, kl_bits(pa, pb), 1e-6);
        CHECK_NEAR(c.kl_ba, kl_bits(pb, pa), 1e-6);
        CHECK_NEAR(c.js, js_bits(pa, pb), 1e-6);
        CHECK_EQ(c.rank_a_in_b, RANK_UNKNOWN);
        CHECK_EQ(c.rank_b_in_a, RANK_UNKNOWN);
        CHECK(!c.same_top);
        // As a main candidate of B it has a rank.
        CHECK_EQ(compare_candidates(a, 2, b, 3).rank_a_in_b, 2u);
    }

    // The floor of the rest: A's common tokens take all its mass.
    // Cells A = {1/2, 1/2, rest 1e-6}, B = {1/4, 1/4, rest 1/2}.
    {
        const C a = {{1, 0.5f}, {2, 0.5f}};
        const C b = {{3, 0.5f}, {1, 0.25f}, {2, 0.25f}};
        const Comparison c = compare_candidates(a, 2, b, 3);
        const std::vector<double> pa = {0.5, 0.5, 1e-6}, pb = {0.25, 0.25, 0.5};
        CHECK_NEAR(c.kl_ab, kl_bits(pa, pb), 1e-9);
        CHECK_NEAR(c.kl_ba, kl_bits(pb, pa), 1e-9);
        CHECK_NEAR(c.js, js_bits(pa, pb), 1e-9);
        CHECK(std::isfinite(c.kl_ba));
        CHECK_EQ(c.rank_a_in_b, 1u);
        CHECK_EQ(c.rank_b_in_a, RANK_UNKNOWN);
    }

    // A cell with probability 0 in A only: KL(B||A) infinite, JS finite.
    // Cells A = {1, 0, rest 1e-6}, B = {1/2, 1/2, rest 1e-6}.
    {
        const C a = {{1, 1.0f}, {2, 0.0f}};
        const C b = {{2, 0.5f}, {1, 0.5f}};
        const Comparison c = compare_candidates(a, 2, b, 2);
        CHECK_NEAR(c.kl_ab, 1.0, 1e-9);
        CHECK(std::isinf(c.kl_ba) && c.kl_ba > 0);
        CHECK_NEAR(c.js, 1.5 - 0.75 * l3, 1e-9);
        CHECK(c.js >= 0 && c.js <= 1);
    }

    // Identical lists: exactly 0, same top, ranks 0.
    {
        const C a = {{7, 0.7f}, {8, 0.2f}, {9, 0.01f}};
        const Comparison c = compare_candidates(a, 2, a, 2);
        CHECK_EQ(c.js, 0.0);
        CHECK_EQ(c.kl_ab, 0.0);
        CHECK_EQ(c.kl_ba, 0.0);
        CHECK(c.same_top);
        CHECK_EQ(c.rank_a_in_b, 0u);
        CHECK_EQ(c.rank_b_in_a, 0u);
    }

    // No common token: one cell each, the rests (1 and 1): 0, ranks unknown.
    {
        const Comparison c = compare_candidates({{1, 0.4f}}, 1, {{2, 0.3f}}, 1);
        CHECK_EQ(c.js, 0.0);
        CHECK(!c.same_top);
        CHECK_EQ(c.rank_a_in_b, RANK_UNKNOWN);
        CHECK_EQ(c.rank_b_in_a, RANK_UNKNOWN);
    }

    // An empty list: neutral, both ranks unknown.
    {
        const Comparison c = compare_candidates({}, 0, {{1, 0.5f}}, 1);
        CHECK_EQ(c.js, 0.0);
        CHECK_EQ(c.kl_ab, 0.0);
        CHECK_EQ(c.kl_ba, 0.0);
        CHECK(!c.same_top);
        CHECK_EQ(c.rank_a_in_b, RANK_UNKNOWN);
        CHECK_EQ(c.rank_b_in_a, RANK_UNKNOWN);
        CHECK_EQ(compare_candidates({{1, 0.5f}}, 1, {}, 0).rank_b_in_a, RANK_UNKNOWN);
    }
}

}  // namespace

int main() {
    const float inf = std::numeric_limits<float>::infinity();

    // Uniform over 4 tokens: H = 2 bits, every p = 0.25, ties ordered by token id.
    {
        const std::vector<float> l = {1.5f, 1.5f, 1.5f, 1.5f};
        const Analysis a = analyze(l.data(), l.size(), 32);
        CHECK_NEAR(a.entropy_bits, 2.0, 1e-12);
        CHECK_EQ(a.top.size(), 4u);  // n_top is capped at the vocabulary size
        for (int i = 0; i < 4; ++i) {
            CHECK_EQ(a.top[i].token, i);
            CHECK_NEAR(a.top[i].p, 0.25, 1e-12);
        }
        CHECK_NEAR(a.top_mass, 1.0, 1e-12);
    }

    // p = {1/8, 1/2, 1/8, 1/4}: H = 1.75 bits.
    {
        const std::vector<float> l = {std::log(0.125f), std::log(0.5f), std::log(0.125f), std::log(0.25f)};
        const Analysis a = analyze(l.data(), l.size(), 2);
        CHECK_NEAR(a.entropy_bits, 1.75, 1e-6);
        CHECK_EQ(a.top.size(), 2u);
        CHECK_EQ(a.top[0].token, 1);
        CHECK_NEAR(a.top[0].p, 0.5, 1e-6);
        CHECK_EQ(a.top[1].token, 3);
        CHECK_NEAR(a.top[1].p, 0.25, 1e-6);
        CHECK_NEAR(a.top_mass, 0.75, 1e-6);

        // The same shifted by a constant: softmax does not change.
        std::vector<float> shifted = l;
        for (float& x : shifted) x += 100.0f;
        const Analysis b = analyze(shifted.data(), shifted.size(), 2);
        CHECK_NEAR(b.entropy_bits, 1.75, 1e-4);
        CHECK_EQ(b.top[0].token, 1);
    }

    // Large logits must not overflow: p = 1 / (1 + e^-1).
    {
        const std::vector<float> l = {1000.0f, 999.0f};
        const Analysis a = analyze(l.data(), l.size(), 32);
        const double p0 = 1.0 / (1.0 + std::exp(-1.0));
        CHECK_NEAR(a.top[0].p, p0, 1e-12);
        CHECK_NEAR(a.top[1].p, 1.0 - p0, 1e-12);
        const double h = -(p0 * std::log2(p0) + (1 - p0) * std::log2(1 - p0));
        CHECK_NEAR(a.entropy_bits, h, 1e-12);
    }

    // Minus infinity is probability 0 and never a candidate.
    {
        const std::vector<float> l = {-inf, 0.0f, -inf, 0.0f};
        const Analysis a = analyze(l.data(), l.size(), 32);
        CHECK_NEAR(a.entropy_bits, 1.0, 1e-12);
        CHECK_EQ(a.top.size(), 2u);
        CHECK_EQ(a.top[0].token, 1);
        CHECK_EQ(a.top[1].token, 3);
    }

    // One certain token: H = 0.
    {
        const std::vector<float> l = {-inf, 3.0f, -inf};
        const Analysis a = analyze(l.data(), l.size(), 32);
        CHECK_NEAR(a.entropy_bits, 0.0, 1e-12);
        CHECK_NEAR(a.top[0].p, 1.0, 1e-12);
    }

    // Small probabilities survive: the tail of a peaked distribution.
    {
        const std::vector<float> l = {0.0f, -40.0f};
        const Analysis a = analyze(l.data(), l.size(), 32);
        CHECK_NEAR(a.top[1].p / std::exp(-40.0), 1.0, 1e-9);
    }

    // Selection over a larger vocabulary: the best n_top, most likely first.
    {
        std::vector<float> l(1000);
        for (size_t i = 0; i < l.size(); ++i) l[i] = static_cast<float>((i * 37) % 1000) / 50.0f;
        const Analysis a = analyze(l.data(), l.size(), 32);
        CHECK_EQ(a.top.size(), 32u);
        for (size_t i = 1; i < a.top.size(); ++i) CHECK(a.top[i - 1].p > a.top[i].p);
        // Logit k/50 belongs to the token i with (i * 37) % 1000 == k; the best is k = 999.
        CHECK_EQ((a.top[0].token * 37) % 1000, 999);
        CHECK_EQ((a.top[31].token * 37) % 1000, 968);
    }

    // Degenerate inputs give an empty analysis instead of NaN.
    {
        const Analysis a = analyze(nullptr, 0, 32);
        CHECK(a.top.empty());
        CHECK_EQ(a.entropy_bits, 0.0);
        const std::vector<float> l = {-inf, -inf};
        const Analysis b = analyze(l.data(), l.size(), 32);
        CHECK(b.top.empty());
    }

    test_compare();
    test_compare_candidates();
    return test_result();
}
