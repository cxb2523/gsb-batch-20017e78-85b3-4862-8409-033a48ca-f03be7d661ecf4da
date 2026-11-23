// One model as the coordinator sees it. LlamaModel (model.cpp) implements it
// with llama.cpp; tests use a scripted fake, so the coordinator, the server
// and the web can be exercised without a GGUF and without the GPU.
//
// Threading: every method is called from the coordinator thread, except
// that with two models `eval` and `prefill` of B are called from a helper
// thread while the coordinator waits for it (A's run on the coordinator at
// the same time). There are never two calls at once on the same model. An
// implementation may run the decoding on a thread of its own (LlamaModel
// does: that thread owns the llama.cpp context), but the calls block.
#pragma once

#include "frames.h"
#include "gates.h"

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace ils {

struct EvalOutput {
    std::vector<float> logits;  // n_vocab values, for the token after the path
    double decode_ms = 0;       // time spent decoding, for the EVAL frame
    bool approximate = false;   // the context was rebuilt in batches: the numbers are not bit-exact
    // The logit lens, one entry per layer of lens_layers(), the answer being
    // the most likely token of `logits`. Empty without the lens, or if the
    // step could not capture every layer.
    std::vector<LensLayer> lens;
};

class Model {
public:
    virtual ~Model() = default;

    // Data for HELLO. `slot` is filled in by the caller.
    virtual ModelInfo info() const = 0;
    virtual uint32_t n_vocab() const = 0;
    virtual uint32_t n_ctx() const = 0;
    virtual std::string library_version() const = 0;

    // Turns a prompt into tokens.
    //   raw:  the text as written; special tokens in it are parsed, and the
    //         model's leading special token is added if it defines one.
    //   chat: the model's own chat template, with `system` (skipped when
    //         empty) and `text` as the user message. Special tokens inside
    //         the user's and the system's text are NOT parsed.
    // Throws std::runtime_error with a message for the user.
    virtual std::vector<int32_t> tokenize_prompt(const std::string& text, bool chat,
                                                 const std::string& system) = 0;

    virtual std::string piece(int32_t token) const = 0;  // raw bytes of the token
    virtual uint8_t attr(int32_t token) const = 0;       // ATTR_CONTROL | ATTR_EOG

    // Leaves the context holding exactly `path`, decoded in batches and
    // without asking for logits. Used for the prompt minus its last token.
    // Throws std::runtime_error if decoding fails.
    virtual void prefill(const std::vector<int32_t>& path) = 0;

    // Evaluates the last node of `path` (never empty): makes the context hold
    // the tokens before it, decodes it and returns the logits. The model is
    // placed the cheapest exact way (snapshots.h, `plan_placement`): from
    // what the context holds, trimmed if needed and allowed, or from the
    // snapshot of the deepest ancestor. Tokens that are missing before the
    // last one are decoded one at a time, never in a batch: a batch takes
    // other kernels and its probabilities are not bit-identical. Only when
    // the context cannot be used and
    // there is no snapshot is it emptied and rebuilt in batches, and
    // `out.approximate` is set.
    // The model takes its own snapshots: `prefill` drops them all and takes
    // the pinned one of the prompt; afterwards, one whenever the context
    // holds a multiple of SNAPSHOT_EVERY tokens.
    // Throws std::runtime_error if decoding fails.
    virtual void eval(const std::vector<int32_t>& path, EvalOutput& out) = 0;

    // A new sampler for a gate, in its initial state (gates.h). It only
    // reads the vocabulary, so it can be called and used from any thread; it
    // must not outlive the model.
    // Throws std::runtime_error with a message for the user (invalid grammar).
    virtual std::unique_ptr<Sampler> make_sampler(const GateSpec& spec) = 0;

    // The logit lens: the layers this model
    // projects, ascending, or empty without the lens.
    virtual std::vector<int32_t> lens_layers() const { return {}; }
    // What the lens does not cover in this model, for HELLO.warnings.
    virtual std::vector<std::string> lens_warnings() const { return {}; }
    // Turns the lens off for good and frees what it holds; lens_layers() is
    // empty from then on. For a pair whose layers differ: HELLO carries
    // one list of lens layers for both models.
    virtual void disable_lens() {}
};

struct LlamaOptions {
    std::string path;     // GGUF file
    int n_ctx = 4096;
    int gpu_layers = -1;  // -1: every layer on the GPU
    int snapshot_mb = 3072;  // --snapshot-mem: MiB of snapshots this model may keep
    bool lens = false;        // --lens
    std::string lens_layers;  // --lens-layers ("0,3,7"); empty: LENS_DEFAULT_LAYERS spread evenly
    int lens_threads = 1;     // CPU threads of the projection
    // A layer list that does not fit this model leaves its lens off instead
    // of failing the load. For B: the session then turns the lens off with
    // a warning, since the two models must project the same layers.
    bool lens_optional = false;
};

// Loads a GGUF with llama.cpp. Throws std::runtime_error if it cannot.
// Defined in model.cpp, which only the real binary links.
std::unique_ptr<Model> load_llama_model(const LlamaOptions& options);

struct GpuMemory {
    uint64_t total = 0;  // bytes of the dedicated GPUs; 0 without one
    uint64_t free = 0;
};

// Memory of the dedicated GPUs the models use (never an integrated one),
// summed, as ggml_backend_dev_memory reports it now. Defined in model.cpp.
GpuMemory dedicated_gpu_memory();

}  // namespace ils
