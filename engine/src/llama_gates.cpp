// The gate table on top of llama.cpp (llama_gates.h). Signatures from
// third_party/llama.cpp/include/llama.h, v0.9.0.
#include "llama_gates.h"

#include "llama.h"

#include <cmath>
#include <cstddef>
#include <stdexcept>
#include <string>

namespace ils {

// TokenArray goes to llama.cpp through a reinterpret_cast: same layout.
static_assert(sizeof(TokenData) == sizeof(llama_token_data));
static_assert(offsetof(TokenData, id) == offsetof(llama_token_data, id));
static_assert(offsetof(TokenData, logit) == offsetof(llama_token_data, logit));
static_assert(offsetof(TokenData, p) == offsetof(llama_token_data, p));
static_assert(sizeof(TokenArray) == sizeof(llama_token_data_array));
static_assert(offsetof(TokenArray, data) == offsetof(llama_token_data_array, data));
static_assert(offsetof(TokenArray, size) == offsetof(llama_token_data_array, size));
static_assert(offsetof(TokenArray, selected) == offsetof(llama_token_data_array, selected));
static_assert(offsetof(TokenArray, sorted) == offsetof(llama_token_data_array, sorted));

llama_sampler* make_llama_sampler(const GateSpec& s, const llama_vocab* vocab) {
    llama_sampler* out = nullptr;
    if (s.type == "grammar") {
        try {
            out = llama_sampler_init_grammar(vocab, s.gbnf.c_str(), "root");
        } catch (const std::exception&) {
            out = nullptr;
        }
        if (!out) throw std::runtime_error("invalid grammar");
    } else if (s.type == "penalties") {
        out = llama_sampler_init_penalties(llama_vocab_n_tokens(vocab), s.last_n, static_cast<float>(s.repeat),
                                           static_cast<float>(s.frequency), static_cast<float>(s.presence));
    } else if (s.type == "top_k") {
        out = llama_sampler_init_top_k(s.k);
    } else if (s.type == "top_p") {
        out = llama_sampler_init_top_p(static_cast<float>(s.p), 1);
    } else if (s.type == "min_p") {
        out = llama_sampler_init_min_p(static_cast<float>(s.p), 1);
    } else if (s.type == "temp") {
        out = llama_sampler_init_temp(static_cast<float>(s.t));
    } else {
        throw std::runtime_error("unknown gate type '" + s.type + "'");
    }
    if (!out) throw std::runtime_error("cannot create the " + s.type + " sampler");
    return out;
}

namespace {

class LlamaSampler final : public Sampler {
public:
    LlamaSampler(llama_sampler* s, bool grammar) : s_(s), grammar_(grammar) {}
    ~LlamaSampler() override { llama_sampler_free(s_); }
    LlamaSampler(const LlamaSampler&) = delete;
    LlamaSampler& operator=(const LlamaSampler&) = delete;

    void apply(TokenArray& cur) override { llama_sampler_apply(s_, reinterpret_cast<llama_token_data_array*>(&cur)); }
    void accept(int32_t token) override { llama_sampler_accept(s_, token); }

    // The check of common/sampling.cpp: the grammar alone on an array with
    // that single candidate.
    bool admits(int32_t token) override {
        if (!grammar_) return true;
        llama_token_data one = {token, 1.0f, 0.0f};
        llama_token_data_array arr = {&one, 1, -1, false};
        llama_sampler_apply(s_, &arr);
        return arr.data[0].logit != -INFINITY;
    }

private:
    llama_sampler* s_;
    bool grammar_;
};

}  // namespace

std::unique_ptr<Sampler> make_llama_gate(const GateSpec& spec, const llama_vocab* vocab) {
    llama_sampler* s = make_llama_sampler(spec, vocab);
    try {
        return std::make_unique<LlamaSampler>(s, spec.type == "grammar");
    } catch (...) {
        llama_sampler_free(s);
        throw;
    }
}

}  // namespace ils
