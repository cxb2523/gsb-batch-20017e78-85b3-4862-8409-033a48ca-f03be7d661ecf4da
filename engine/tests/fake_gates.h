// Reference gates for tests: the semantics of the llama.cpp samplers of the
// gate table (third_party/llama.cpp/src/llama-sampler.cpp, v0.9.0), written
// again without llama.cpp, neutral cases included. Ties may be broken in
// another order; nothing else differs.
//
// The grammar is a toy: `gbnf` is the set of admitted bytes. A token is
// admitted if its text is not empty and all its bytes are in the set; EOG
// tokens always are, other control tokens never. A `gbnf` that starts with
// '!' is an invalid grammar.
#pragma once

#include "gates.h"
#include "model.h"

#include <algorithm>
#include <array>
#include <cfloat>
#include <cmath>
#include <cstdint>
#include <deque>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>

namespace ils {
namespace ref {

constexpr size_t MIN_KEEP = 1;  // what make_llama_sampler gives top_p and min_p

inline bool by_logit(const TokenData& a, const TokenData& b) { return a.logit > b.logit; }

// llama_token_data_array_partial_sort_inplace: keeps the top n, sorted.
inline void keep_top(TokenArray& cur, size_t n) {
    std::partial_sort(cur.data, cur.data + n, cur.data + cur.size, by_logit);
    cur.size = n;
    cur.sorted = true;
}

class Neutral : public Sampler {  // llama_sampler_init_empty
public:
    void apply(TokenArray&) override {}
    void accept(int32_t) override {}
};

class TopK : public Sampler {
public:
    explicit TopK(int32_t k) : k_(k) {}
    void apply(TokenArray& cur) override {
        const size_t k = std::min(static_cast<size_t>(k_), cur.size);
        if (!cur.sorted) keep_top(cur, k);
        cur.size = k;
    }
    void accept(int32_t) override {}

private:
    int32_t k_;
};

class TopP : public Sampler {
public:
    explicit TopP(float p) : p_(p) {}
    void apply(TokenArray& cur) override {
        // Softmax in float, then the running sum in descending order (the
        // adaptive partial sort of llama.cpp reaches the same order).
        float max_l = cur.data[0].logit;
        if (!cur.sorted)
            for (size_t i = 1; i < cur.size; ++i) max_l = std::max(max_l, cur.data[i].logit);
        float sum = 0;
        for (size_t i = 0; i < cur.size; ++i) {
            cur.data[i].p = expf(cur.data[i].logit - max_l);
            sum += cur.data[i].p;
        }
        for (size_t i = 0; i < cur.size; ++i) cur.data[i].p /= sum;
        if (!cur.sorted) keep_top(cur, cur.size);
        float cum = 0;
        size_t last = cur.size;
        for (size_t i = 0; i < cur.size; ++i) {
            cum += cur.data[i].p;
            if (cum >= p_ && i + 1 >= MIN_KEEP) {
                last = i + 1;
                break;
            }
        }
        cur.size = last;
    }
    void accept(int32_t) override {}

private:
    float p_;
};

class MinP : public Sampler {
public:
    explicit MinP(float p) : p_(p) {}
    void apply(TokenArray& cur) override {
        if (cur.size == 0) return;
        if (!cur.sorted) {
            // In logit space, keeping the original order and `sorted`.
            float max_l = -FLT_MAX;
            for (size_t i = 0; i < cur.size; ++i) max_l = std::max(max_l, cur.data[i].logit);
            const float min_l = max_l + logf(p_);
            size_t n = 0;
            for (size_t i = 0; i < cur.size; ++i)
                if (cur.data[i].logit >= min_l) cur.data[n++] = cur.data[i];
            if (n > 0 && n >= MIN_KEEP) {
                cur.size = n;
                return;
            }
            keep_top(cur, cur.size);  // nothing kept: the sorted way, as llama.cpp
        }
        const float min_l = cur.data[0].logit + logf(p_);
        size_t i = 1;
        while (i < cur.size && !(cur.data[i].logit < min_l && i >= MIN_KEEP)) ++i;
        cur.size = i;
    }
    void accept(int32_t) override {}

private:
    float p_;
};

class Temp : public Sampler {
public:
    explicit Temp(float t) : t_(t) {}
    void apply(TokenArray& cur) override {
        if (cur.size == 0) return;
        if (t_ <= 0) {
            // Keeps the first maximum; the rest go to -inf, size unchanged.
            size_t max_i = 0;
            float max_l = cur.data[0].logit;
            for (size_t i = 1; i < cur.size; ++i) {
                if (cur.data[i].logit > max_l) {
                    cur.data[max_i].logit = -INFINITY;
                    max_i = i;
                    max_l = cur.data[i].logit;
                } else {
                    cur.data[i].logit = -INFINITY;
                }
            }
            return;
        }
        for (size_t i = 0; i < cur.size; ++i) cur.data[i].logit /= t_;
    }
    void accept(int32_t) override {}

private:
    float t_;
};

class Penalties : public Sampler {
public:
    Penalties(int32_t last_n, float repeat, float freq, float present)
        : last_n_(last_n), repeat_(repeat), freq_(freq), present_(present) {}
    void apply(TokenArray& cur) override {
        for (size_t i = 0; i < cur.size; ++i) {
            const auto it = count_.find(cur.data[i].id);
            if (it == count_.end()) continue;
            float& l = cur.data[i].logit;
            if (l <= 0) l *= repeat_;
            else l /= repeat_;
            l -= static_cast<float>(it->second) * freq_ + static_cast<float>(it->second > 0) * present_;
        }
        cur.sorted = false;
    }
    void accept(int32_t token) override {
        ++count_[token];
        if (prev_.size() >= static_cast<size_t>(last_n_)) {
            const int32_t old = prev_.front();
            prev_.pop_front();
            if (--count_[old] == 0) count_.erase(old);
        }
        prev_.push_back(token);
    }

private:
    int32_t last_n_;
    float repeat_, freq_, present_;
    std::deque<int32_t> prev_;  // the last last_n tokens
    std::map<int32_t, int> count_;
};

class ToyGrammar : public Sampler {
public:
    ToyGrammar(const std::string& gbnf, const Model& model) : model_(model) {
        if (!gbnf.empty() && gbnf[0] == '!') throw std::runtime_error("invalid grammar");
        for (unsigned char c : gbnf) bytes_[c] = true;
    }
    void apply(TokenArray& cur) override {
        for (size_t i = 0; i < cur.size; ++i)
            if (!admits(cur.data[i].id)) cur.data[i].logit = -INFINITY;
    }
    void accept(int32_t token) override {
        // llama.cpp throws too (after breaking the grammar).
        if (!admits(token)) throw std::runtime_error("toy grammar: token " + std::to_string(token) + " not admitted");
    }
    bool admits(int32_t token) override {
        const uint8_t a = model_.attr(token);
        if (a & ATTR_EOG) return true;
        if (a & ATTR_CONTROL) return false;
        const std::string text = model_.piece(token);
        if (text.empty()) return false;
        for (unsigned char c : text)
            if (!bytes_[c]) return false;
        return true;
    }

private:
    const Model& model_;
    std::array<bool, 256> bytes_{};
};

}  // namespace ref

// The reference sampler of a gate. Parameters go to float as llama.cpp takes
// them; the neutral values give a sampler that does nothing, like
// llama_sampler_init_empty.
inline std::unique_ptr<Sampler> make_reference_gate(const GateSpec& s, const Model& model) {
    if (s.type == "top_k") {
        if (s.k <= 0) return std::make_unique<ref::Neutral>();
        return std::make_unique<ref::TopK>(s.k);
    }
    if (s.type == "top_p") {
        const float p = static_cast<float>(s.p);
        if (p >= 1.0f) return std::make_unique<ref::Neutral>();
        return std::make_unique<ref::TopP>(p);
    }
    if (s.type == "min_p") {
        const float p = static_cast<float>(s.p);
        if (p <= 0.0f) return std::make_unique<ref::Neutral>();
        return std::make_unique<ref::MinP>(p);
    }
    if (s.type == "temp") {
        const float t = static_cast<float>(s.t);
        if (t == 1.0f) return std::make_unique<ref::Neutral>();
        return std::make_unique<ref::Temp>(t);
    }
    if (s.type == "penalties") {
        const int32_t last_n = std::max(s.last_n, 0);
        const float repeat = static_cast<float>(s.repeat);
        const float freq = static_cast<float>(s.frequency);
        const float present = static_cast<float>(s.presence);
        if (last_n == 0 || (repeat == 1.0f && freq == 0.0f && present == 0.0f))
            return std::make_unique<ref::Neutral>();
        return std::make_unique<ref::Penalties>(last_n, repeat, freq, present);
    }
    if (s.type == "grammar") return std::make_unique<ref::ToyGrammar>(s.gbnf, model);
    throw std::runtime_error("unknown gate type '" + s.type + "'");
}

}  // namespace ils
