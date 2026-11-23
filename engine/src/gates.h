// Gates: the sampler chain of CONFIG.gates, applied one sampler at a time so
// that every stage can be shown, and the final draw. Each model has its own
// chain, because penalties and grammar depend on the tokens before.
//
// This file knows nothing about llama.cpp. A gate is a `Sampler`, which a
// Model builds from a GateSpec: LlamaModel wraps the llama.cpp sampler of the
// gate table (llama_gates.cpp); the fake model of the tests has reference
// implementations.
#pragma once

#include "frames.h"

#include <nlohmann/json_fwd.hpp>

#include <cstddef>
#include <cstdint>
#include <memory>
#include <vector>

namespace ils {

class Model;

constexpr size_t MAX_GATES = 16;  // per chain
constexpr size_t MAX_EXTRA = 8;   // added candidates per EVAL

// Same layout as llama_token_data and llama_token_data_array (checked with
// static_assert in llama_gates.cpp): the array goes to llama.cpp as it is.
struct TokenData {
    int32_t id;
    float logit;
    float p;  // llama.cpp only fills it in some samplers: never read it
};

struct TokenArray {
    TokenData* data;
    size_t size;
    int64_t selected;  // index into data, not a token id; -1: none
    bool sorted;       // by logit, descending
};

// One gate with its state. Used by one thread at a time.
class Sampler {
public:
    virtual ~Sampler() = default;

    // Applies the gate to the candidates. It may reorder them, shrink `size`,
    // leave logits at minus infinity and replace `data`. A candidate is alive
    // afterwards if it is still in the array AND its logit is finite.
    virtual void apply(TokenArray& cur) = 0;

    // A token has entered the text. Only call it after admits(token).
    virtual void accept(int32_t token) = 0;

    // Whether accept(token) is safe. Only a grammar can say no: accepting a
    // token it rejects breaks it, or aborts the process.
    virtual bool admits(int32_t /*token*/) { return true; }
};

// Reads and validates the "gates" array of a config object. Missing
// parameters take the defaults of GateSpec, except those a gate cannot do
// without (k, p, t, gbnf). Throws std::runtime_error with a message for the
// user: not an array, more than MAX_GATES, unknown type, wrong parameter.
//   top_k: k integer >= 1        top_p: 0 < p <= 1      min_p: 0 <= p <= 1
//   temp: t >= 0                 grammar: gbnf, a non-empty string
//   penalties: last_n integer >= 0, repeat > 0, frequency and presence finite
std::vector<GateSpec> parse_gates(const nlohmann::ordered_json& gates);

struct Weighted {
    int32_t token = 0;
    double p = 0;
};

// The number of the final draw for a position: uniform in [0, 1), a function
// of the seed and the depth only, so A and B get the same one at the same
// position and a session can be regenerated.
double draw_u(uint64_t seed, uint32_t depth);

// The final draw: walks the candidates from most to least likely (ties go to
// the lower token id), adding up their probabilities, and returns the first
// one where the sum exceeds `u`; the last one if none does. `dist` is
// reordered. It must not be empty.
int32_t draw(std::vector<Weighted>& dist, double u);

// What the gates did to one distribution.
struct GateTrace {
    int32_t pick = 0;                 // the token this model chooses
    std::vector<int32_t> extra;       // added candidates, most likely first; none of them is in `main`
    std::vector<uint32_t> survivors;  // per gate: candidates of the whole vocabulary still alive
    // Per gate, the probability of each tracked candidate (`main`, then
    // `extra`) after it, normalized among the survivors; 0 once eliminated.
    // gates x (main.size() + extra.size()), one row per gate.
    std::vector<float> stage_p;
};

// The gates of one model, in order, with the state they have after the tokens
// of a path.
class GateChain {
public:
    GateChain();  // no gates
    ~GateChain();
    GateChain(GateChain&&) noexcept;
    GateChain& operator=(GateChain&&) noexcept;

    // Builds the samplers with model.make_sampler and gives them `path`:
    // penalties get every token; a grammar only the generated ones (index >=
    // prompt_len), each checked with admits() first.
    // Throws std::runtime_error with a message for the user if a sampler
    // cannot be built (invalid grammar) or the grammar does not admit the
    // path. Nothing else is touched: to change gates or path, build a new
    // chain and replace the old one once this has not thrown.
    GateChain(Model& model, const std::vector<GateSpec>& specs, const std::vector<int32_t>& path, size_t prompt_len);

    size_t size() const;  // number of gates

    // Applies the gates one at a time over a copy of the whole vocabulary.
    // `main` are the main candidates of the EVAL (most likely first, never
    // empty); `depth` is the depth of the evaluated node.
    // With no gates the pick is main[0] and the rest is empty. Otherwise the
    // pick is drawn from the distribution the last gate leaves, with
    // draw_u(seed, depth). `extra` are the pick, if it is not in `main`, and
    // the most likely candidates of that distribution that are not in `main`,
    // MAX_EXTRA at most.
    // Throws std::runtime_error if no candidate survives.
    GateTrace trace(const float* logits, size_t n_vocab, const std::vector<int32_t>& main, uint64_t seed,
                    uint32_t depth);

    // The distribution left by the last gate in the last trace(): every
    // survivor with its probability, in no particular order. For tests.
    const std::vector<Weighted>& last_final() const;

    // A token has entered the text after the path. `generated` is false for
    // prompt tokens. Throws std::runtime_error if the grammar does not admit
    // it; the chain must then be rebuilt.
    void accept(int32_t token, bool generated);

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}  // namespace ils
