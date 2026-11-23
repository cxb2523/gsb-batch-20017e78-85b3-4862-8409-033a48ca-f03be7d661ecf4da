// The logit lens without llama.cpp: which
// layers to project, and the arithmetic of one step. A captured layer output
// goes through the final norm and the output matrix, all on the CPU, in one
// pass over the matrix for every layer at once. llama_lens.h reads the
// weights from the GGUF and captures the layers.
#pragma once

#include "frames.h"

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

namespace ils {

constexpr int LENS_DEFAULT_LAYERS = 8;  // spread evenly when --lens-layers is not given
constexpr int LENS_MAX_LAYERS = 16;     // most layers --lens-layers may ask for

// LENS_DEFAULT_LAYERS layers spread evenly, lround(i * (n_layer - 1) / 7),
// without duplicates: the first and the last layer always; every layer when
// there are fewer. Empty if n_layer <= 0.
std::vector<int32_t> default_lens_layers(int32_t n_layer);

// The layers of --lens-layers ("0,3,7"): integers separated by commas,
// returned ascending and without duplicates. Throws std::invalid_argument
// with a message for the user if the list is empty or malformed, if a layer
// is outside [0, n_layer - 1], or if it has more than LENS_MAX_LAYERS layers.
std::vector<int32_t> parse_lens_layers(const std::string& text, int32_t n_layer);

// "0,3,7", for logs.
std::string lens_layers_text(const std::vector<int32_t>& layers);

// Runs fn(begin, end) over [0, n) in chunks of `chunk` items, on up to
// `n_threads` threads (the calling one included) that take the next chunk as
// they finish the last: the cores of a hybrid CPU are not equally fast. `fn`
// must not throw.
void parallel_chunks(int64_t n, int64_t chunk, int n_threads, const std::function<void(int64_t, int64_t)>& fn);

// y = x / sqrt(mean(x^2) + eps) * weight, accumulating in double like ggml.
void rms_norm(const float* x, const float* weight, float* y, int n, float eps);

// out[i * n_rows + r] = matrix[r] . x[i] for the k vectors of x (n_embd
// each), in one pass over the row-major n_rows x n_embd matrix: each row is
// read once and multiplied by every vector. Rows are split among n_threads.
void lens_project(const float* matrix, int64_t n_rows, int n_embd, const float* x, int k, float* out, int n_threads);

// What one layer says, from its n logits `z`: the most likely token and its
// probability, the probability of `answer` (0 if out of range) and the
// entropy in bits, with a stable log-sum-exp. With softcap > 0 the logits are
// first replaced in place by softcap * tanh(z / softcap) (Gemma 4).
LensLayer lens_stats(float* z, int64_t n, float softcap, int32_t answer);

// What the lens needs from a model: the final norm and the output matrix,
// dequantized to f32.
struct LensWeights {
    int n_embd = 0;
    int64_t n_rows = 0;         // rows of the matrix: the vocabulary
    std::vector<float> norm;    // n_embd
    std::vector<float> matrix;  // n_rows x n_embd, row-major
    float eps = 1e-6f;          // of the RMS norm
    float softcap = 0;          // 0: none
};

// One step: `rows` holds k captured layer outputs of n_embd values, in the
// order of the layers. Each is normalized, all are projected in one pass, and
// each gives a LensLayer, `answer` being the model's most likely token.
// `scratch` is reused from step to step.
std::vector<LensLayer> lens_compute(const LensWeights& w, const float* rows, int k, int32_t answer, int n_threads,
                                    std::vector<float>& scratch);

}  // namespace ils
