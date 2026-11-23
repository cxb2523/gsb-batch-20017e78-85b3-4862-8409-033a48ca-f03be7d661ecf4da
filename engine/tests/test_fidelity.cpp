// Gate fidelity on the test model: the final distribution of
// GateChain::trace, applied one gate at a time, against a llama.cpp sampler
// chain with the same samplers applied in one go over the whole vocabulary.
// Same survivors, same probabilities within 0.0001. Also the "Top-k", "Sum"
// and "Most likely" criteria, and the hand-computed cases of gate_cases.h on
// the real samplers.
// Usage: test_fidelity <model.gguf>
#include "check.h"
#include "gate_cases.h"
#include "gates.h"
#include "llama_gates.h"
#include "metrics.h"
#include "model.h"

#include "llama.h"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <fstream>
#include <map>
#include <memory>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

using namespace ils;

namespace {

constexpr const char* PROMPT =
    "The cat sat on the mat. The cat sat on the mat again, and the dog watched the cat from the";
constexpr const char* JSON_PROMPT = "Here is a JSON object that describes a cat, with its name and its age:\n";
constexpr size_t STEPS = 4;  // positions per configuration: short

using Dist = std::map<int32_t, double>;

std::vector<GateSpec> chain(const char* json) { return parse_gates(nlohmann::ordered_json::parse(json)); }

// A llama.cpp sampler chain built from the same specs, holding the same
// tokens: penalties all of them, a grammar only the generated ones, given
// sampler by sampler before they go into the chain.
class RefChain {
public:
    RefChain(const std::vector<GateSpec>& specs, const llama_vocab* vocab, const std::vector<int32_t>& path,
             size_t prompt_len)
        : chain_(llama_sampler_chain_init(llama_sampler_chain_default_params())) {
        for (const GateSpec& s : specs) {
            llama_sampler* smpl = make_llama_sampler(s, vocab);
            for (size_t i = 0; i < path.size(); ++i)
                if (s.type != "grammar" || i >= prompt_len) llama_sampler_accept(smpl, path[i]);
            llama_sampler_chain_add(chain_, smpl);
        }
    }
    ~RefChain() { llama_sampler_free(chain_); }
    RefChain(const RefChain&) = delete;
    RefChain& operator=(const RefChain&) = delete;

    void accept_generated(int32_t token) { llama_sampler_accept(chain_, token); }

    // The whole vocabulary through the chain in one go; softmax in double
    // over what is left with a finite logit.
    Dist final_dist(const std::vector<float>& logits) {
        buf_.resize(logits.size());
        for (size_t i = 0; i < logits.size(); ++i) buf_[i] = {static_cast<llama_token>(i), logits[i], 0.0f};
        llama_token_data_array arr = {buf_.data(), buf_.size(), -1, false};
        llama_sampler_apply(chain_, &arr);
        double mx = -INFINITY;
        for (size_t i = 0; i < arr.size; ++i)
            if (std::isfinite(arr.data[i].logit)) mx = std::max(mx, static_cast<double>(arr.data[i].logit));
        Dist d;
        double sum = 0;
        for (size_t i = 0; i < arr.size; ++i) {
            if (!std::isfinite(arr.data[i].logit)) continue;
            const double e = std::exp(static_cast<double>(arr.data[i].logit) - mx);
            d[arr.data[i].id] = e;
            sum += e;
        }
        for (auto& [id, p] : d) p /= sum;
        return d;
    }

private:
    llama_sampler* chain_;
    std::vector<llama_token_data> buf_;
};

Dist to_dist(const std::vector<Weighted>& w) {
    Dist d;
    for (const Weighted& x : w) d[x.token] = x.p;
    return d;
}

// Same survivors and probabilities within 0.0001.
bool same_dist(const Dist& got, const Dist& want, const char* what, size_t step) {
    bool ok = got.size() == want.size();
    double worst = 0;
    for (const auto& [id, p] : want) {
        const auto it = got.find(id);
        if (it == got.end()) {
            ok = false;
            continue;
        }
        worst = std::max(worst, std::fabs(it->second - p));
    }
    if (worst >= 1e-4) ok = false;
    if (!ok)
        std::fprintf(stderr, "  %s, step %zu: %zu survivors vs %zu in llama.cpp, worst |dp| %.3g\n", what, step,
                     got.size(), want.size(), worst);
    return ok;
}

std::vector<int32_t> main_ids(const std::vector<float>& logits) {
    std::vector<int32_t> ids;
    for (const TopCandidate& c : analyze(logits.data(), logits.size(), 32).top) ids.push_back(c.token);
    return ids;
}

uint32_t n_finite(const std::vector<float>& logits) {
    return static_cast<uint32_t>(std::count_if(logits.begin(), logits.end(), [](float l) { return std::isfinite(l); }));
}

// Checks that hold for every trace: Top-k, and that the last row of stage_p
// is the final distribution.
void check_trace(const std::vector<GateSpec>& specs, const GateTrace& tr, const std::vector<int32_t>& main,
                 const Dist& final_d, uint32_t alive_before) {
    CHECK_EQ(tr.survivors.size(), specs.size());
    for (size_t g = 0; g < specs.size(); ++g) {
        if (specs[g].type != "top_k") continue;
        const uint32_t prev = g == 0 ? alive_before : tr.survivors[g - 1];
        CHECK_EQ(tr.survivors[g], std::min(static_cast<uint32_t>(specs[g].k), prev));
    }
    CHECK_EQ(final_d.size(), static_cast<size_t>(tr.survivors.back()));
    const size_t width = main.size() + tr.extra.size();
    CHECK_EQ(tr.stage_p.size(), specs.size() * width);
    const float* last = tr.stage_p.data() + (specs.size() - 1) * width;
    for (size_t i = 0; i < width; ++i) {
        const int32_t id = i < main.size() ? main[i] : tr.extra[i - main.size()];
        const auto it = final_d.find(id);
        CHECK_NEAR(last[i], it == final_d.end() ? 0.0 : it->second, 1e-6);
    }
    CHECK(final_d.count(tr.pick) == 1);
}

// The most likely of a distribution; ties go to the lower id.
int32_t most_likely(const Dist& d) {
    int32_t best = d.begin()->first;
    for (const auto& [id, p] : d)
        if (p > d.at(best)) best = id;
    return best;
}

struct Fixture {
    std::unique_ptr<Model> model;
    const llama_vocab* vocab = nullptr;
    // A greedy path from PROMPT: the logits at each of STEPS positions and
    // the token taken after each.
    std::vector<int32_t> prompt;
    std::vector<std::vector<float>> logits;
    std::vector<int32_t> next;
};

// Every configuration over the greedy path, with the criteria that apply.
void run_fixed(Fixture& f, const char* name, const std::vector<GateSpec>& specs) {
    GateChain gc(*f.model, specs, f.prompt, f.prompt.size());
    RefChain ref(specs, f.vocab, f.prompt, f.prompt.size());
    // "Most likely": the same chain without its last gate.
    const GateSpec& last = specs.back();
    const bool greedy_last = (last.type == "temp" && last.t == 0) || (last.type == "top_k" && last.k == 1);
    std::unique_ptr<GateChain> prefix;
    if (greedy_last)
        prefix = std::make_unique<GateChain>(*f.model,
                                             std::vector<GateSpec>(specs.begin(), specs.end() - 1), f.prompt,
                                             f.prompt.size());
    const bool ends_top8 = last.type == "top_k" && last.k <= 8;

    double ms = 0;
    for (size_t s = 0; s < STEPS; ++s) {
        const std::vector<float>& l = f.logits[s];
        const std::vector<int32_t> main = main_ids(l);
        const uint32_t depth = static_cast<uint32_t>(f.prompt.size() - 1 + s);
        const auto t0 = std::chrono::steady_clock::now();
        const GateTrace tr = gc.trace(l.data(), l.size(), main, 42, depth);
        ms += std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
        const Dist got = to_dist(gc.last_final());
        CHECK(same_dist(got, ref.final_dist(l), name, s));
        check_trace(specs, tr, main, got, n_finite(l));

        if (prefix) {
            // With no gate before it, what is left is the raw distribution,
            // and a chain without gates keeps no final distribution.
            prefix->trace(l.data(), l.size(), main, 42, depth);
            CHECK_EQ(tr.pick, prefix->size() == 0 ? main[0] : most_likely(to_dist(prefix->last_final())));
        }
        if (ends_top8) {
            // "Sum": every survivor is among the entries of the EVAL, and the
            // last row of stage_p adds up to 1.
            std::set<int32_t> entries(main.begin(), main.end());
            entries.insert(tr.extra.begin(), tr.extra.end());
            for (const auto& [id, p] : got) CHECK(entries.count(id) == 1);
            const size_t width = main.size() + tr.extra.size();
            double sum = 0;
            for (size_t i = 0; i < width; ++i) sum += tr.stage_p[(specs.size() - 1) * width + i];
            CHECK_NEAR(sum, 1.0, 1e-4);
        }

        gc.accept(f.next[s], true);
        ref.accept_generated(f.next[s]);
        if (prefix) prefix->accept(f.next[s], true);
    }
    std::printf("  %-28s trace %.2f ms/step\n", name, ms / STEPS);
}

// A grammar needs a path it admits: generate it with the chain's own picks.
void run_grammar(Fixture& f, const char* name, const std::vector<GateSpec>& specs) {
    std::vector<int32_t> path = f.model->tokenize_prompt(JSON_PROMPT, false, "");
    const size_t prompt_len = path.size();
    GateChain gc(*f.model, specs, path, prompt_len);
    RefChain ref(specs, f.vocab, path, prompt_len);
    double ms = 0;
    std::string text;
    for (size_t s = 0; s < STEPS; ++s) {
        EvalOutput out;
        f.model->eval(path, out);
        const std::vector<float>& l = out.logits;
        const std::vector<int32_t> main = main_ids(l);
        const auto t0 = std::chrono::steady_clock::now();
        const GateTrace tr = gc.trace(l.data(), l.size(), main, 42, static_cast<uint32_t>(path.size() - 1));
        ms += std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
        const Dist got = to_dist(gc.last_final());
        CHECK(same_dist(got, ref.final_dist(l), name, s));
        check_trace(specs, tr, main, got, n_finite(l));
        gc.accept(tr.pick, true);
        ref.accept_generated(tr.pick);
        path.push_back(tr.pick);
        text += f.model->piece(tr.pick);
    }
    std::printf("  %-28s trace %.2f ms/step, text \"%s\"\n", name, ms / STEPS, text.c_str());
    CHECK(!text.empty() && text.find('{') != std::string::npos);
}

std::string read_file(const char* path) {
    std::ifstream in(path, std::ios::binary);
    if (!in) throw std::runtime_error(std::string("cannot read ") + path);
    std::stringstream ss;
    ss << in.rdbuf();
    return ss.str();
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 2) {
        std::fprintf(stderr, "usage: test_fidelity <model.gguf>\n");
        return 2;
    }
    Fixture f;
    LlamaOptions o;
    o.path = argv[1];
    o.n_ctx = 1024;
    f.model = load_llama_model(o);  // also initializes the llama.cpp backend

    // The reference chains need a llama_vocab: the same GGUF, vocabulary only.
    llama_model_params mp = llama_model_default_params();
    mp.vocab_only = true;
    llama_model* vocab_model = llama_model_load_from_file(argv[1], mp);
    if (!vocab_model) {
        std::fprintf(stderr, "cannot load the vocabulary of %s\n", argv[1]);
        return 1;
    }
    f.vocab = llama_model_get_vocab(vocab_model);
    CHECK_EQ(static_cast<uint32_t>(llama_vocab_n_tokens(f.vocab)), f.model->n_vocab());

    // The hand-computed cases on the real samplers.
    ils_test::run_gate_cases([&f](const GateSpec& s) { return f.model->make_sampler(s); });

    // The greedy path.
    f.prompt = f.model->tokenize_prompt(PROMPT, false, "");
    std::vector<int32_t> path = f.prompt;
    for (size_t s = 0; s < STEPS; ++s) {
        EvalOutput out;
        f.model->eval(path, out);
        const int32_t best = static_cast<int32_t>(std::max_element(out.logits.begin(), out.logits.end()) -
                                                  out.logits.begin());
        f.logits.push_back(std::move(out.logits));
        f.next.push_back(best);
        path.push_back(best);
    }

    // Each gate alone, the full chain, and the criteria.
    run_fixed(f, "penalties", chain(R"([{"type":"penalties","repeat":1.3,"frequency":0.1,"presence":0.2}])"));
    run_fixed(f, "top_k 40", chain(R"([{"type":"top_k","k":40}])"));
    run_fixed(f, "top_p 0.95", chain(R"([{"type":"top_p","p":0.95}])"));
    run_fixed(f, "min_p 0.05", chain(R"([{"type":"min_p","p":0.05}])"));
    run_fixed(f, "temp 0.8", chain(R"([{"type":"temp","t":0.8}])"));
    run_fixed(f, "temp 0", chain(R"([{"type":"temp","t":0}])"));
    const char* full = R"([{"type":"penalties","last_n":64,"repeat":1.1},{"type":"top_k","k":40},
        {"type":"top_p","p":0.95},{"type":"min_p","p":0.05},{"type":"temp","t":0.8}])";
    run_fixed(f, "full chain", chain(full));
    // Top-k after a gate that left fewer than k.
    run_fixed(f, "top_p 0.5, top_k 1000", chain(R"([{"type":"top_p","p":0.5},{"type":"top_k","k":1000}])"));
    // Sum.
    run_fixed(f, "... top_k 8", chain(R"([{"type":"penalties","repeat":1.1},{"type":"top_p","p":0.95},
        {"type":"temp","t":1.5},{"type":"top_k","k":8}])"));
    // Most likely.
    run_fixed(f, "... temp 0", chain(R"([{"type":"penalties","repeat":1.3},{"type":"top_p","p":0.9},
        {"type":"temp","t":0}])"));
    run_fixed(f, "... top_k 1", chain(R"([{"type":"penalties","repeat":1.3},{"type":"top_p","p":0.9},
        {"type":"top_k","k":1}])"));

    // The JSON grammar, alone and in front of the full chain.
    GateSpec grammar;
    grammar.type = "grammar";
    grammar.gbnf = read_file("third_party/llama.cpp/grammars/json.gbnf");
    run_grammar(f, "grammar", {grammar});
    std::vector<GateSpec> with_grammar = chain(full);
    with_grammar.insert(with_grammar.begin(), grammar);
    run_grammar(f, "grammar + full chain", with_grammar);

    llama_model_free(vocab_model);
    f.model.reset();
    return test_result();
}
