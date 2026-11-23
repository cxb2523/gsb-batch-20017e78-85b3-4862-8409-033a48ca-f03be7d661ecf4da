// The logit lens on top of llama.cpp: the
// weights read from the GGUF and the capture of the layer outputs through the
// context's cb_eval. Only code that links llama.cpp includes this file; the
// arithmetic is in lens.h.
#pragma once

#include "lens.h"

#include <atomic>
#include <string>
#include <vector>

struct ggml_tensor;

namespace ils {

class LlamaLens {
public:
    // Reads the final norm, the output matrix (output.weight, or
    // token_embd.weight when the weights are tied) dequantized to f32 on
    // `n_threads` threads, the RMS epsilon and, for Gemma 4, the logit
    // softcap. `n_embd` and `n_vocab` are the model's: the tensors must match
    // them. Throws std::runtime_error with a message for the user.
    LlamaLens(const std::string& path, int n_embd, int n_vocab, std::vector<int32_t> layers, int n_threads);

    LlamaLens(const LlamaLens&) = delete;
    LlamaLens& operator=(const LlamaLens&) = delete;
    ~LlamaLens();  // prints how long the projections took

    const std::vector<int32_t>& layers() const { return layers_; }
    // Cases the lens does not cover in this GGUF, for HELLO.warnings.
    const std::vector<std::string>& warnings() const { return warnings_; }

    // The cb_eval of the context, with whatever user data, once forwarded.
    // Disarmed it says no to every tensor, so the graph is not cut. Armed it
    // asks for the l_out-<layer> tensors (exact names) and copies their last
    // row inside the call. The second call always returns true.
    bool on_eval(ggml_tensor* t, bool ask);

    // Around the decode whose last token the lens reads. Arming forgets what
    // was captured. Same thread as the decode.
    void arm();
    void disarm() { armed_ = false; }

    // The lens of the last armed decode, `answer` being the model's most
    // likely token: one LensLayer per layer. Empty if a layer did not arrive;
    // that is reported once on stderr.
    std::vector<LensLayer> compute(int32_t answer);

private:
    std::string file_;  // name only, for messages
    std::vector<int32_t> layers_;
    std::vector<std::string> names_;  // "l_out-<layer>", in the order of layers_
    std::vector<std::string> warnings_;
    LensWeights w_;
    int n_threads_ = 1;

    std::atomic<bool> armed_{false};
    std::vector<float> rows_;  // captured rows, layers x n_embd
    std::vector<char> got_;    // per layer: captured in the last armed decode
    std::vector<uint8_t> raw_;  // a row of another type than f32, before converting
    bool warned_missing_ = false;

    std::vector<float> scratch_;
    double compute_ms_ = 0;
    uint64_t computed_ = 0;
};

}  // namespace ils
