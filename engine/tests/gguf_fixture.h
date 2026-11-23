// Small GGUF files with metadata only (no tensors), for the catalog and hub
// tests and the fake engine's models folder. They cannot be loaded by
// llama.cpp; the catalog only reads their headers.
#pragma once

#include <gguf.h>

#include <cstdint>
#include <filesystem>
#include <stdexcept>
#include <string>
#include <vector>

namespace ils {

struct FixtureGguf {
    std::string arch = "llama";
    std::string name = "Fixture";       // general.name; empty: not written
    std::string size_label = "1B";      // general.size_label; empty: not written
    int32_t file_type = 7;              // general.file_type (7: Q8_0); < 0: not written
    uint32_t n_layer = 4;               // <arch>.block_count
    std::vector<uint32_t> head_count_kv{2};  // one value: scalar; more: one per layer
    uint32_t n_head = 8;                // <arch>.attention.head_count
    uint32_t n_embd = 256;              // <arch>.embedding_length
    uint32_t key_length = 0;            // 0: not written (the reader falls back to n_embd / n_head)
    uint32_t value_length = 0;
    std::string tok_model = "gpt2";     // tokenizer.ggml.model
    std::string tok_pre = "default";    // tokenizer.ggml.pre
    std::vector<std::string> tokens{"<s>", "</s>", "a", "b", "c"};
    std::vector<int32_t> token_type;    // empty: all 1 (normal)
    uint32_t bos = 0;
    uint32_t eos = 1;
};

inline void write_fixture_gguf(const std::filesystem::path& path, const FixtureGguf& f) {
    gguf_context* ctx = gguf_init_empty();
    const std::string a = f.arch;
    gguf_set_val_str(ctx, "general.architecture", a.c_str());
    if (!f.name.empty()) gguf_set_val_str(ctx, "general.name", f.name.c_str());
    if (!f.size_label.empty()) gguf_set_val_str(ctx, "general.size_label", f.size_label.c_str());
    if (f.file_type >= 0) gguf_set_val_u32(ctx, "general.file_type", static_cast<uint32_t>(f.file_type));
    gguf_set_val_u32(ctx, (a + ".block_count").c_str(), f.n_layer);
    gguf_set_val_u32(ctx, (a + ".embedding_length").c_str(), f.n_embd);
    gguf_set_val_u32(ctx, (a + ".attention.head_count").c_str(), f.n_head);
    if (f.head_count_kv.size() == 1) {
        gguf_set_val_u32(ctx, (a + ".attention.head_count_kv").c_str(), f.head_count_kv[0]);
    } else if (!f.head_count_kv.empty()) {
        gguf_set_arr_data(ctx, (a + ".attention.head_count_kv").c_str(), GGUF_TYPE_UINT32, f.head_count_kv.data(),
                          f.head_count_kv.size());
    }
    if (f.key_length) gguf_set_val_u32(ctx, (a + ".attention.key_length").c_str(), f.key_length);
    if (f.value_length) gguf_set_val_u32(ctx, (a + ".attention.value_length").c_str(), f.value_length);
    gguf_set_val_str(ctx, "tokenizer.ggml.model", f.tok_model.c_str());
    gguf_set_val_str(ctx, "tokenizer.ggml.pre", f.tok_pre.c_str());
    std::vector<const char*> toks;
    for (const auto& t : f.tokens) toks.push_back(t.c_str());
    gguf_set_arr_str(ctx, "tokenizer.ggml.tokens", toks.data(), toks.size());
    std::vector<int32_t> types = f.token_type;
    if (types.empty()) types.assign(f.tokens.size(), 1);
    gguf_set_arr_data(ctx, "tokenizer.ggml.token_type", GGUF_TYPE_INT32, types.data(), types.size());
    gguf_set_val_u32(ctx, "tokenizer.ggml.bos_token_id", f.bos);
    gguf_set_val_u32(ctx, "tokenizer.ggml.eos_token_id", f.eos);
    const bool ok = gguf_write_to_file(ctx, path.string().c_str(), /*only_meta=*/false);
    gguf_free(ctx);
    if (!ok) throw std::runtime_error("cannot write " + path.string());
}

}  // namespace ils
