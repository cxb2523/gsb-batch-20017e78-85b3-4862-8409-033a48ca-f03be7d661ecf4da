// Probabilities, entropy and top candidates of one distribution, and the
// comparison of two distributions over the same vocabulary.
#pragma once

#include "frames.h"

#include <cstddef>
#include <cstdint>
#include <vector>

namespace ils {

struct TopCandidate {
    int32_t token = 0;
    double p = 0;  // softmax of the raw logits, no sampler applied
};

struct Analysis {
    double entropy_bits = 0;        // over the whole vocabulary
    double top_mass = 0;            // sum of the probabilities in `top`
    std::vector<TopCandidate> top;  // most likely first; ties go to the lower token id
    // ln(sum(exp(logit))) over the vocabulary: the p_raw of any token, also
    // one outside `top` (an added candidate of the gates), is exp(logit - log_norm).
    double log_norm = 0;
};

// Computed in double precision from the log-softmax so that small
// probabilities survive. Logits of minus infinity count as probability 0.
Analysis analyze(const float* logits, size_t n_vocab, size_t n_top = 32);

struct Comparison {
    double js = 0, kl_ab = 0, kl_ba = 0;        // bits
    uint32_t rank_a_in_b = 0, rank_b_in_a = 0;  // rank in one model of the other's most likely token; 0 is first
    bool same_top = false;
};

// Divergences over the whole vocabulary, from the log-softmax in double
// precision. A term with probability 0 adds nothing; KL(A||B) is +infinity
// when A gives probability to a token B rules out. JS is always within [0, 1].
// Identical logits give exactly 0. Ranks use the tie rule of `analyze`.
// A degenerate input (all -inf or NaN) gives a neutral Comparison: the caller
// has already rejected it through `analyze`.
Comparison compare(const float* logits_a, const float* logits_b, size_t n_vocab);

constexpr uint32_t RANK_UNKNOWN = 0xFFFFFFFFu;

// The approximate comparison,
// for a node the two models evaluated in different steps: only the
// candidates kept from each EVAL are left. `a` and `b` are those lists (the
// main candidates first, most likely first, then the added ones); `n_main_*`
// is the number of main ones.
//   - Cells: the tokens listed by both, plus one "rest" cell per model
//     (1 minus the sum of its probabilities over the common tokens), never
//     below a small positive floor (1e-6) so no division is by zero.
//   - A cell with probability 0 adds nothing, as in `compare`.
//   - rank_a_in_b is the position of a[0]'s token among b's main candidates,
//     or RANK_UNKNOWN if it is not there; likewise rank_b_in_a.
//   - same_top: a[0] and b[0] are the same token.
// An empty list gives a neutral Comparison with both ranks unknown.
Comparison compare_candidates(const std::vector<Candidate>& a, size_t n_main_a, const std::vector<Candidate>& b,
                              size_t n_main_b);

}  // namespace ils
