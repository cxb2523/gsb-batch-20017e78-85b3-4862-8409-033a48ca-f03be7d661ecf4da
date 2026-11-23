// The models folder (--models-dir): the GGUF files in it, read from their
// headers without loading them, for the `models` event. Only
// ggml's gguf reader, no llama.cpp: tests and the fake engine use it too.
#pragma once

#include <cstdint>
#include <filesystem>
#include <map>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

namespace ils {

// One file of the folder, as the `models` event lists it.
struct CatalogEntry {
    std::string file;  // name in the folder
    uint64_t size = 0;
    int64_t mtime = 0;       // last write time, in the clock's own units; for the cache
    std::string name;        // general.name, or the file name without .gguf
    std::string arch;        // general.architecture
    std::string size_label;  // general.size_label, may be empty
    std::string quant;       // general.file_type as llama.cpp names it ("Q8_0"), may be empty
    int32_t n_layer = 0;     // <arch>.block_count minus <arch>.nextn_predict_layers, as llama_model_n_layer
    uint32_t n_vocab = 0;    // entries of tokenizer.ggml.tokens
    std::string tok;         // tokenizer fingerprint, 16 lowercase hex digits
    uint64_t vram = 0;       // estimate_vram() at the catalog's n_ctx
    std::string error;       // non-empty: the header could not be read; the rest is empty
};

// True for a plain GGUF file name: no directory separators, no "..", ends in
// ".gguf", and is not a part of a split GGUF ("-00001-of-00003.gguf").
bool is_plain_gguf_name(const std::string& name);

// The header of one GGUF (gguf_init_from_file with no_alloc: metadata only).
// Fills every field but `file`, `size` and `mtime`. Never throws: a file
// that cannot be read comes back with `error` set.
CatalogEntry read_gguf_header(const std::filesystem::path& path, int n_ctx);

// Tokenizer fingerprint: FNV-1a 64 over tokenizer.ggml.model,
// tokenizer.ggml.pre, every token's text and type, and the special token ids
// that change tokenizing or the end of generation (bos, eos, eot, eom; not
// pad, unk or sep: Qwen3.5 GGUFs of different quantizers differ only in
// their pad id). Same fingerprint: the session will accept the pair
// (tokenizer_difference() still has the last word).
// Bytes of the GPU a model takes at `n_ctx`: the weights (`file_size`; read_gguf_header
// passes the file size less the input tensors llama.cpp keeps in RAM:
// per_layer_token_embd, and token_embd when there is a separate output matrix),
// the KV cache (n_ctx × Σ over layers of head_count_kv × (key_length +
// value_length) × 2 bytes, f16; a per-layer head_count_kv of 0 is a layer
// without attention) and a fixed margin for the compute buffers.
// Both are computed inside read_gguf_header; declared here for the tests.
struct KvShape {
    std::vector<uint32_t> head_count_kv;  // one per layer
    uint32_t key_length = 0;
    uint32_t value_length = 0;
};
uint64_t estimate_vram(uint64_t file_size, const KvShape& kv, int n_ctx);

class Catalog {
public:
    // `dir` is created if it does not exist. `n_ctx` is the engine's, for vram.
    Catalog(std::filesystem::path dir, int n_ctx);

    // Lists the folder again. Headers are cached by (file, size, mtime), so
    // a scan only reads new or changed files. Sorted by file name. Thread-safe.
    std::vector<CatalogEntry> scan();

    // The full path of `file` if it is a plain GGUF name that exists in the
    // folder; nullopt otherwise (never a path outside the folder).
    std::optional<std::filesystem::path> resolve(const std::string& file) const;

    const std::filesystem::path& dir() const { return dir_; }
    int n_ctx() const { return n_ctx_; }

private:
    std::filesystem::path dir_;
    int n_ctx_;
    mutable std::mutex mu_;
    std::map<std::string, CatalogEntry> cache_;  // by file name
};

}  // namespace ils
