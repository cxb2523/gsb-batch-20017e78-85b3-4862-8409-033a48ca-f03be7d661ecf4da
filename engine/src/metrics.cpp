#include "metrics.h"

#include <algorithm>
#include <cmath>
#include <limits>

namespace ils {

namespace {

struct Ranked {
    float logit;
    int32_t token;
};

// Higher logit first; ties go to the lower token id.
bool better(const Ranked& x, const Ranked& y) {
    return x.logit > y.logit || (x.logit == y.logit && x.token < y.token);
}

}  // namespace

Analysis analyze(const float* logits, size_t n_vocab, size_t n_top) {
    Analysis a;
    const double neg_inf = -std::numeric_limits<double>::infinity();

    double mx = neg_inf;
    for (size_t i = 0; i < n_vocab; ++i) {
        if (logits[i] > mx) mx = logits[i];
    }
    if (!(mx > neg_inf) || !std::isfinite(mx)) return a;  // empty or degenerate

    // With d = logit - max and e = exp(d):  p = e / sum,  ln p = d - ln(sum),
    // H = -sum(p ln p) = ln(sum) - sum(e d) / sum.
    double sum = 0, weighted = 0;
    for (size_t i = 0; i < n_vocab; ++i) {
        const double d = static_cast<double>(logits[i]) - mx;
        if (!(d > neg_inf)) continue;  // -inf and NaN contribute nothing
        const double e = std::exp(d);
        sum += e;
        weighted += e * d;
    }
    const double log_sum = std::log(sum);
    a.log_norm = mx + log_sum;
    a.entropy_bits = std::max(0.0, (log_sum - weighted / sum) / std::log(2.0));

    // Partial selection: a heap whose front is the worst of the best n_top so far.
    n_top = std::min(n_top, n_vocab);
    std::vector<Ranked> heap;
    heap.reserve(n_top + 1);
    for (size_t i = 0; i < n_vocab; ++i) {
        const Ranked r{logits[i], static_cast<int32_t>(i)};
        if (!(r.logit > -std::numeric_limits<float>::infinity())) continue;
        if (heap.size() < n_top) {
            heap.push_back(r);
            std::push_heap(heap.begin(), heap.end(), better);
        } else if (better(r, heap.front())) {
            std::pop_heap(heap.begin(), heap.end(), better);
            heap.back() = r;
            std::push_heap(heap.begin(), heap.end(), better);
        }
    }
    std::sort(heap.begin(), heap.end(), better);

    a.top.reserve(heap.size());
    for (const Ranked& r : heap) {
        const double p = std::exp(static_cast<double>(r.logit) - mx - log_sum);
        a.top.push_back({r.token, p});
        a.top_mass += p;
    }
    return a;
}

namespace {

// The softmax of `logits`: p[i] gets the probabilities and the result is
// ln(sum(exp(l))), so that ln p = l - result. Returns NaN for a degenerate
// vector (no finite logit, or +inf).
double softmax(const float* logits, size_t n, std::vector<double>& p) {
    const double neg_inf = -std::numeric_limits<double>::infinity();
    double mx = neg_inf;
    for (size_t i = 0; i < n; ++i) {
        if (logits[i] > mx) mx = logits[i];
    }
    if (!(mx > neg_inf) || !std::isfinite(mx)) return std::numeric_limits<double>::quiet_NaN();
    p.resize(n);
    double sum = 0;
    for (size_t i = 0; i < n; ++i) {
        const double d = static_cast<double>(logits[i]) - mx;
        p[i] = d > neg_inf ? std::exp(d) : 0;  // -inf and NaN are 0
        sum += p[i];
    }
    const double inv = 1.0 / sum;
    for (size_t i = 0; i < n; ++i) p[i] *= inv;
    return mx + std::log(sum);
}

// NaN ranks like -inf: it is never a candidate.
float rank_key(float l) { return std::isnan(l) ? -std::numeric_limits<float>::infinity() : l; }

int32_t argmax(const float* logits, size_t n) {
    Ranked best{rank_key(logits[0]), 0};
    for (size_t i = 1; i < n; ++i) {
        const Ranked r{rank_key(logits[i]), static_cast<int32_t>(i)};
        if (better(r, best)) best = r;
    }
    return best.token;
}

// Number of tokens that go before `token` in `logits`.
uint32_t rank_of(const float* logits, size_t n, int32_t token) {
    const Ranked t{rank_key(logits[token]), token};
    uint32_t rank = 0;
    for (size_t i = 0; i < n; ++i) {
        if (better({rank_key(logits[i]), static_cast<int32_t>(i)}, t)) ++rank;
    }
    return rank;
}

}  // namespace

Comparison compare(const float* logits_a, const float* logits_b, size_t n_vocab) {
    Comparison c;
    if (n_vocab == 0) return c;
    // Reused between calls: two vocabularies of doubles, every step.
    thread_local std::vector<double> prob_a, prob_b;
    const double norm_a = softmax(logits_a, n_vocab, prob_a);
    const double norm_b = softmax(logits_b, n_vocab, prob_b);
    if (std::isnan(norm_a) || std::isnan(norm_b)) return c;

    const double inf = std::numeric_limits<double>::infinity();
    const double ln_half = std::log(0.5);
    double kl_ab = 0, kl_ba = 0, js = 0;  // nats
    for (size_t i = 0; i < n_vocab; ++i) {
        // ln p; -inf (or NaN, treated alike) is probability 0.
        double la = static_cast<double>(logits_a[i]) - norm_a;
        double lb = static_cast<double>(logits_b[i]) - norm_b;
        const bool za = !(la > -inf);
        const bool zb = !(lb > -inf);
        if (za && zb) continue;
        if (la == lb) continue;  // equal probabilities add exactly 0 to all three
        const double pa = prob_a[i];
        const double pb = prob_b[i];
        if (!za) kl_ab += zb ? inf : pa * (la - lb);
        if (!zb) kl_ba += za ? inf : pb * (lb - la);
        // ln m = ln(½(pA + pB)). Below the smallest normal double, as a
        // log-sum-exp so that tiny probabilities do not become ln 0.
        const double m = 0.5 * (pa + pb);
        double ln_m;
        if (m >= std::numeric_limits<double>::min()) ln_m = std::log(m);
        else if (za) ln_m = ln_half + lb;
        else if (zb) ln_m = ln_half + la;
        else ln_m = ln_half + std::max(la, lb) + std::log1p(std::exp(-std::fabs(la - lb)));
        if (!za) js += pa * (la - ln_m);
        if (!zb) js += pb * (lb - ln_m);
    }
    const double ln2 = std::log(2.0);
    c.kl_ab = std::max(0.0, kl_ab / ln2);
    c.kl_ba = std::max(0.0, kl_ba / ln2);
    c.js = std::min(1.0, std::max(0.0, 0.5 * js / ln2));

    const int32_t top_a = argmax(logits_a, n_vocab);
    const int32_t top_b = argmax(logits_b, n_vocab);
    c.same_top = top_a == top_b;
    c.rank_a_in_b = rank_of(logits_b, n_vocab, top_a);
    c.rank_b_in_a = rank_of(logits_a, n_vocab, top_b);
    return c;
}

namespace {

constexpr double REST_FLOOR = 1e-6;

// Position of `token` among the first `n_main` entries of `list`, or RANK_UNKNOWN.
uint32_t rank_in(const std::vector<Candidate>& list, size_t n_main, uint32_t token) {
    n_main = std::min(n_main, list.size());
    for (size_t i = 0; i < n_main; ++i)
        if (list[i].token == token) return static_cast<uint32_t>(i);
    return RANK_UNKNOWN;
}

}  // namespace

Comparison compare_candidates(const std::vector<Candidate>& a, size_t n_main_a, const std::vector<Candidate>& b,
                              size_t n_main_b) {
    Comparison c;
    c.rank_a_in_b = c.rank_b_in_a = RANK_UNKNOWN;
    if (a.empty() || b.empty()) return c;

    // The cells: the tokens both lists hold, then each model's rest.
    std::vector<double> pa, pb;
    double sum_a = 0, sum_b = 0;
    for (const Candidate& x : a) {
        const auto it = std::find_if(b.begin(), b.end(), [&](const Candidate& y) { return y.token == x.token; });
        if (it == b.end()) continue;
        pa.push_back(std::max(0.0, static_cast<double>(x.p_raw)));
        pb.push_back(std::max(0.0, static_cast<double>(it->p_raw)));
        sum_a += pa.back();
        sum_b += pb.back();
    }
    pa.push_back(std::max(REST_FLOOR, 1.0 - sum_a));
    pb.push_back(std::max(REST_FLOOR, 1.0 - sum_b));

    // The same terms as `compare`, over the cells: a cell with probability
    // 0 adds nothing, and KL is +infinity if only the other model gives it some.
    const double inf = std::numeric_limits<double>::infinity();
    double kl_ab = 0, kl_ba = 0, js = 0;  // nats
    for (size_t i = 0; i < pa.size(); ++i) {
        const double x = pa[i], y = pb[i];
        if (x == y) continue;  // equal probabilities add exactly 0 to all three
        const double m = 0.5 * (x + y);
        if (x > 0) {
            kl_ab += y > 0 ? x * std::log(x / y) : inf;
            js += x * std::log(x / m);
        }
        if (y > 0) {
            kl_ba += x > 0 ? y * std::log(y / x) : inf;
            js += y * std::log(y / m);
        }
    }
    const double ln2 = std::log(2.0);
    c.kl_ab = std::max(0.0, kl_ab / ln2);
    c.kl_ba = std::max(0.0, kl_ba / ln2);
    c.js = std::min(1.0, std::max(0.0, 0.5 * js / ln2));

    c.same_top = a[0].token == b[0].token;
    c.rank_a_in_b = rank_in(b, n_main_b, a[0].token);
    c.rank_b_in_a = rank_in(a, n_main_a, b[0].token);
    return c;
}

}  // namespace ils
