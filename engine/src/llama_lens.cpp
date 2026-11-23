// The logit lens on top of llama.cpp (llama_lens.h). Signatures from
// third_party/llama.cpp (gguf.h, ggml.h, ggml-backend.h), v0.9.0.
#include "llama_lens.h"

#include "ggml-backend.h"
#include "ggml.h"
#include "gguf.h"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <memory>
#include <stdexcept>

namespace ils {
namespace {

using Clock = std::chrono::steady_clock;

double ms_since(Clock::time_point t0) { return std::chrono::duration<double, std::milli>(Clock::now() - t0).count(); }

struct GgufFree {
    void operator()(gguf_context* g) const { gguf_free(g); }
};
struct FileClose {
    void operator()(std::FILE* f) const { std::fclose(f); }
};

// A float metadata value, or `fallback` if the key is missing. Throws if the
// key holds another type.
float meta_f32(const gguf_context* g, const std::string& key, float fallback, bool required) {
    const int64_t id = gguf_find_key(g, key.c_str());
    if (id < 0) {
        if (required) throw std::runtime_error("the GGUF has no " + key);
        return fallback;
    }
    if (gguf_get_kv_type(g, id) != GGUF_TYPE_FLOAT32) throw std::runtime_error(key + " is not a float in the GGUF");
    return gguf_get_val_f32(g, id);
}

}  // namespace

LlamaLens::LlamaLens(const std::string& path, int n_embd, int n_vocab, std::vector<int32_t> layers, int n_threads)
    : file_(std::filesystem::path(path).filename().string()), layers_(std::move(layers)), n_threads_(std::max(n_threads, 1)) {
    const auto t0 = Clock::now();
    auto fail = [&](const std::string& what) { return std::runtime_error("logit lens: " + file_ + ": " + what); };

    gguf_init_params gp = {/*no_alloc=*/true, /*ctx=*/nullptr};
    std::unique_ptr<gguf_context, GgufFree> g(gguf_init_from_file(path.c_str(), gp));
    if (!g) throw fail("cannot read the GGUF");

    const int64_t k_arch = gguf_find_key(g.get(), "general.architecture");
    if (k_arch < 0 || gguf_get_kv_type(g.get(), k_arch) != GGUF_TYPE_STRING) throw fail("no general.architecture");
    const std::string arch = gguf_get_val_str(g.get(), k_arch);
    try {
        w_.eps = meta_f32(g.get(), arch + ".attention.layer_norm_rms_epsilon", 0, true);
        // Gemma 4 caps its logits after the matrix; the lens does the same.
        if (arch == "gemma4") w_.softcap = meta_f32(g.get(), "gemma4.final_logit_softcapping", 30.0f, false);
    } catch (const std::runtime_error& e) {
        throw fail(e.what());
    }

    // Cases the lens does not reproduce.
    if (gguf_find_tensor(g.get(), "output.scale") >= 0)
        warnings_.push_back("logit lens: " + file_ + " has an output.scale tensor, which the lens does not apply; "
                            "its numbers may be off");
    for (int64_t i = 0; i < gguf_get_n_kv(g.get()); ++i) {
        if (std::strncmp(gguf_get_key(g.get(), i), "prism.hadamard.", 15) == 0) {
            warnings_.push_back("logit lens: " + file_ + " has prism.hadamard metadata (an extra rotation the lens "
                                "does not reproduce); its numbers may be off");
            break;
        }
    }

    std::unique_ptr<std::FILE, FileClose> f(std::fopen(path.c_str(), "rb"));
    if (!f) throw fail("cannot open the file");
    std::vector<uint8_t> raw;
    auto read_tensor = [&](int64_t id) {
        raw.resize(gguf_get_tensor_size(g.get(), id));
        const size_t off = gguf_get_data_offset(g.get()) + gguf_get_tensor_offset(g.get(), id);
#ifdef _WIN32
        const int sought = _fseeki64(f.get(), static_cast<__int64>(off), SEEK_SET);  // long is 32-bit there
#else
        const int sought = fseeko(f.get(), static_cast<off_t>(off), SEEK_SET);
#endif
        if (sought != 0 || std::fread(raw.data(), 1, raw.size(), f.get()) != raw.size())
            throw fail(std::string("cannot read ") + gguf_get_tensor_name(g.get(), id));
    };
    // How to turn rows of a tensor's type into f32.
    auto converter = [&](int64_t id) -> ggml_to_float_t {
        const ggml_type type = gguf_get_tensor_type(g.get(), id);
        if (type == GGML_TYPE_F32) return nullptr;
        const ggml_to_float_t to_float = ggml_get_type_traits(type)->to_float;
        if (!to_float)
            throw fail(std::string("cannot convert ") + gguf_get_tensor_name(g.get(), id) + " of type " + ggml_type_name(type));
        return to_float;
    };

    // The final norm.
    const int64_t id_norm = gguf_find_tensor(g.get(), "output_norm.weight");
    if (id_norm < 0) throw fail("the GGUF has no output_norm.weight");
    if (gguf_get_tensor_ne(g.get(), id_norm)[0] != n_embd) throw fail("output_norm.weight does not match the model's n_embd");
    read_tensor(id_norm);
    w_.n_embd = n_embd;
    w_.norm.resize(static_cast<size_t>(n_embd));
    if (const ggml_to_float_t to_float = converter(id_norm)) to_float(raw.data(), w_.norm.data(), n_embd);
    else std::memcpy(w_.norm.data(), raw.data(), static_cast<size_t>(n_embd) * sizeof(float));

    // The output matrix: its own, or the token embeddings when tied.
    int64_t id_w = gguf_find_tensor(g.get(), "output.weight");
    if (id_w < 0) id_w = gguf_find_tensor(g.get(), "token_embd.weight");
    if (id_w < 0) throw fail("the GGUF has neither output.weight nor token_embd.weight");
    const std::string w_name = gguf_get_tensor_name(g.get(), id_w);
    const ggml_type w_type = gguf_get_tensor_type(g.get(), id_w);
    const int64_t* ne = gguf_get_tensor_ne(g.get(), id_w);
    if (ne[0] != n_embd || ne[2] != 1 || ne[3] != 1) throw fail(w_name + " does not match the model's n_embd");
    if (ne[1] != n_vocab)
        throw fail(w_name + " has " + std::to_string(ne[1]) + " rows and the vocabulary " + std::to_string(n_vocab) +
                   " tokens");
    const ggml_to_float_t to_float = converter(id_w);
    read_tensor(id_w);
    w_.n_rows = ne[1];
    w_.matrix.resize(static_cast<size_t>(w_.n_rows) * n_embd);
    const size_t row_bytes = ggml_row_size(w_type, n_embd);
    parallel_chunks(w_.n_rows, 1024, n_threads_, [&](int64_t begin, int64_t end) {
        for (int64_t r = begin; r < end; ++r) {
            float* dst = w_.matrix.data() + static_cast<size_t>(r) * n_embd;
            const uint8_t* src = raw.data() + static_cast<size_t>(r) * row_bytes;
            if (to_float) to_float(src, dst, n_embd);
            else std::memcpy(dst, src, static_cast<size_t>(n_embd) * sizeof(float));
        }
    });

    for (int32_t il : layers_) names_.push_back("l_out-" + std::to_string(il));
    rows_.assign(layers_.size() * static_cast<size_t>(n_embd), 0.0f);
    got_.assign(layers_.size(), 0);

    char softcap[32] = "";
    if (w_.softcap > 0) std::snprintf(softcap, sizeof softcap, ", softcap %g", w_.softcap);
    std::fprintf(stderr,
                 "logit lens: %s: layers %s; %s (%s, %lld x %d) as f32, %.0f MiB, read in %.1f s; eps %g%s; %d threads\n",
                 file_.c_str(), lens_layers_text(layers_).c_str(), w_name.c_str(), ggml_type_name(w_type),
                 static_cast<long long>(w_.n_rows), n_embd, w_.matrix.size() * sizeof(float) / 1048576.0,
                 ms_since(t0) / 1000.0, w_.eps, softcap, n_threads_);
    for (const std::string& w : warnings_) std::fprintf(stderr, "warning: %s\n", w.c_str());
}

LlamaLens::~LlamaLens() {
    if (computed_ > 0)
        std::fprintf(stderr, "logit lens: %s: %llu steps, %.1f ms of projection per step\n", file_.c_str(),
                     static_cast<unsigned long long>(computed_), compute_ms_ / static_cast<double>(computed_));
}

void LlamaLens::arm() {
    std::fill(got_.begin(), got_.end(), 0);
    armed_.store(true, std::memory_order_relaxed);
}

bool LlamaLens::on_eval(ggml_tensor* t, bool ask) {
    // Disarmed: nothing is asked for, so the graph runs in one piece.
    if (!armed_.load(std::memory_order_relaxed)) return !ask;
    int idx = -1;
    if (std::strncmp(t->name, "l_out-", 6) == 0) {
        for (size_t i = 0; i < names_.size(); ++i) {
            if (names_[i] == t->name) {
                idx = static_cast<int>(i);
                break;
            }
        }
    }
    if (ask) return idx >= 0;
    if (idx < 0) return true;

    // The data is only valid during this call: copy the last row now.
    const ggml_backend_buffer_t buf = t->view_src ? t->view_src->buffer : t->buffer;
    if (t->ne[0] != w_.n_embd || t->ne[1] < 1 || !buf) return true;  // not what we expect: left as missing
    float* dst = rows_.data() + static_cast<size_t>(idx) * w_.n_embd;
    const size_t offset = static_cast<size_t>(t->ne[1] - 1) * t->nb[1];
    if (t->type == GGML_TYPE_F32 && t->nb[0] == sizeof(float)) {
        ggml_backend_tensor_get(t, dst, offset, static_cast<size_t>(w_.n_embd) * sizeof(float));
    } else {
        const ggml_to_float_t to_float = ggml_get_type_traits(t->type)->to_float;
        if (!to_float || !ggml_is_contiguous(t)) return true;
        raw_.resize(ggml_row_size(t->type, w_.n_embd));
        ggml_backend_tensor_get(t, raw_.data(), offset, raw_.size());
        to_float(raw_.data(), dst, w_.n_embd);
    }
    got_[static_cast<size_t>(idx)] = 1;
    return true;
}

std::vector<LensLayer> LlamaLens::compute(int32_t answer) {
    for (size_t i = 0; i < got_.size(); ++i) {
        if (got_[i]) continue;
        if (!warned_missing_) {
            std::fprintf(stderr,
                         "warning: logit lens: %s: layer %d was not captured in a step; that EVAL goes without the "
                         "lens (reported once)\n",
                         file_.c_str(), layers_[i]);
            warned_missing_ = true;
        }
        return {};
    }
    const auto t0 = Clock::now();
    std::vector<LensLayer> out =
        lens_compute(w_, rows_.data(), static_cast<int>(layers_.size()), answer, n_threads_, scratch_);
    compute_ms_ += ms_since(t0);
    ++computed_;
    return out;
}

}  // namespace ils
